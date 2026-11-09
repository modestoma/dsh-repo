/**
 * The operation registry: every model tool `repo_<object>_<action>` and its
 * `dshRepos` method `<object><Action>` are one entry here, so both take the
 * same parameter object (validated by the same schema) and run the same
 * pipeline:
 *
 * 1. validate the parameters;
 * 2. for a write made for an Agent (every tool call, and a service call with
 *    `agent`): refuse while writes are `off`, check the repository's catalog
 *    access, dispatch `access/authorize` for the Agent's Session, and while
 *    writes are `ask` show the approval card (declined → `declined`);
 * 3. run, including the steps after a write (PR/MR watching, own-comment
 *    memory, signature), so a service call behaves like the tool.
 *
 * A service write without `agent` skips step 2 except the catalog check: the
 * calling plugin answers for it.
 *
 * @module dsh-repo/operations
 */

import { z } from 'zod'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import type {
  AuthorizeLevel, CallerAgent, CommitAuthor, MrInfo, MrSummary, RepoAccess, WorkspaceInfo, WorkspacePushResult,
} from './contract.ts'
import type { RepoSettings } from './config.ts'
import { allows } from './catalog/entry.ts'
import { RepoError } from './errors.ts'
import { authorize, collectDetails } from './events.ts'
import type { ParallelDispatch } from './events.ts'
import type { Agent, HostApproval, WorkingDirectoryService } from './host.ts'
import { realPathOf, within } from './paths.ts'
import { pushPrompt } from './push-prompt.ts'
import type { RepoService } from './service.ts'
import type { WatchInfo } from './settings/contract.ts'
import type { TrackRequest } from './watch/watcher.ts'
import type { WorkspaceManager } from './workspace/manager.ts'
import { workspaceInfo } from './workspace/manager.ts'

/** Which settings offer a tool: reads and watch always, writes unless `writes` is `off`, merge too; each also needs a catalog repository with that access. `admin` (adding repositories) needs no catalog entry. The plugin offers watch only while watching is active. */
export type ToolAccess = 'read' | 'watch' | 'write' | 'merge' | 'admin'

/** The PR/MR watcher as the operations use it. */
export interface WatchHooks {
  /** @returns whether watching is on and can start a turn of a Session. */
  readonly active: boolean
  track(request: TrackRequest): Promise<WatchInfo>
  untrack(repo: string, number: number, session: string): Promise<boolean>
  ownComment(repo: string, number: number, commentId: string): Promise<void>
}

/** Collaborators every operation may use. */
export interface OperationDeps {
  readonly service: RepoService
  readonly workspaces: WorkspaceManager
  /** DSH's approval service, looked up per call. */
  readonly approval: () => HostApproval | undefined
  /** DSH's working-directory service, looked up per call; absent in compositions without it. */
  readonly workingDirectory: () => WorkingDirectoryService | undefined
  /** `ctx.parallel`; absent means no listeners. */
  readonly parallel?: ParallelDispatch
  /** PR/MR watching; absent means requests are not watched. */
  readonly watch?: WatchHooks
}

/** Who calls and how. */
export interface Caller {
  readonly origin: 'tool' | 'service'
  readonly agent?: CallerAgent
  readonly callId?: string
  readonly signal: AbortSignal
}

/** Approval text. */
export interface Prompt {
  readonly zh: string
  readonly en: string
  /** Repository whose catalog access the write needs; default: the `repo` parameter. */
  readonly repo?: string
}

/** Runs the gate of a write (authorize and approval) with its prompt. */
export type Gate = (prompt: Prompt) => Promise<void>

/** A write's gate. */
interface WriteSpec<A> {
  /** Catalog access the write needs on its repository; undefined for one outside the catalog (repoAdd). */
  readonly level: RepoAccess | undefined
  readonly authorize: AuthorizeLevel
  /** The approval text; absent when `run` calls the gate itself. */
  readonly prompt?: (args: A, deps: OperationDeps, caller: Caller) => Prompt | Promise<Prompt>
}

/** One operation. */
export interface Operation<S extends z.ZodType = z.ZodType, R = unknown> {
  readonly tool: string
  readonly method: string
  readonly description: string
  readonly schema: S
  readonly access: ToolAccess
  readonly write?: WriteSpec<z.output<S>>
  run(args: z.output<S>, deps: OperationDeps, caller: Caller, gate: Gate): Promise<R>
}

/** Outcome of a write the user did not approve, as a tool returns it. */
export interface Declined {
  readonly status: 'declined'
  /** `rejected`, `cancelled`, or `unavailable` (no answerer). */
  readonly outcome: string
}

/** The `declined` failure, carrying the approval outcome. */
export class DeclinedError extends RepoError {
  /** @param outcome - approval outcome other than `allowed-once`. */
  constructor(readonly outcome: string) {
    super('declined', `用户没有批准（${outcome}），没有执行`)
  }
}

const repo = z.string().min(1).describe('Repository: web or clone URL (https://github.com/owner/name, git@gitlab.example.com:group/project.git) or host/path')
const number = z.number().int().min(1).describe('Issue or PR/MR number as shown in the web UI (GitLab IID)')
const page = z.number().int().min(1).optional().describe('1-based page, default 1')
const perPage = z.number().int().min(1).max(100).optional().describe('Items per page')
const labels = z.array(z.string().min(1)).optional()
const assignees = z.array(z.string().min(1)).optional().describe('Usernames')
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const runId = z.number().int().min(1).describe('CI run id: GitLab pipeline id or GitHub Actions workflow run id (from repo_ci_list, or runId in repo_mr_status checks)')
const jobId = z.number().int().min(1).describe('CI job id (from repo_ci_get, or jobId in repo_mr_status checks)')
const ciTarget = z.object({ repo, runId: runId.optional(), jobId: jobId.optional() }).strict()
  .refine(args => (args.runId === undefined) !== (args.jobId === undefined), { message: 'Give exactly one of runId and jobId' })
const mrBody = z.string().optional().describe('Description for reviewers: what changed and why, how it was verified, and anything risky or left undone. Keep it short; link issues instead of restating them; never paste conversation transcripts')
const workspacePath = z.string().min(1).optional().describe('Workspace directory or a directory inside it; default: the current working directory')

/** Tool snapshot leases are released after this long, or when the same Session acquires another snapshot of the repository. */
const TOOL_LEASE_MS = 12 * 60 * 60 * 1000

