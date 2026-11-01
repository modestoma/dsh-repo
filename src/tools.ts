/**
 * Model tools over the `dshRepos` service: read code, history, issues, and
 * pull/merge requests, and, after the user approves each call, write them.
 *
 * - Every tool takes `repo` (URL or `host/path`); only configured hosts and
 *   repositories are reachable.
 * - Every tool is built; {@link toolOffered} decides from the current
 *   settings whether the model sees it. Write tools are offered unless
 *   `tools.writes` is `off` and ask once per call through `ctx.approval`
 *   while it is `ask`; without an approval service they refuse. The merge
 *   tool is offered only while `tools.merge` is also true.
 * - A declined approval returns `{ status: 'declined' }`; a service failure
 *   throws with the failure code in brackets, e.g. `[not-found] …`.
 *
 * @module dsh-repo/tools
 */

import { z } from 'zod'
import { pushPrompt } from './push-prompt.ts'
import type { DshRepoService } from './contract.ts'
import type { RepoSettings } from './config.ts'
import { RepoError } from './errors.ts'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ChangeInfo, CommitTrailer, WorkspaceChanges, WorkspacePushResult } from './contract.ts'
import type { Agent, ContentBlock, HostApproval, ToolDefinition, ToolRunContext, WorkingDirectoryService } from './host.ts'

/** Outcome of a write the user did not approve. */
export interface Declined {
  readonly status: 'declined'
  /** `rejected`, `cancelled`, or `unavailable` (no answerer). */
  readonly outcome: string
}

/** Collaborators of the tool set. */
export interface ToolDeps {
  readonly service: DshRepoService
  /** Tool settings now in effect, read on every call. */
  readonly settings: () => RepoSettings['tools']
  /** DSH's approval service, looked up per call. */
  readonly approval: () => HostApproval | undefined
  /** DSH's working-directory service, looked up per call; absent in compositions without it. */
  readonly workingDirectory: () => WorkingDirectoryService | undefined
  /**
   * Trailers other plugins add to a push made for a Session (the
   * `repo/commit-trailers` event); absent means none.
   */
  readonly commitTrailers?: (request: { readonly session: string; readonly dir: string }) => Promise<readonly CommitTrailer[]>
}

const repo = z.string().min(1).describe('Repository: web or clone URL (https://github.com/owner/name, git@gitlab.example.com:group/project.git) or host/path')
const number = z.number().int().min(1).describe('Issue or PR/MR number as shown in the web UI (GitLab IID)')
const page = z.number().int().min(1).optional().describe('1-based page, default 1')
const perPage = z.number().int().min(1).max(100).optional().describe('Items per page')
const labels = z.array(z.string().min(1)).optional()
const assignees = z.array(z.string().min(1)).optional().describe('Usernames')

/** Approval prompt text. */
interface Prompt { readonly zh: string; readonly en: string }

interface Spec<S extends z.ZodType, V> {
  readonly name: string
  readonly description: string
  readonly schema: S
  /** Present on write tools: what the approval prompt says will happen. */
  readonly describe?: (args: z.output<S>, exec: ToolRunContext) => Prompt | Promise<Prompt>
  readonly run: (args: z.output<S>, signal: AbortSignal, exec: ToolRunContext) => Promise<V>
}

