/**
 * Model tools over the `dshRepos` service: read code, history, issues, and
 * pull/merge requests, and, after the user approves each call, write them.
 *
 * - Every tool takes `repo` (URL or `host/path`); only configured hosts and
 *   repositories are reachable.
 * - Write tools ask once per call through `ctx.approval` when
 *   `tools.writes` is `ask`; without an approval service they refuse. With
 *   `off` they are not registered. The merge tool is registered only when
 *   `tools.merge` is true.
 * - A declined approval returns `{ status: 'declined' }`; a service failure
 *   throws with the failure code in brackets, e.g. `[not-found] …`.
 *
 * @module dsh-repo/tools
 */

import { z } from 'zod'
import type { DshRepoService } from './contract.ts'
import type { RepoConfig } from './config.ts'
import { RepoError } from './errors.ts'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CommitTrailer, WorkspaceChanges } from './contract.ts'
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
  readonly config: RepoConfig
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

/**
 * Build the tool definitions the configuration enables.
 * @param deps - service, configuration, and approval lookup.
 * @returns the definitions to register.
 */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { service, config } = deps
  const sign = (body: string | undefined) => withSignature(body, config.tools.signature)
  const signRequired = (body: string) => withSignature(body, config.tools.signature) ?? body

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
      schema: z.object({ repo, state: z.enum(['open', 'closed', 'merged', 'all']).optional(), sourceBranch: z.string().optional(), targetBranch: z.string().optional(), page, perPage }).strict(),
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
      description: 'Check out a repository as a writable workspace to change its code: a new directory under the current working directory, which then becomes the working directory. Edit, build, and test there with the ordinary file and shell tools; the git metadata is kept elsewhere, so do not run git commands that write (add, commit, checkout, push). Record and push the changes with repo_workspace_push. Starts from the head of `baseBranch` (default: the default branch) or from `commit`.',
      schema: z.object({
        repo,
        baseBranch: z.string().min(1).optional().describe('Branch to start from and later merge into; default: the default branch'),
        commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional().describe('Full commit id to start from, e.g. the commit a log analysis looked at'),
      }).strict(),
      run: async (args, signal, exec) => {
        const agent = requireAgent(exec, 'repo_workspace_open')
        const ref = service.resolve(args.repo)
        const parent = await workspaceParent(deps, agent, signal)
        const dir = await freeDirectory(parent, basename(ref.path))
        const info = await service.openWorkspace(`${ref.webUrl}.git`, {
          dir,
          ...args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch },
          ...args.commit === undefined ? {} : { commit: args.commit },
          signal,
        })
        const workingDirectory = deps.workingDirectory()
        const current = workingDirectory === undefined ? undefined : await workingDirectory.set(agent, info.dir, signal)
        return { ...info, workingDirectory: current ?? null, next: 'Edit files in this directory, then call repo_workspace_push with a new branch name and a commit message, then repo_mr_create.' }
      },
    }),
    define(deps, {
      name: 'repo_workspace_changes',
      description: 'Show what a workspace opened by repo_workspace_open changed since its starting commit: files with line counts, commits from earlier pushes, and the diff (cut at the configured size limit).',
      schema: z.object({ dir: z.string().min(1).optional().describe('Workspace directory or a directory inside it; default: the current working directory') }).strict(),
      run: async (args, signal, exec) => service.workspaceChanges(await workspaceRoot(deps, args.dir, exec, signal), { signal }),
    }),
  ]
  if (config.tools.writes === 'off') return reads

  const writes: ToolDefinition[] = [
    define(deps, {
      name: 'repo_workspace_push',
      description: 'Commit the uncommitted changes of a workspace opened by repo_workspace_open and push it to a new remote branch, never forcing. The commit is made as the account that owns the host token and records the id of this session, plus any trailers other plugins add. The first push names the branch, which must not exist yet and cannot be the default or starting branch; later pushes go to the same branch. Open a PR/MR afterwards with repo_mr_create (sourceBranch = the branch, targetBranch = baseBranch). Requires user approval.',
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
        return await service.pushWorkspace(root, {
          ...args.branch === undefined ? {} : { branch: args.branch },
          ...args.message === undefined ? {} : { message: args.message },
          ...session === undefined ? {} : { session },
          ...trailers.length === 0 ? {} : { trailers },
          signal,
        })
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
        zh: `在 ${args.repo} 创建${args.draft === true ? '草稿 ' : ''}PR/MR：${args.sourceBranch} → ${args.targetBranch ?? '默认分支'}，标题「${args.title}」`,
        en: `Open a ${args.draft === true ? 'draft ' : ''}PR/MR in ${args.repo}: ${args.sourceBranch} → ${args.targetBranch ?? 'default branch'}, "${args.title}"`,
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
  if (config.tools.merge) {
    writes.push(define(deps, {
      name: 'repo_mr_merge',
      description: 'Merge a pull/merge request, only while its head is still `headSha` (read it with repo_mr_status first). Requires user approval.',
      schema: z.object({ repo, number, headSha: z.string().min(40), method: z.enum(['merge', 'squash', 'rebase']).optional() }).strict(),
      describe: args => ({ zh: `合并 ${args.repo} 的 PR/MR #${args.number}（head ${args.headSha.slice(0, 12)}${args.method === undefined ? '' : `，方式 ${args.method}`}）`, en: `Merge PR/MR #${args.number} in ${args.repo} at ${args.headSha.slice(0, 12)}` }),
      run: (args, signal) => service.mergeChange(args.repo, args.number, { headSha: args.headSha, ...args.method === undefined ? {} : { method: args.method }, signal }),
    }))
  }
  return [...reads, ...writes]
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

/** Approval text of a push: target, files with line counts, and the commit message. */
function pushPrompt(changes: WorkspaceChanges, branch: string, message: string | undefined): Prompt {
  const ws = changes.workspace
  const shown = changes.files.slice(0, 20).map(file => `${file.status === 'renamed' ? `${file.previousPath ?? ''} → ` : ''}${file.path}${file.binary ? '（二进制）' : ` +${file.additions ?? 0} −${file.deletions ?? 0}`}`)
  const more = changes.files.length > shown.length ? `\n…另有 ${changes.files.length - shown.length} 个文件` : ''
  const counts = changes.files.reduce((sum, file) => ({ add: sum.add + (file.additions ?? 0), del: sum.del + (file.deletions ?? 0) }), { add: 0, del: 0 })
  const commit = changes.uncommitted && message !== undefined ? `\n提交说明：${message.split('\n', 1)[0] ?? ''}` : ''
  return {
    zh: `把 ${ws.url} 的工作区推送到分支 ${branch}（起点 ${ws.baseBranch} @ ${ws.baseCommit.slice(0, 12)}）：${changes.files.length} 个文件，+${counts.add} −${counts.del}${commit}\n${shown.join('\n')}${more}`,
    en: `Push the workspace of ${ws.url} to branch ${branch} (from ${ws.baseBranch} @ ${ws.baseCommit.slice(0, 12)}): ${changes.files.length} file(s), +${counts.add} -${counts.del}`,
  }
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
      if (spec.describe !== undefined && deps.config.tools.writes === 'ask') {
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
  if (approval === undefined) throw new Error(`[forbidden] 当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），dsh-repo 不会在未经授权时执行 ${toolName}；或把 tools.writes 设为 allow`)
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