function define<S extends z.ZodType, R>(operation: Operation<S, R>): Operation<S, R> {
  return operation
}

function withSignature(body: string | undefined, signature: string): string | undefined {
  if (body === undefined || signature === '') return body
  return `${body}\n\n${signature}`
}

function sessionOf(caller: Caller): string | undefined {
  return caller.agent?.session?.header.id
}

function requireAgent(caller: Caller, name: string): CallerAgent {
  if (caller.agent === undefined) throw new RepoError('invalid', `${name} 需要由 Agent 调用`)
  return caller.agent
}

function stateSuffix(state: string | undefined): string {
  return state === 'closed' ? '（关闭）' : state === 'open' ? '（重新打开）' : ''
}

/**
 * Watch a request for the calling Session while watching is active. The write
 * already succeeded, so a failure is reported in the result, not thrown.
 */
async function watchMr(deps: OperationDeps, repoTarget: string, mr: MrInfo, caller: Caller, source: TrackRequest['source'], pushed?: string): Promise<{ watching: boolean; watchError?: string }> {
  const session = sessionOf(caller)
  if (deps.watch === undefined || !deps.watch.active || session === undefined || mr.state !== 'open') return { watching: false }
  try {
    await deps.watch.track({ repo: repoTarget, change: mr, session, source, ...pushed === undefined ? {} : { pushed } })
    return { watching: true }
  } catch (error) {
    return { watching: false, watchError: error instanceof Error ? error.message : String(error) }
  }
}

/** Keep watches from reporting a comment dsh-repo posted; the comment exists, so a failure only loses that. */
async function rememberComment(deps: OperationDeps, repoTarget: string, mr: number, commentId: string): Promise<void> {
  try {
    await deps.watch?.ownComment(repoTarget, mr, commentId)
  } catch {
    // A failed store write: the watch may report this comment once; the comment itself was posted.
  }
}

/**
 * Open requests from a branch, following pages: a host may return a page with
 * every entry filtered out (GitLab drops fork MRs after fetching) and still
 * have more pages.
 */
async function openMrsFrom(service: RepoService, repoTarget: string, branch: string, signal: AbortSignal): Promise<readonly MrInfo[]> {
  const found: MrInfo[] = []
  for (let next: number | undefined = 1; next !== undefined;) {
    const result = await service.listChanges(repoTarget, { state: 'open', sourceBranch: branch, page: next, perPage: 100, signal })
    found.push(...result.items)
    next = result.nextPage
  }
  return found
}

function summary(mr: MrInfo): MrSummary {
  return { number: mr.number, title: mr.title, targetBranch: mr.targetBranch, webUrl: mr.webUrl }
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
async function currentDirectory(deps: OperationDeps, agent: CallerAgent, signal: AbortSignal): Promise<string> {
  const host = agent as Agent
  const current = await deps.workingDirectory()?.ensure(host, signal) ?? host.session?.header.cwd
  if (current === undefined) throw new RepoError('invalid', '当前会话没有工作目录')
  return current
}

/** The directory a workspace call names: `path` as given (relative to the Agent's directory for a tool), or the Agent's directory. */
async function workspaceTarget(deps: OperationDeps, path: string | undefined, caller: Caller, name: string): Promise<string> {
  if (caller.origin === 'service') {
    if (path === undefined || !isAbsolute(path)) throw new RepoError('invalid', `${name} 的 path 必须是绝对路径`)
    return path
  }
  const agent = requireAgent(caller, name)
  if (path !== undefined && isAbsolute(path)) return path
  const current = await currentDirectory(deps, agent, caller.signal)
  return path === undefined ? current : resolve(current, path)
}

/** The first of `<parent>/<name>`, `<parent>/<name>-2`, … that does not exist. */
async function freeDirectory(parent: string, name: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const candidate = join(parent, index === 1 ? name : `${name}-${index}`)
    if (!await present(candidate)) return candidate
  }
}

/** The catalog address of a repository target. */
function catalogUrl(service: RepoService, target: string, level: RepoAccess = 'read'): string {
  return service.catalog.require(target, level).url
}

/** Snapshot leases taken by tools, one per Session and repository. */
const toolLeases = new Map<string, { release(): void; timer: NodeJS.Timeout }>()

function holdForTool(key: string, release: () => void): void {
  toolLeases.get(key)?.release()
  const timer = setTimeout(() => { held.release() }, TOOL_LEASE_MS)
  timer.unref?.()
  const held = {
    timer,
    release: () => {
      clearTimeout(timer)
      if (toolLeases.get(key) === held) toolLeases.delete(key)
      release()
    },
  }
  toolLeases.set(key, held)
}

/** The configured workspace commit identity, when both fields are set. */
function configuredIdentity(settings: RepoSettings): CommitAuthor | undefined {
  const { commitName, commitEmail } = settings.workspace
  return commitName === '' || commitEmail === '' ? undefined : { name: commitName, email: commitEmail }
}