function render(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function withSignature(body: string | undefined, signature: string): string | undefined {
  if (body === undefined || signature === '') return body
  return `${body}\n\n${signature}`
}

/** Which settings offer a tool: reads always, writes unless `writes` is `off`, merge also needs `merge`. */
export type ToolAccess = 'read' | 'write' | 'merge'

/** One built tool and the settings that offer it. */
export interface RepoTool {
  readonly definition: ToolDefinition
  readonly access: ToolAccess
}

/**
 * Whether the tool settings offer a tool to the model.
 * @param access - the tool's access class.
 * @param settings - tool settings now in effect.
 * @returns whether the model sees the tool.
 */
export function toolOffered(access: ToolAccess, settings: RepoSettings['tools']): boolean {
  if (!settings.enabled) return false
  if (access === 'read') return true
  if (settings.writes === 'off') return false
  return access === 'write' || settings.merge
}

/**
 * Build every tool definition with its access class.
 * @param deps - service, settings, and approval lookup.
 * @returns the tools to register, each offered while {@link toolOffered} holds.
 */
export function createTools(deps: ToolDeps): RepoTool[] {
  const { service } = deps
  const sign = (body: string | undefined) => withSignature(body, deps.settings().signature)
  const signRequired = (body: string) => withSignature(body, deps.settings().signature) ?? body

  const reads: ToolDefinition[] = [
    define(deps, {
      name: 'repo_info',
      description: 'Show a repository\'s default branch, visibility, description, and clone URL on GitHub or GitLab.',
      schema: z.object({ repo }).strict(),
      run: (args, signal) => service.repoInfo(args.repo, { signal }),
    }),
    define(deps, {
      name: 'repo_list_branches',
      description: 'List branches with their head commit and protection.',
      schema: z.object({ repo, search: z.string().optional().describe('Substring of the branch name'), page, perPage }).strict(),
      run: (args, signal) => service.listBranches(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_list_commits',
      description: 'List commits newest first, optionally on a branch/tag/SHA and touching a path.',
      schema: z.object({ repo, ref: z.string().optional(), path: z.string().optional(), page, perPage }).strict(),
      run: (args, signal) => service.listCommits(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_list_tree',
      description: 'List files and directories under a path at a ref (default: repository root on the default branch).',
      schema: z.object({ repo, path: z.string().optional(), ref: z.string().optional(), recursive: z.boolean().optional() }).strict(),
      run: (args, signal) => service.listTree(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_read_file',
      description: 'Read one text file at a ref (default: the default branch). Long files are cut at the configured size limit.',
      schema: z.object({ repo, path: z.string().min(1), ref: z.string().optional() }).strict(),
      run: (args, signal) => service.readFile(args.repo, args.path, { ...args.ref === undefined ? {} : { ref: args.ref }, signal }),
    }),
    define(deps, {
      name: 'repo_issue_list',
      description: 'List issues (pull/merge requests excluded).',
      schema: z.object({ repo, state: z.enum(['open', 'closed', 'all']).optional(), labels, assignee: z.string().optional(), page, perPage }).strict(),
      run: (args, signal) => service.listIssues(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_issue_get',
      description: 'Read one issue with its comments.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.getIssue(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_mr_list',
      description: 'List pull requests (GitHub) or merge requests (GitLab).',
      schema: z.object({ repo, state: z.enum(['open', 'closed', 'merged', 'all']).optional(), sourceBranch: z.string().optional().describe('Branch of this repository the PRs/MRs come from; ones from forks are left out'), targetBranch: z.string().optional(), page, perPage }).strict(),
      run: (args, signal) => service.listChanges(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_mr_get',
      description: 'Read one pull/merge request with its conversation comments.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.getChange(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_mr_diff',
      description: 'Read the unified diff of a pull/merge request. Long diffs are cut at the configured size limit.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.changeDiff(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_mr_status',
      description: 'Read CI checks/pipeline and mergeability of a pull/merge request, with its head SHA.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.changeStatus(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_workspace_open',
      description: 'Check out a repository as a writable workspace to change its code: a new directory under the current working directory, which then becomes the working directory. Edit, build, and test there with the ordinary file and shell tools; the git metadata is kept elsewhere, so do not run git commands that write (add, commit, checkout, push). Record and push the changes with repo_workspace_push. Starts from the head of `baseBranch` (default: the default branch) or from `commit`, for work that goes to a new branch. To change work that was already pushed, such as follow-up fixes to an open PR/MR, do not open a workspace on top of its branch: keep editing the workspace that pushed it and push again, or, when that workspace is gone, pass the branch as `branch` to continue it.',
      schema: z.object({
        repo,
        baseBranch: z.string().min(1).optional().describe('Branch the work merges into, and starts from unless `branch` is given; default: the default branch. Never the source branch of an open PR/MR'),
        commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional().describe('Full commit id to start from, e.g. the commit a log analysis looked at'),
        branch: z.string().min(1).optional().describe('Existing remote branch to continue, e.g. the source branch of an open PR/MR to update: the workspace starts from its head and every push adds commits to it. When the current workspace already pushes to this branch, it is reused'),
      }).strict(),
      run: async (args, signal, exec) => {
        const agent = requireAgent(exec, 'repo_workspace_open')
        const ref = service.resolve(args.repo)
        const url = `${ref.webUrl}.git`
        if (args.branch !== undefined) {
          if (args.commit !== undefined) throw new RepoError('invalid', `接着分支 ${args.branch} 修改时从它的最新提交开始，不能再指定 commit`)
          const reused = await currentWorkspace(deps, agent, url, args.branch, args.baseBranch, signal)
          if (reused !== undefined) return { ...reused, reused: true, next: continueHint(reused.branch) }
        } else if (args.baseBranch !== undefined) {
          const change = (await openChangesFrom(service, args.repo, args.baseBranch, signal))[0]
          if (change !== undefined) {
            throw new RepoError('invalid', `${args.baseBranch} 是打开中的 PR/MR #${change.number} 的源分支，不要在它上面再开分支。要更新这个 PR/MR：在推送它的工作区继续修改后再次调用 repo_workspace_push（不传 branch）；那个工作区不在了时，用 repo_workspace_open 的 branch: ${args.baseBranch} 接着它修改`)
          }
        }
        const parent = await workspaceParent(deps, agent, signal)
        const dir = await freeDirectory(parent, basename(ref.path))
        const info = await service.openWorkspace(url, {
          dir,
          ...args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch },
          ...args.commit === undefined ? {} : { commit: args.commit },
          ...args.branch === undefined ? {} : { branch: args.branch },
          signal,
        })
        const workingDirectory = deps.workingDirectory()
        const current = workingDirectory === undefined ? undefined : await workingDirectory.set(agent, info.dir, signal)
        return {
          ...info,
          workingDirectory: current ?? null,
          next: info.branch === undefined
            ? 'Edit files in this directory, then call repo_workspace_push with a new branch name and a commit message, then repo_mr_create. For later changes to the same work, keep editing this directory and call repo_workspace_push again without branch; the PR/MR updates by itself.'
            : continueHint(info.branch),
        }
      },
    }),
    define(deps, {
      name: 'repo_workspace_changes',
      description: 'Show what a workspace opened by repo_workspace_open changed since its starting commit: files with line counts, commits from earlier pushes, and the diff (cut at the configured size limit).',
      schema: z.object({ dir: z.string().min(1).optional().describe('Workspace directory or a directory inside it; default: the current working directory') }).strict(),
      run: async (args, signal, exec) => service.workspaceChanges(await workspaceRoot(deps, args.dir, exec, signal), { signal }),
    }),
  ]
  const writes: ToolDefinition[] = [
    define(deps, {
      name: 'repo_workspace_push',
      description: 'Commit the uncommitted changes of a workspace opened by repo_workspace_open and push it to its remote branch, never forcing. The commit is made as the account that owns the host token and records the id of this session, plus any trailers other plugins add. The first push of a new piece of work names a new branch, which must not exist yet and cannot be the default or starting branch; later pushes, and pushes of a workspace opened with `branch`, add commits to the same branch: omit `branch` then. A PR/MR from the branch updates by itself; the result lists the open ones. Open a PR/MR only when none is listed, with repo_mr_create (sourceBranch = the branch, targetBranch = baseBranch). Requires user approval.',
      schema: z.object({
        dir: z.string().min(1).optional().describe('Workspace directory or a directory inside it; default: the current working directory'),
        branch: z.string().min(1).optional().describe('New remote branch, e.g. fix/order-timeout; required on the first push'),
        message: z.string().min(1).optional().describe('Commit message for the uncommitted changes; required when there are any'),
      }).strict(),
      describe: async (args, exec) => {
        const changes = await service.workspaceChanges(await workspaceRoot(deps, args.dir, exec, exec.signal), { signal: exec.signal })
        return pushPrompt(changes, args.branch ?? changes.workspace.branch ?? '', args.message)
      },
      run: async (args, signal, exec) => {
        const root = await workspaceRoot(deps, args.dir, exec, signal)
        const session = exec.agent?.session?.header.id
        const trailers = session === undefined || deps.commitTrailers === undefined ? [] : await deps.commitTrailers({ session, dir: root })
        const pushed = await service.pushWorkspace(root, {
          ...args.branch === undefined ? {} : { branch: args.branch },
          ...args.message === undefined ? {} : { message: args.message },
          ...session === undefined ? {} : { session },
          ...trailers.length === 0 ? {} : { trailers },
          signal,
        })
        return { ...pushed, ...await openChangesOf(service, pushed, signal) }
      },
    }),
    define(deps, {
      name: 'repo_issue_create',
      description: 'Create an issue. Requires user approval.',
      schema: z.object({ repo, title: z.string().min(1), body: z.string().optional(), labels, assignees }).strict(),
      describe: args => ({ zh: `在 ${args.repo} 创建 issue：${args.title}`, en: `Create an issue in ${args.repo}: ${args.title}` }),
      run: (args, signal) => service.createIssue(args.repo, { ...args, ...args.body === undefined ? {} : { body: sign(args.body) }, signal }),
    }),
    define(deps, {
      name: 'repo_issue_update',
      description: 'Change an issue\'s title, body, labels, or assignees, or close/reopen it. Labels and assignees replace the current ones. Requires user approval.',
      schema: z.object({ repo, number, title: z.string().min(1).optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), labels, assignees }).strict(),
      describe: args => ({ zh: `修改 ${args.repo} 的 issue #${args.number}${args.state === 'closed' ? '（关闭）' : args.state === 'open' ? '（重新打开）' : ''}`, en: `Update issue #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.updateIssue(args.repo, args.number, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_issue_comment',
      description: 'Comment on an issue. Requires user approval.',
      schema: z.object({ repo, number, body: z.string().min(1) }).strict(),
      describe: args => ({ zh: `评论 ${args.repo} 的 issue #${args.number}`, en: `Comment on issue #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.commentIssue(args.repo, args.number, signRequired(args.body), { signal }),
    }),
    define(deps, {
      name: 'repo_mr_create',
      description: 'Open a pull request (GitHub) or merge request (GitLab) from a pushed branch. Requires user approval.',
      schema: z.object({ repo, title: z.string().min(1), body: z.string().optional(), sourceBranch: z.string().min(1), targetBranch: z.string().optional(), draft: z.boolean().optional(), labels, assignees }).strict(),
      describe: args => ({
        zh: `创建${args.draft === true ? '草稿 ' : ''}PR/MR\n仓库：${args.repo}\n分支：${args.sourceBranch} → ${args.targetBranch ?? '默认分支'}\n标题：${args.title}`,
        en: `Open a ${args.draft === true ? 'draft ' : ''}PR/MR\nRepository: ${args.repo}\nBranches: ${args.sourceBranch} → ${args.targetBranch ?? 'default branch'}\nTitle: ${args.title}`,
      }),
      run: (args, signal) => service.createChange(args.repo, { ...args, ...args.body === undefined ? {} : { body: sign(args.body) }, signal }),
    }),
    define(deps, {
      name: 'repo_mr_update',
      description: 'Change a pull/merge request\'s title, body, target branch, labels, or assignees, or close/reopen it. Requires user approval.',
      schema: z.object({ repo, number, title: z.string().min(1).optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), targetBranch: z.string().optional(), labels, assignees }).strict(),
      describe: args => ({ zh: `修改 ${args.repo} 的 PR/MR #${args.number}${args.state === 'closed' ? '（关闭）' : args.state === 'open' ? '（重新打开）' : ''}`, en: `Update PR/MR #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.updateChange(args.repo, args.number, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_mr_comment',
      description: 'Comment on a pull/merge request conversation. Requires user approval.',
      schema: z.object({ repo, number, body: z.string().min(1) }).strict(),
      describe: args => ({ zh: `评论 ${args.repo} 的 PR/MR #${args.number}`, en: `Comment on PR/MR #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.commentChange(args.repo, args.number, signRequired(args.body), { signal }),
    }),
  ]
  const merge = define(deps, {
    name: 'repo_mr_merge',
    description: 'Merge a pull/merge request, only while its head is still `headSha` (read it with repo_mr_status first). Requires user approval.',
    schema: z.object({ repo, number, headSha: z.string().min(40), method: z.enum(['merge', 'squash', 'rebase']).optional() }).strict(),
    describe: (args) => {
      requireMerge(deps)
      return { zh: `合并 ${args.repo} 的 PR/MR #${args.number}（head ${args.headSha.slice(0, 12)}${args.method === undefined ? '' : `，方式 ${args.method}`}）`, en: `Merge PR/MR #${args.number} in ${args.repo} at ${args.headSha.slice(0, 12)}` }
    },
    run: (args, signal) => {
      requireMerge(deps)
      return service.mergeChange(args.repo, args.number, { headSha: args.headSha, ...args.method === undefined ? {} : { method: args.method }, signal })
    },
  })
  return [
    ...reads.map(definition => ({ definition, access: 'read' as const })),
    ...writes.map(definition => ({ definition, access: 'write' as const })),
    { definition: merge, access: 'merge' },
  ]
}

/** Guidance after opening or reusing a workspace that continues an existing branch. */
function continueHint(branch: string): string {
  return `Edit files in this directory, then call repo_workspace_push without branch: the commit is added to ${branch} and an open PR/MR from it updates by itself, so do not create another one.`
}

/**
 * The workspace containing the Agent's effective directory, when it is a
 * workspace of `url` that already pushes to `branch` and, when `baseBranch`
 * is given, merges into it.
 */
async function currentWorkspace(deps: ToolDeps, agent: Agent, url: string, branch: string, baseBranch: string | undefined, signal: AbortSignal): Promise<WorkspaceChanges['workspace'] & { readonly branch: string } | undefined> {
  const current = await currentDirectory(deps, agent, signal)
  const root = agent.session?.header.cwd
  for (let dir = current; dir !== dirname(dir) && (root === undefined || inside(dir, root)); dir = dirname(dir)) {
    if (!await isWorkspaceCheckout(dir)) continue
    const { workspace } = await deps.service.workspaceChanges(dir, { signal })
    if (workspace.url !== url || workspace.branch !== branch || (baseBranch !== undefined && workspace.baseBranch !== baseBranch)) return undefined
    return { ...workspace, branch: workspace.branch }
  }
  return undefined
}

/**
 * Open PRs/MRs from a branch of the repository, following pages: a host may
 * return a page with every entry filtered out (GitLab drops fork MRs after
 * fetching) and still have more pages.
 */
async function openChangesFrom(service: DshRepoService, repo: string, branch: string, signal: AbortSignal): Promise<readonly ChangeInfo[]> {
  const found: ChangeInfo[] = []
  for (let page: number | undefined = 1; page !== undefined;) {
    const result = await service.listChanges(repo, { state: 'open', sourceBranch: branch, page, perPage: 100, signal })
    found.push(...result.items)
    page = result.nextPage
  }
  return found
}

/** Open PRs/MRs from the pushed branch, so the model updates them instead of opening another. */
async function openChangesOf(service: DshRepoService, pushed: WorkspacePushResult, signal: AbortSignal): Promise<{ readonly openChanges?: readonly OpenChange[]; readonly next: string }> {
  let items: readonly ChangeInfo[]
  try {
    items = await openChangesFrom(service, pushed.url, pushed.branch, signal)
  } catch (error) {
    // The push already succeeded; report the failed lookup instead of failing the call.
    const reason = error instanceof Error ? error.message : String(error)
    return { next: `Pushed. Could not list the PRs/MRs from ${pushed.branch} (${reason}); check with repo_mr_list before creating one.` }
  }
  const openChanges = items.map(change => ({ number: change.number, title: change.title, targetBranch: change.targetBranch, webUrl: change.webUrl }))
  const first = openChanges[0]
  if (first === undefined) return { openChanges, next: `Open a PR/MR with repo_mr_create (sourceBranch ${pushed.branch}, targetBranch ${pushed.baseBranch}) if the work needs one.` }
  return { openChanges, next: `PR/MR #${first.number} from ${pushed.branch} now includes this push; do not create another. Use repo_mr_update to change its title or description if needed.` }
}

/** An open PR/MR from a pushed branch, as the push result lists it. */
interface OpenChange {
  readonly number: number
  readonly title: string
  readonly targetBranch: string
  readonly webUrl: string
}

function requireMerge(deps: ToolDeps): void {
  if (!deps.settings().merge) throw new RepoError('forbidden', 'dsh-repo 设置页没有开放合并，repo_mr_merge 不会执行')
}

function requireAgent(exec: ToolRunContext, toolName: string): Agent {
  if (exec.agent === undefined) throw new RepoError('invalid', `${toolName} 需要由 Agent 调用`)
  return exec.agent
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** The Agent's effective directory, or its Session's original directory without the working-directory service. */
async function currentDirectory(deps: ToolDeps, agent: Agent, signal: AbortSignal): Promise<string> {
  const current = await deps.workingDirectory()?.ensure(agent, signal) ?? agent.session?.header.cwd
  if (current === undefined) throw new RepoError('invalid', '当前会话没有工作目录')
  return current
}

/**
 * Where a new workspace goes: the effective directory when it lies inside
 * the Session's original directory (the sandbox's writable root), otherwise
 * that original directory; never inside another workspace.
 */
async function workspaceParent(deps: ToolDeps, agent: Agent, signal: AbortSignal): Promise<string> {
  const current = await currentDirectory(deps, agent, signal)
  const root = agent.session?.header.cwd
  const base = root === undefined || inside(current, root) ? current : root
  for (let dir = base; dir !== dirname(dir) && (root === undefined || inside(dirname(dir), root)); dir = dirname(dir)) {
    if (await isWorkspaceCheckout(dir)) return dirname(dir)
  }
  return base
}

/** Whether a directory looks like a workspace checkout: its `.git` file leads to a `dsh-repo/ws-` branch. */
async function isWorkspaceCheckout(dir: string): Promise<boolean> {
  try {
    const link = /^gitdir: (.+)$/m.exec(await readFile(join(dir, '.git'), 'utf8'))?.[1]
    if (link === undefined) return false
    return (await readFile(join(resolve(dir, link), 'HEAD'), 'utf8')).startsWith('ref: refs/heads/dsh-repo/ws-')
  } catch {
    // No `.git` file, a `.git` directory, or unreadable metadata: not a workspace.
    return false
  }
}

/** The first of `<parent>/<name>`, `<parent>/<name>-2`, … that does not exist. */
async function freeDirectory(parent: string, name: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const candidate = join(parent, index === 1 ? name : `${name}-${index}`)
    if (!await present(candidate)) return candidate
  }
}

/**
 * The checkout containing a directory: the nearest directory, from it
 * upwards, that has a `.git` entry. The service then checks it is a workspace.
 * @throws {RepoError} `not-found` when no such directory exists.
 */
async function workspaceRoot(deps: ToolDeps, dir: string | undefined, exec: ToolRunContext, signal: AbortSignal): Promise<string> {
  const start = dir === undefined
    ? await currentDirectory(deps, requireAgent(exec, 'repo_workspace'), signal)
    : isAbsolute(dir) || exec.agent === undefined ? resolve(dir) : resolve(await currentDirectory(deps, exec.agent, signal), dir)
  for (let candidate = start; candidate !== dirname(candidate); candidate = dirname(candidate)) {
    if (await present(join(candidate, '.git'))) return candidate
  }
  throw new RepoError('not-found', `${start} 不在 repo_workspace_open 打开的工作区内`)
}

function define<S extends z.ZodType, V>(deps: ToolDeps, spec: Spec<S, V>): ToolDefinition<V | Declined> {
  const parameters = z.toJSONSchema(spec.schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  delete parameters.$schema
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => render(value) },
    isConcurrencySafe: () => spec.describe === undefined,
    execute: async (raw: unknown, exec: ToolRunContext): Promise<V | Declined> => {
      const parsed = spec.schema.safeParse(raw)
      if (!parsed.success) throw new Error(`[invalid] ${spec.name} 参数不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
      const args = parsed.data
      const writes = spec.describe === undefined ? undefined : deps.settings().writes
      if (writes === 'off') throw new Error(`[forbidden] dsh-repo 设置页已关闭写操作，${spec.name} 不会执行`)
      if (spec.describe !== undefined && writes === 'ask') {
        let text: Prompt
        try {
          text = await spec.describe(args, exec)
        } catch (error) {
          if (error instanceof RepoError) throw new Error(`[${error.code}] ${error.message}`)
          throw error
        }
        const outcome = await approve(deps, spec.name, text, exec)
        if (outcome !== 'allowed-once') return { status: 'declined', outcome }
      }
      try {
        return await spec.run(args, exec.signal, exec)
      } catch (error) {
        if (error instanceof RepoError) throw new Error(`[${error.code}] ${error.message}`)
        throw error
      }
    },
  }
}

async function approve(deps: ToolDeps, toolName: string, text: Prompt, exec: ToolRunContext): Promise<string> {
  const approval = deps.approval()
  if (approval === undefined) throw new Error(`[forbidden] 当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），dsh-repo 不会在未经授权时执行 ${toolName}；或在 dsh-repo 设置页把写操作改为「不审批」`)
  if (exec.agent === undefined) throw new Error(`[forbidden] ${toolName} 需要由 Agent 调用`)
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    ...exec.callId === undefined ? {} : { callId: exec.callId },
    reason: text.zh,
    displayReason: { en: text.en, zh: text.zh },
    signal: exec.signal,
  })
  if (outcome === 'cancelled') exec.signal.throwIfAborted()
  return outcome
}