/** Every operation in tool order. */
export const OPERATIONS: readonly Operation[] = [
  define({
    tool: 'repo_list',
    method: 'repoList',
    access: 'read',
    description: 'List the repositories these tools can reach (the deployment\'s repository catalog) with the branch each follows and its access: `read` (read only, local workspaces and snapshots), `write` (also push, issues, PRs/MRs, comments, CI retry/cancel), or `merge` (also merge PRs/MRs). Every other repository is refused; an administrator adds repositories on the dsh-repo settings page.',
    schema: z.object({ feature: z.string().min(1).optional().describe('Only repositories with this feature turned on') }).strict(),
    run: async (args, { service }) => service.listRepos(args.feature === undefined ? {} : { feature: args.feature }),
  }),
  define({
    tool: 'repo_get',
    method: 'repoGet',
    access: 'read',
    description: 'Show a repository\'s default branch, visibility, description, and clone URL on GitHub or GitLab.',
    schema: z.object({ repo }).strict(),
    run: (args, { service }, caller) => service.repoInfo(args.repo, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_add',
    method: 'repoAdd',
    access: 'admin',
    description: 'Add a repository to the catalog these tools can reach, or turn features on for it, after an administrator approves. A new entry gets `read` access unless `access` asks for more; an existing entry keeps its access. Requires user approval.',
    schema: z.object({
      repo: z.string().min(1).describe('HTTPS address on a configured host'),
      branch: z.string().min(1).optional().describe('Branch the entry follows; default: the remote\'s default branch'),
      access: z.enum(['read', 'write', 'merge']).optional().describe('Access of a new entry; default read'),
      features: z.array(z.string().min(1)).optional().describe('Feature ids to turn on'),
    }).strict(),
    write: { level: undefined, authorize: 'admin' },
    run: async (args, { service }, caller, gate) => {
      caller.signal.throwIfAborted()
      return await service.addRepo(args.repo, {
        ...args.branch === undefined ? {} : { branch: args.branch },
        ...args.access === undefined ? {} : { access: args.access },
        ...args.features === undefined ? {} : { features: args.features },
      }, summaryText => gate({ zh: summaryText, en: `Change the dsh-repo repository catalog: ${args.repo}${args.access === undefined ? '' : ` (access ${args.access})`}` }))
    },
  }),
  define({
    tool: 'repo_branch_list',
    method: 'branchList',
    access: 'read',
    description: 'List branches with their head commit and protection.',
    schema: z.object({ repo, search: z.string().optional().describe('Substring of the branch name'), page, perPage }).strict(),
    run: (args, { service }, caller) => service.listBranches(args.repo, { ...args, signal: caller.signal }),
  }),
  define({
    tool: 'repo_branch_get',
    method: 'branchGet',
    access: 'read',
    description: 'Read one branch: its head commit, whether it is protected, and whether it is the default branch; null when it does not exist.',
    schema: z.object({ repo, name: z.string().min(1).describe('Branch name') }).strict(),
    run: async (args, { service }, caller) => await service.getBranch(args.repo, args.name, { signal: caller.signal }) ?? null,
  }),
  define({
    tool: 'repo_branch_delete',
    method: 'branchDelete',
    access: 'write',
    description: 'Delete a leftover branch whose work is already merged, e.g. after a PR/MR was merged on the web. Only deletes a branch whose head commit is the head of a merged PR/MR from this repository and that is not the source of an open PR/MR, the default branch, or protected; anything else is refused, so unmerged work is never lost. Find candidates with repo_mr_list (state merged). Requires user approval.',
    schema: z.object({ repo, branch: z.string().min(1).describe('Branch to delete') }).strict(),
    write: { level: 'write', authorize: 'code-write', prompt: args => ({ zh: `删除已合并的分支\n仓库：${args.repo}\n分支：${args.branch}`, en: `Delete a merged branch\nRepository: ${args.repo}\nBranch: ${args.branch}` }) },
    run: (args, { service }, caller) => service.deleteMergedBranch(args.repo, args.branch, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_commit_list',
    method: 'commitList',
    access: 'read',
    description: 'List commits newest first, optionally on a branch/tag/SHA and touching a path.',
    schema: z.object({ repo, ref: z.string().optional(), path: z.string().optional(), page, perPage }).strict(),
    run: (args, { service }, caller) => service.listCommits(args.repo, { ...args, signal: caller.signal }),
  }),
  define({
    tool: 'repo_tree_list',
    method: 'treeList',
    access: 'read',
    description: 'List files and directories under a path at a ref (default: repository root on the default branch), through the host API. For browsing a whole checkout, use repo_snapshot_acquire.',
    schema: z.object({ repo, path: z.string().optional(), ref: z.string().optional(), recursive: z.boolean().optional() }).strict(),
    run: (args, { service }, caller) => service.listTree(args.repo, { ...args, signal: caller.signal }),
  }),
  define({
    tool: 'repo_file_read',
    method: 'fileRead',
    access: 'read',
    description: 'Read one text file at a ref (default: the default branch) through the host API. Long files are cut at the configured size limit.',
    schema: z.object({ repo, path: z.string().min(1), ref: z.string().optional() }).strict(),
    run: (args, { service }, caller) => service.readFile(args.repo, args.path, { ...args.ref === undefined ? {} : { ref: args.ref }, signal: caller.signal }),
  }),
  define({
    tool: 'repo_issue_list',
    method: 'issueList',
    access: 'read',
    description: 'List issues (pull/merge requests excluded), optionally searching their title and description.',
    schema: z.object({ repo, state: z.enum(['open', 'closed', 'all']).optional(), labels, assignee: z.string().optional(), search: z.string().min(1).optional().describe('Words in the title or description'), page, perPage }).strict(),
    run: (args, { service }, caller) => service.listIssues(args.repo, { ...args, signal: caller.signal }),
  }),
  define({
    tool: 'repo_issue_get',
    method: 'issueGet',
    access: 'read',
    description: 'Read one issue with its comments.',
    schema: z.object({ repo, number }).strict(),
    run: (args, { service }, caller) => service.getIssue(args.repo, args.number, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_issue_create',
    method: 'issueCreate',
    access: 'write',
    description: 'Create an issue. Requires user approval.',
    schema: z.object({ repo, title: z.string().min(1), body: z.string().optional(), labels, assignees }).strict(),
    write: { level: 'write', authorize: 'code-write', prompt: args => ({ zh: `在 ${args.repo} 创建 issue：${args.title}`, en: `Create an issue in ${args.repo}: ${args.title}` }) },
    run: (args, { service }, caller) => service.createIssue(args.repo, { ...args, ...args.body === undefined ? {} : { body: withSignature(args.body, service.settings.tools.signature) }, signal: caller.signal }),
  }),
  define({
    tool: 'repo_issue_update',
    method: 'issueUpdate',
    access: 'write',
    description: 'Change an issue\'s title, body, labels, or assignees, or close/reopen it. Labels and assignees replace the current ones. Requires user approval.',
    schema: z.object({ repo, number, title: z.string().min(1).optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), labels, assignees }).strict(),
    write: { level: 'write', authorize: 'code-write', prompt: args => ({ zh: `修改 ${args.repo} 的 issue #${args.number}${stateSuffix(args.state)}`, en: `Update issue #${args.number} in ${args.repo}` }) },
    run: (args, { service }, caller) => service.updateIssue(args.repo, args.number, { ...args, signal: caller.signal }),
  }),
  define({
    tool: 'repo_issue_comment',
    method: 'issueComment',
    access: 'write',
    description: 'Comment on an issue. Requires user approval.',
    schema: z.object({ repo, number, body: z.string().min(1) }).strict(),
    write: { level: 'write', authorize: 'code-write', prompt: args => ({ zh: `评论 ${args.repo} 的 issue #${args.number}`, en: `Comment on issue #${args.number} in ${args.repo}` }) },
    run: async (args, deps, caller) => {
      const comment = await deps.service.commentIssue(args.repo, args.number, withSignature(args.body, deps.service.settings.tools.signature) ?? args.body, { signal: caller.signal })
      await rememberComment(deps, args.repo, args.number, comment.id)
      return comment
    },
  }),
  define({
    tool: 'repo_mr_list',
    method: 'mrList',
    access: 'read',
    description: 'List pull requests (GitHub) or merge requests (GitLab).',
    schema: z.object({ repo, state: z.enum(['open', 'closed', 'merged', 'all']).optional(), sourceBranch: z.string().optional().describe('Branch of this repository the PRs/MRs come from; ones from forks are left out'), targetBranch: z.string().optional(), page, perPage }).strict(),
    run: (args, { service }, caller) => service.listChanges(args.repo, { ...args, signal: caller.signal }),
  }),
  define({
    tool: 'repo_mr_get',
    method: 'mrGet',
    access: 'read',
    description: 'Read one pull/merge request with its conversation comments.',
    schema: z.object({ repo, number }).strict(),
    run: (args, { service }, caller) => service.getChange(args.repo, args.number, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_mr_diff',
    method: 'mrDiff',
    access: 'read',
    description: 'Read the unified diff of a pull/merge request. Long diffs are cut at the configured size limit.',
    schema: z.object({ repo, number }).strict(),
    run: (args, { service }, caller) => service.changeDiff(args.repo, args.number, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_mr_status',
    method: 'mrStatus',
    access: 'read',
    description: 'Read CI checks/pipeline and mergeability of a pull/merge request, with its head SHA.',
    schema: z.object({ repo, number }).strict(),
    run: (args, { service }, caller) => service.changeStatus(args.repo, args.number, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_mr_create',
    method: 'mrCreate',
    access: 'write',
    description: 'Open a pull request (GitHub) or merge request (GitLab) from a pushed branch. repo_workspace_push can open one in the same step. When the settings delete source branches, a GitLab MR is opened with "delete source branch" ticked, so GitLab removes the branch once it is merged. While PR/MR watching is on, its CI results, comments, reviews, and merge or close arrive in this session as messages (`watching` in the result), so do not poll it. Requires user approval.',
    schema: z.object({ repo, title: z.string().min(1), body: mrBody, sourceBranch: z.string().min(1), targetBranch: z.string().optional(), draft: z.boolean().optional(), labels, assignees }).strict(),
    write: {
      level: 'write',
      authorize: 'code-write',
      prompt: args => ({
        zh: `创建${args.draft === true ? '草稿 ' : ''}PR/MR\n仓库：${args.repo}\n分支：${args.sourceBranch} → ${args.targetBranch ?? '默认分支'}\n标题：${args.title}`,
        en: `Open a ${args.draft === true ? 'draft ' : ''}PR/MR\nRepository: ${args.repo}\nBranches: ${args.sourceBranch} → ${args.targetBranch ?? 'default branch'}\nTitle: ${args.title}`,
      }),
    },
    run: async (args, deps, caller) => {
      const { service } = deps
      const mr = await service.createChange(args.repo, {
        ...args,
        ...args.body === undefined ? {} : { body: withSignature(args.body, service.settings.tools.signature) },
        deleteSourceBranch: service.settings.tools.deleteSourceBranch,
        signal: caller.signal,
      })
      return { ...mr, ...await watchMr(deps, args.repo, mr, caller, 'created') }
    },
  }),
  define({
    tool: 'repo_mr_update',
    method: 'mrUpdate',
    access: 'write',
    description: 'Change a pull/merge request\'s title, body, target branch, labels, or assignees, or close/reopen it. A reopened PR/MR is watched again while watching is on. Requires user approval.',
    schema: z.object({ repo, number, title: z.string().min(1).optional(), body: mrBody, state: z.enum(['open', 'closed']).optional(), targetBranch: z.string().optional(), labels, assignees }).strict(),
    write: { level: 'write', authorize: 'code-write', prompt: args => ({ zh: `修改 ${args.repo} 的 PR/MR #${args.number}${stateSuffix(args.state)}`, en: `Update PR/MR #${args.number} in ${args.repo}` }) },
    run: async (args, deps, caller) => {
      const mr = await deps.service.updateChange(args.repo, args.number, { ...args, signal: caller.signal })
      return args.state === 'open' ? { ...mr, ...await watchMr(deps, args.repo, mr, caller, 'requested') } : mr
    },
  }),
  define({
    tool: 'repo_mr_comment',
    method: 'mrComment',
    access: 'write',
    description: 'Comment on a pull/merge request conversation. Requires user approval.',
    schema: z.object({ repo, number, body: z.string().min(1) }).strict(),
    write: { level: 'write', authorize: 'code-write', prompt: args => ({ zh: `评论 ${args.repo} 的 PR/MR #${args.number}`, en: `Comment on PR/MR #${args.number} in ${args.repo}` }) },
    run: async (args, deps, caller) => {
      const comment = await deps.service.commentChange(args.repo, args.number, withSignature(args.body, deps.service.settings.tools.signature) ?? args.body, { signal: caller.signal })
      await rememberComment(deps, args.repo, args.number, comment.id)
      return comment
    },
  }),
  define({
    tool: 'repo_mr_merge',
    method: 'mrMerge',
    access: 'merge',
    description: 'Merge a pull/merge request, only while its head is still `headSha` (read it with repo_mr_status first). When the settings delete source branches, its source branch is deleted too (never a fork\'s); `sourceBranch` in the result says whether it was. Requires user approval.',
    schema: z.object({ repo, number, headSha: z.string().min(40), method: z.enum(['merge', 'squash', 'rebase']).optional() }).strict(),
    write: {
      level: 'merge',
      authorize: 'code-write',
      prompt: (args, { service }) => {
        const drop = service.settings.tools.deleteSourceBranch
        return {
          zh: `合并 ${args.repo} 的 PR/MR #${args.number}（head ${args.headSha.slice(0, 12)}${args.method === undefined ? '' : `，方式 ${args.method}`}${drop ? '，合并后删除源分支' : ''}）`,
          en: `Merge PR/MR #${args.number} in ${args.repo} at ${args.headSha.slice(0, 12)}${drop ? ', then delete its source branch' : ''}`,
        }
      },
    },
    run: (args, { service }, caller) => service.mergeChange(args.repo, args.number, {
      headSha: args.headSha,
      ...args.method === undefined ? {} : { method: args.method },
      deleteSourceBranch: service.settings.tools.deleteSourceBranch,
      signal: caller.signal,
    }),
  }),
  define({
    tool: 'repo_mr_watch',
    method: 'mrWatch',
    access: 'watch',
    description: 'Watch a pull/merge request for this session, or stop watching it. While watched, CI results, comments and reviews (except ones posted through these tools), pushes by others, and merge or close arrive in this session as messages, so do not poll it. PRs/MRs opened, reopened, or pushed to through these tools are watched without this call. Watching ends on merge or close, after a long time without activity, or when stopped here.',
    schema: z.object({ repo, number, watch: z.boolean().optional().describe('false stops watching; default true') }).strict(),
    run: async (args, deps, caller) => {
      const session = requireAgent(caller, 'mrWatch').session?.header.id
      if (session === undefined) throw new RepoError('invalid', 'mrWatch 需要在会话中调用')
      if (deps.watch === undefined || !deps.watch.active) throw new RepoError('unavailable', 'PR/MR 跟踪没有开启，或当前 DSH 组合不能唤醒会话')
      if (args.watch === false) return { watching: false, stopped: await deps.watch.untrack(args.repo, args.number, session), number: args.number }
      const mr = await deps.service.getChange(args.repo, args.number, { signal: caller.signal })
      if (mr.state !== 'open') throw new RepoError('invalid', `PR/MR #${args.number} ${mr.state === 'merged' ? '已合并' : '已关闭'}，不需要跟踪`)
      const { comments: _comments, ...info } = mr
      const watched = await deps.watch.track({ repo: args.repo, change: info, session, source: 'requested' })
      return { watching: true, number: watched.number, title: watched.title, webUrl: watched.webUrl }
    },
  }),
  define({
    tool: 'repo_ci_list',
    method: 'ciList',
    access: 'read',
    description: 'List CI runs newest first: GitLab pipelines or GitHub Actions workflow runs, optionally on a branch/tag, a commit, or a PR/MR (GitLab: the MR\'s pipelines; GitHub: runs of the PR\'s current head commit). External CI that only reports commit statuses (e.g. Jenkins) is not listed; repo_mr_status shows its status and link.',
    schema: z.object({
      repo,
      ref: z.string().min(1).optional().describe('Branch or tag'),
      sha: commit.optional().describe('Full commit id'),
      number: number.optional().describe('PR/MR number; not with ref or sha'),
      state: z.enum(['pending', 'running', 'success', 'failure', 'canceled']).optional(),
      page,
      perPage,
    }).strict(),
    run: (args, { service }, caller) => service.listCiRuns(args.repo, {
      ...args.ref === undefined ? {} : { ref: args.ref },
      ...args.sha === undefined ? {} : { sha: args.sha },
      ...args.number === undefined ? {} : { change: args.number },
      ...args.state === undefined ? {} : { state: args.state },
      ...args.page === undefined ? {} : { page: args.page },
      ...args.perPage === undefined ? {} : { perPage: args.perPage },
      signal: caller.signal,
    }),
  }),
  define({
    tool: 'repo_ci_get',
    method: 'ciGet',
    access: 'read',
    description: 'Read one CI run with its jobs (stage, state, GitLab failure reason, duration, GitHub steps, GitLab child/downstream pipelines). For a failed run it also returns the failed test cases of the GitLab test report or the error annotations of the failed GitHub jobs, which often name the failing file and line. Then read a failed job\'s log with repo_ci_log.',
    schema: z.object({ repo, runId, onlyFailed: z.boolean().optional().describe('Return only failed jobs') }).strict(),
    run: (args, { service }, caller) => service.getCiRun(args.repo, args.runId, { ...args.onlyFailed === undefined ? {} : { onlyFailed: args.onlyFailed }, signal: caller.signal }),
  }),
  define({
    tool: 'repo_ci_log',
    method: 'ciLog',
    access: 'read',
    description: 'Read a CI job\'s log, cleaned of colors, progress redraws, and timestamps. By default returns the end of the log, where build and test errors usually are; with `search`, returns the matching lines with numbered context instead. Each call returns at most the configured log limit: page back with beforeLine = fromLine, narrow with `section` (titles are listed in `sections`), or search for error text such as "error", "FAILED", or a test name. GitHub serves a log only after the job finished.',
    schema: z.object({
      repo,
      jobId,
      search: z.array(z.string().min(1).max(200)).max(20).optional().describe('Return lines containing any of these texts (case-insensitive)'),
      context: z.number().int().min(0).max(50).optional().describe('Lines around each match, default 3'),
      section: z.string().min(1).max(200).optional().describe('Only lines in sections whose title contains this text, e.g. step_script (GitLab) or "Run npm test" (GitHub)'),
      beforeLine: z.number().int().min(1).optional().describe('Without search: end before this line number, to read earlier lines'),
    }).strict(),
    run: (args, { service }, caller) => service.ciJobLog(args.repo, args.jobId, {
      ...args.search === undefined ? {} : { search: args.search },
      ...args.context === undefined ? {} : { context: args.context },
      ...args.section === undefined ? {} : { section: args.section },
      ...args.beforeLine === undefined ? {} : { beforeLine: args.beforeLine },
      signal: caller.signal,
    }),
  }),
  define({
    tool: 'repo_ci_retry',
    method: 'ciRetry',
    access: 'write',
    description: 'Retry CI: with runId, the failed jobs of a run (GitLab: retries failed and canceled jobs of the pipeline; GitHub: reruns failed jobs and the jobs depending on them as a new attempt); with jobId, one job. Retry only failures that look flaky or environmental; fix code failures instead. Requires user approval.',
    schema: ciTarget,
    write: {
      level: 'write',
      authorize: 'code-write',
      prompt: args => args.runId === undefined
        ? { zh: `重试 CI 作业\n仓库：${args.repo}\n作业：${args.jobId}`, en: `Retry a CI job\nRepository: ${args.repo}\nJob: ${args.jobId}` }
        : { zh: `重试 CI 流水线的失败作业\n仓库：${args.repo}\n流水线：${args.runId}`, en: `Retry the failed jobs of a CI run\nRepository: ${args.repo}\nRun: ${args.runId}` },
    },
    run: (args, { service }, caller) => service.retryCi(args.repo, args.runId === undefined ? { jobId: args.jobId ?? 0 } : { runId: args.runId }, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_ci_cancel',
    method: 'ciCancel',
    access: 'write',
    description: 'Cancel a running CI run (runId) or, on GitLab only, one job (jobId). Requires user approval.',
    schema: ciTarget,
    write: {
      level: 'write',
      authorize: 'code-write',
      prompt: args => args.runId === undefined
        ? { zh: `取消 CI 作业\n仓库：${args.repo}\n作业：${args.jobId}`, en: `Cancel a CI job\nRepository: ${args.repo}\nJob: ${args.jobId}` }
        : { zh: `取消 CI 流水线\n仓库：${args.repo}\n流水线：${args.runId}`, en: `Cancel a CI run\nRepository: ${args.repo}\nRun: ${args.runId}` },
    },
    run: (args, { service }, caller) => service.cancelCi(args.repo, args.runId === undefined ? { jobId: args.jobId ?? 0 } : { runId: args.runId }, { signal: caller.signal }),
  }),
  define({
    tool: 'repo_snapshot_acquire',
    method: 'snapshotAcquire',
    access: 'read',
    description: 'Get a read-only local copy (plain files, no .git) of a repository at a branch, tag, or commit, fetched fresh from the remote, to search and read the whole code base with the ordinary file and shell tools. Snapshots of the same commit are shared; do not write into one. To change code, use repo_workspace_create instead.',
    schema: z.object({ repo, ref: z.string().min(1).optional().describe('Branch, tag, or full commit id; default: the branch the catalog follows, or the default branch') }).strict(),
    run: async (args, { service }, caller) => {
      const entry = service.catalog.require(args.repo, 'read')
      const branch = args.ref === undefined ? entry.branch : undefined
      const mirror = await service.syncMirror(entry.url, { ...branch === undefined ? {} : { branch }, signal: caller.signal })
      const target = args.ref === undefined ? mirror.commit : await service.mirrors.resolveRef(entry.url, args.ref, caller.signal)
      const lease = await service.mirrors.acquire(entry.url, target, caller.signal)
      if (caller.origin === 'service') return { repo: entry.url, commit: lease.commit, path: lease.dir, release: lease.release }
      holdForTool(`${sessionOf(caller) ?? ''}\u0000${entry.url}`, lease.release)
      return { repo: entry.url, commit: lease.commit, path: lease.dir }
    },
  }),
  define({
    tool: 'repo_workspace_create',
    method: 'workspaceCreate',
    access: 'read',
    description: 'Create a workspace to change a repository\'s code: an ordinary git clone (with its own .git) in a new directory under the current working directory, which then becomes the working directory. Work there with the ordinary file and shell tools and plain git (status, diff, add, commit, log, pull, push): its origin goes through dsh-repo, so fetch and push work without tokens, but pushing to the default branch, protected branches, tags, or deleting branches is refused. The workspace pushes to one branch: `branch` (an existing branch is continued, e.g. the source branch of an open PR/MR to update) or, by default, a branch named after this session. Finish with repo_workspace_push, which commits, pushes, and can open the PR/MR in one approved step. For follow-up fixes to work already pushed, keep using the same workspace.',
    schema: z.object({
      repo,
      path: z.string().min(1).optional().describe('Directory for the workspace, missing or empty, inside the session directory; default: a new directory named after the repository under the working directory'),
      base: z.string().min(1).optional().describe('Branch the work merges into, and starts from unless `branch` exists; default: the default branch'),
      commit: commit.optional().describe('Full commit id on `base` to start from, e.g. the commit a log analysis looked at'),
      branch: z.string().min(1).optional().describe('Branch to push to; an existing one is continued from its head. Default: dsh/<session id>'),
    }).strict(),
    run: async (args, deps, caller) => {
      const url = catalogUrl(deps.service, args.repo)
      let path = args.path
      let agent: CallerAgent | undefined
      if (caller.origin === 'tool') {
        agent = requireAgent(caller, 'repo_workspace_create')
        const root = (agent as Agent).session?.header.cwd
        const current = await currentDirectory(deps, agent, caller.signal)
        const parent = root === undefined || within(root, current) ? current : root
        path = path === undefined ? await freeDirectory(parent, basename(url.replace(/\/+$/, '').replace(/\.git$/, '')) || 'repo') : resolve(current, path)
        // Compared also through real paths: a symbolic link inside the Session directory may lead outside it.
        if (root !== undefined && (!within(root, path) || !within(await realPathOf(root), await realPathOf(path)))) throw new RepoError('invalid', `工作区目录必须在会话目录 ${root} 里面：${path}`)
      } else if (path === undefined) {
        throw new RepoError('invalid', 'workspaceCreate 的 path 必须给出')
      }
      const session = sessionOf(caller)
      const info: WorkspaceInfo = await deps.workspaces.create({
        repo: url,
        path,
        ...args.base === undefined ? {} : { base: args.base },
        ...args.commit === undefined ? {} : { commit: args.commit },
        ...args.branch === undefined ? {} : { branch: args.branch },
        ...session === undefined ? {} : { session },
      }, caller.signal)
      if (agent === undefined) return info
      const workingDirectory = deps.workingDirectory()
      const current = workingDirectory === undefined ? undefined : await workingDirectory.set(agent as Agent, info.path, caller.signal)
      return {
        ...info,
        workingDirectory: current ?? null,
        next: `Work in ${info.path} with the ordinary tools and plain git; when done, call repo_workspace_push (with mr to open a PR/MR into ${info.base}). It pushes to branch ${info.branch}.`,
      }
    },
  }),
  define({
    tool: 'repo_workspace_list',
    method: 'workspaceList',
    access: 'read',
    description: 'List the workspaces created by repo_workspace_create that are inside this session\'s directory, with their repository, branch, and start point.',
    schema: z.object({ repo: repo.optional().describe('Only workspaces of this repository') }).strict(),
    run: async (args, deps, caller) => {
      const url = args.repo === undefined ? undefined : catalogUrl(deps.service, args.repo)
      const records = await deps.workspaces.list(url)
      if (caller.origin === 'service') return records.map(workspaceInfo)
      const agent = requireAgent(caller, 'repo_workspace_list') as Agent
      const root = agent.session?.header.cwd
      const session = agent.session?.header.id
      return records.filter(record => record.session === session || (root !== undefined && within(root, record.path))).map(workspaceInfo)
    },
  }),
  define({
    tool: 'repo_workspace_status',
    method: 'workspaceStatus',
    access: 'read',
    description: 'Show what a workspace changed since its start: files with line counts (uncommitted and untracked included), its commits, how many are not pushed yet, and the diff (cut at the configured size limit).',
    schema: z.object({ path: workspacePath }).strict(),
    run: async (args, deps, caller) => {
      const record = await deps.workspaces.locate(await workspaceTarget(deps, args.path, caller, 'workspaceStatus'))
      deps.service.catalog.require(record.repo, 'read')
      const settings = deps.service.settings
      return await deps.workspaces.status(record, caller.signal, settings.limits.maxDiffBytes, settings.mirror.gitTimeoutMs)
    },
  }),
  define({
    tool: 'repo_workspace_push',
    method: 'workspacePush',
    access: 'write',
    description: 'Commit the uncommitted changes of a workspace (with `message`) and push it to its branch; with `mr`, also open a PR/MR from the branch unless one is open. One approval covers all of it. The commit is committed by the account that owns the host token, authored by that account, the configured identity, or the person another plugin names, and records this session\'s id. A PR/MR from the branch updates by itself; the result lists the open ones, so never open a second one. Plain `git push` in the workspace also works, without approval. Requires user approval.',
    schema: z.object({
      path: workspacePath,
      message: z.string().min(1).optional().describe('Commit message for the uncommitted changes; required when there are any'),
      forceWithLease: z.boolean().optional().describe('Replace the remote branch if it moved, as long as it is where this workspace last saw it'),
      mr: z.object({
        title: z.string().min(1),
        body: mrBody,
        target: z.string().min(1).optional().describe('Target branch; default: the workspace\'s base'),
        draft: z.boolean().optional(),
      }).strict().optional().describe('Open a PR/MR from the branch unless one is open'),
    }).strict(),
    write: {
      level: 'write',
      authorize: 'code-write',
      prompt: async (args, deps, caller) => {
        const record = await deps.workspaces.locate(await workspaceTarget(deps, args.path, caller, 'workspacePush'))
        deps.service.catalog.require(record.repo, 'write')
        const settings = deps.service.settings
        const status = await deps.workspaces.status(record, caller.signal, settings.limits.maxDiffBytes, settings.mirror.gitTimeoutMs)
        const remote = (await deps.service.mirrors.resolveRef(record.repo, record.branch, caller.signal).catch(() => undefined)) === undefined
        return { ...pushPrompt(status, args, remote), repo: record.repo }
      },
    },
    run: async (args, deps, caller): Promise<WorkspacePushResult> => {
      const { service, workspaces } = deps
      const record = await workspaces.locate(await workspaceTarget(deps, args.path, caller, 'workspacePush'))
      service.catalog.require(record.repo, 'write')
      const settings = service.settings
      const session = sessionOf(caller) ?? record.session
      const details = session === undefined ? undefined : await collectDetails(deps.parallel, { session, path: record.path })
      const trailers = details === undefined ? undefined : checkTrailers(details.trailers)
      const committer = (service.gitHost(record.repo) ? await service.tokenIdentity(record.repo, caller.signal) : undefined) ?? configuredIdentity(settings)
      const author = details?.author === undefined ? configuredIdentity(settings) ?? committer : checkAuthor(details.author)
      const outcome = await workspaces.push(record, {
        ...args.message === undefined ? {} : { message: args.message },
        ...args.forceWithLease === undefined ? {} : { forceWithLease: args.forceWithLease },
        ...author === undefined ? {} : { author },
        ...committer === undefined ? {} : { committer },
        ...session === undefined ? {} : { session },
        ...trailers === undefined || trailers.length === 0 ? {} : { trailers },
        signal: caller.signal,
      }, settings.mirror.gitTimeoutMs)
      const base = { repo: record.repo, path: record.path, branch: record.branch, base: record.base, ...outcome }
      if (!service.gitHost(record.repo)) return { ...base, openMrs: [], watching: false }
      let open: readonly MrInfo[]
      let createdMr: MrInfo | undefined
      try {
        open = await openMrsFrom(service, record.repo, record.branch, caller.signal)
        if (args.mr !== undefined && open.length === 0) {
          createdMr = await service.createChange(record.repo, {
            title: args.mr.title,
            ...args.mr.body === undefined ? {} : { body: withSignature(args.mr.body, settings.tools.signature) ?? args.mr.body },
            sourceBranch: record.branch,
            targetBranch: args.mr.target ?? record.base,
            draft: args.mr.draft === true,
            deleteSourceBranch: settings.tools.deleteSourceBranch,
            signal: caller.signal,
          })
          open = [createdMr]
        }
      } catch (error) {
        // The push already succeeded; report the failed request step instead of failing the call.
        return { ...base, openMrs: [], watching: false, mrError: error instanceof Error ? error.message : String(error) }
      }
      const watched = []
      for (const mr of open) watched.push(await watchMr(deps, record.repo, mr, caller, mr === createdMr ? 'created' : 'pushed', outcome.commit))
      const watchError = watched.find(entry => entry.watchError !== undefined)?.watchError
      return {
        ...base,
        openMrs: open.map(summary),
        ...createdMr === undefined ? {} : { createdMr: summary(createdMr) },
        watching: watched.some(entry => entry.watching),
        ...watchError === undefined ? {} : { watchError },
      }
    },
  }),
  define({
    tool: 'repo_workspace_remove',
    method: 'workspaceRemove',
    access: 'read',
    description: 'Delete a workspace directory created by repo_workspace_create. Refused while it has uncommitted changes or unpushed commits unless `force` is set.',
    schema: z.object({ path: z.string().min(1).describe('Workspace directory'), force: z.boolean().optional().describe('Delete even with unsaved work') }).strict(),
    run: async (args, deps, caller) => {
      const record = await deps.workspaces.locate(await workspaceTarget(deps, args.path, caller, 'workspaceRemove'))
      if (caller.origin === 'tool') {
        const root = (requireAgent(caller, 'repo_workspace_remove') as Agent).session?.header.cwd
        if (root !== undefined && record.session !== sessionOf(caller) && !within(root, record.path)) throw new RepoError('forbidden', `${record.path} 不在当前会话的目录里，也不是当前会话创建的`)
      }
      const removed = await deps.workspaces.remove(record, args.force === true, caller.signal, deps.service.settings.mirror.gitTimeoutMs)
      return { path: record.path, ...removed }
    },
  }),
]

/** Most trailers one push may add besides `DSH-Session:`. */
const MAX_TRAILERS = 20
const TRAILER_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

/**
 * Validate commit trailers the `repo/commit-trailers` listeners added, trimming each value.
 * @param trailers - added trailers.
 * @returns the trimmed trailers.
 * @throws {RepoError} `invalid` naming the first bad trailer.
 */
export function checkTrailers(trailers: readonly { readonly token: string; readonly value: string }[]): { token: string; value: string }[] {
  if (trailers.length > MAX_TRAILERS) throw new RepoError('invalid', `提交尾注最多 ${MAX_TRAILERS} 条，收到 ${trailers.length} 条`)
  return trailers.map(({ token, value }) => {
    if (!TRAILER_TOKEN.test(token)) throw new RepoError('invalid', `提交尾注名只能是字母开头的字母、数字和 -，最长 64 个字符：${JSON.stringify(token)}`)
    if (token.toLowerCase() === 'dsh-session') throw new RepoError('invalid', 'DSH-Session 尾注由 dsh-repo 自己写入，不能另外添加')
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new RepoError('invalid', `提交尾注 ${token} 的值不能为空、超过 200 个字符或包含换行等控制字符`)
    return { token, value: trimmed }
  })
}

/**
 * A commit author as given, trimmed.
 * @throws {RepoError} `invalid` for an empty name or one with `<`, `>`, or a newline, or an empty email or one with `<`, `>`, or whitespace.
 */
function checkAuthor(author: CommitAuthor): CommitAuthor {
  const name = author.name.trim()
  const email = author.email.trim()
  if (!/^[^<>\n]+$/.test(name)) throw new RepoError('invalid', '提交作者名不能为空，也不能包含 < > 或换行')
  if (!/^[^<>\s]+$/.test(email)) throw new RepoError('invalid', '提交作者邮箱不能为空，也不能包含 < > 或空白')
  return { name, email }
}

/**
 * Whether the tool settings and the catalog offer a tool to the model.
 * @param access - the tool's access class.
 * @param settings - tool settings now in effect.
 * @param highest - the highest access of any reachable catalog repository; undefined for an empty catalog.
 * @returns whether the model sees the tool.
 */
export function toolOffered(access: ToolAccess, settings: RepoSettings['tools'], highest: RepoAccess | undefined): boolean {
  if (!settings.enabled) return false
  if (access === 'admin') return settings.writes !== 'off'
  if (highest === undefined) return false
  if (access === 'read' || access === 'watch') return true
  if (settings.writes === 'off') return false
  return allows(highest, access)
}

/** Caller fields a service call passes besides its parameters. */
const CALLER_FIELDS = ['agent', 'callId', 'signal'] as const

/**
 * Run one operation through the pipeline.
 * @param operation - the operation.
 * @param raw - its parameters: tool JSON, or a service parameter object (caller fields are taken off first).
 * @param deps - collaborators.
 * @param caller - who calls.
 * @returns the operation's result.
 * @throws {RepoError} classified failures; `declined` when the user did not approve.
 */
export async function execute(operation: Operation, raw: unknown, deps: OperationDeps, caller: Caller): Promise<unknown> {
  let input = raw ?? {}
  if (caller.origin === 'service' && typeof input === 'object' && input !== null) {
    const copy: Record<string, unknown> = { ...input as Record<string, unknown> }
    for (const field of CALLER_FIELDS) delete copy[field]
    input = copy
  }
  const parsed = operation.schema.safeParse(input)
  if (!parsed.success) throw new RepoError('invalid', `${caller.origin === 'tool' ? operation.tool : operation.method} 参数不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
  const args = parsed.data
  const gate = gateOf(operation, args, deps, caller)
  if (operation.write?.prompt !== undefined) await gate(await operation.write.prompt(args, deps, caller))
  return await operation.run(args, deps, caller, gate)
}

/** The gate of a write: catalog access, then for an Agent writes setting, `access/authorize`, and approval. */
function gateOf(operation: Operation, args: unknown, deps: OperationDeps, caller: Caller): Gate {
  return async (prompt) => {
    const spec = operation.write
    if (spec === undefined) return
    const target = prompt.repo ?? (args as { repo?: unknown }).repo
    if (spec.level !== undefined && typeof target === 'string') deps.service.catalog.require(target, spec.level)
    const gated = caller.origin === 'tool' || caller.agent !== undefined
    if (!gated) return
    const writes = deps.service.settings.tools.writes
    const name = caller.origin === 'tool' ? operation.tool : operation.method
    if (writes === 'off') throw new RepoError('forbidden', `dsh-repo 设置页已关闭写操作，${name} 不会执行`)
    const session = sessionOf(caller)
    if (session !== undefined) await authorize(deps.parallel, { session, level: spec.authorize, action: operation.method, summary: prompt.zh })
    if (writes !== 'ask') return
    const approval = deps.approval()
    if (approval === undefined) throw new RepoError('forbidden', `当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），dsh-repo 不会在未经授权时执行 ${name}；或在 dsh-repo 设置页把写操作改为「不审批」`)
    const agent = requireAgent(caller, name)
    const outcome = await approval.request({
      agent: agent as Agent,
      toolName: operation.tool,
      ...caller.callId === undefined ? {} : { callId: caller.callId },
      reason: prompt.zh,
      displayReason: { en: prompt.en, zh: prompt.zh },
      signal: caller.signal,
    })
    if (outcome === 'cancelled') caller.signal.throwIfAborted()
    if (outcome !== 'allowed-once') throw new DeclinedError(outcome)
  }
}

/**
 * The operation with a service method name.
 * @param method - service method.
 * @returns the operation.
 * @throws when no operation has that method.
 */
export function operationOf(method: string): Operation {
  const found = OPERATIONS.find(operation => operation.method === method)
  if (found === undefined) throw new Error(`dsh-repo: 没有服务方法 ${method}`)
  return found
}
