/**
 * The workspace operations behind `repo_workspace_*` and the `workspace*`
 * service methods: where a workspace goes, which workspaces a Session sees,
 * and the push that commits, pushes, opens the PR/MR, and watches it. The
 * operation registry validates the parameters and runs the write gate before
 * these run.
 *
 * - A tool call works relative to the Agent's working directory and stays
 *   inside its Session's directory; a service call names absolute paths.
 * - A push is committed by the host token's account and authored by the
 *   person a `repo/commit-trailers` listener names, the configured identity,
 *   or the token's account, in that order.
 *
 * @module dsh-repo/workspace/flow
 */

import { basename, isAbsolute, resolve } from 'node:path'
import type { Caller } from '../calls.ts'
import { requireAgent, sessionOf, watchMr, withSignature } from '../calls.ts'
import type { RepoSettings } from '../config.ts'
import type { CallerAgent, CommitAuthor, MrInfo, MrSummary, WorkspaceInfo, WorkspacePushResult, WorkspaceStatus } from '../contract.ts'
import { RepoError } from '../errors.ts'
import { collectDetails } from '../events.ts'
import type { Agent } from '../host.ts'
import type { OperationDeps, Prompt } from '../operations.ts'
import { freeDirectory, realPathOf, within } from '../paths.ts'
import { pushPrompt } from '../push-prompt.ts'
import type { RepoService } from '../service.ts'
import { workspaceInfo } from './manager.ts'

/** Parameters of a workspace creation. */
export interface CreateArgs {
  readonly repo: string
  readonly path?: string | undefined
  readonly base?: string | undefined
  readonly commit?: string | undefined
  readonly branch?: string | undefined
}

/** Parameters of a workspace push. */
export interface PushArgs {
  readonly path?: string | undefined
  readonly message?: string | undefined
  readonly forceWithLease?: boolean | undefined
  readonly mr?: {
    readonly title: string
    readonly body?: string | undefined
    readonly target?: string | undefined
    readonly draft?: boolean | undefined
  } | undefined
}

/** Most trailers one push may add besides `DSH-Session:`. */
const MAX_TRAILERS = 20
const TRAILER_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

/**
 * Validate commit trailers the `repo/commit-trailers` listeners added, trimming each value.
 * @param trailers - added trailers.
 * @returns the trimmed trailers.
 * @throws {RepoError} `invalid` naming the first bad trailer.
 */
function checkTrailers(trailers: readonly { readonly token: string; readonly value: string }[]): { token: string; value: string }[] {
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

/** The configured workspace commit identity, when both fields are set. */
function configuredIdentity(settings: RepoSettings): CommitAuthor | undefined {
  const { commitName, commitEmail } = settings.workspace
  return commitName === '' || commitEmail === '' ? undefined : { name: commitName, email: commitEmail }
}

/**
 * Open PRs/MRs from a branch, following pages: a host may return a page with
 * every entry filtered out (GitLab drops fork MRs after fetching) and still
 * have more pages.
 */
async function openMrsFrom(service: RepoService, repo: string, branch: string, signal: AbortSignal): Promise<readonly MrInfo[]> {
  const found: MrInfo[] = []
  for (let next: number | undefined = 1; next !== undefined;) {
    const result = await service.forge.listMrs(repo, { state: 'open', sourceBranch: branch, page: next, perPage: service.settings.current.limits.maxPerPage, signal })
    found.push(...result.items)
    next = result.nextPage
  }
  return found
}

function summary(mr: MrInfo): MrSummary {
  return { number: mr.number, title: mr.title, targetBranch: mr.targetBranch, webUrl: mr.webUrl }
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

/**
 * Create a workspace; a tool call also makes it the Agent's working directory.
 * @param deps - collaborators.
 * @param args - repository, directory, base, start commit, and branch.
 * @param caller - who calls.
 * @returns the workspace, for a tool call with the new working directory and the next step.
 * @throws {RepoError} see `DshRepoService.workspaceCreate`.
 */
export async function createWorkspace(deps: OperationDeps, args: CreateArgs, caller: Caller): Promise<WorkspaceInfo | (WorkspaceInfo & { workingDirectory: string | null; next: string })> {
  const url = deps.service.catalog.require(args.repo, 'read').url
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
  const info = await deps.workspaces.create({
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
}

/**
 * The workspaces a caller sees: every one for a service call; for a tool, the
 * ones its Session created or that lie inside its Session's directory.
 * @param deps - collaborators.
 * @param repo - only workspaces of this repository.
 * @param caller - who calls.
 * @returns the workspaces, oldest first.
 */
export async function listWorkspaces(deps: OperationDeps, repo: string | undefined, caller: Caller): Promise<WorkspaceInfo[]> {
  const url = repo === undefined ? undefined : deps.service.catalog.require(repo, 'read').url
  const records = await deps.workspaces.list(url)
  if (caller.origin === 'service') return records.map(workspaceInfo)
  const agent = requireAgent(caller, 'repo_workspace_list') as Agent
  const root = agent.session?.header.cwd
  const session = agent.session?.header.id
  return records.filter(record => record.session === session || (root !== undefined && within(root, record.path))).map(workspaceInfo)
}

/**
 * What a workspace changed since its start.
 * @param deps - collaborators.
 * @param path - workspace directory or a directory inside it.
 * @param caller - who calls.
 * @returns the status.
 * @throws {RepoError} see `DshRepoService.workspaceStatus`.
 */
export async function workspaceStatus(deps: OperationDeps, path: string | undefined, caller: Caller): Promise<WorkspaceStatus> {
  const record = await deps.workspaces.locate(await workspaceTarget(deps, path, caller, 'workspaceStatus'))
  deps.service.catalog.require(record.repo, 'read')
  const settings = deps.service.settings.current
  return await deps.workspaces.status(record, caller.signal, settings.limits.maxDiffBytes, settings.mirror.gitTimeoutMs)
}

/**
 * The approval text of a push, listing what it commits and pushes.
 * @param deps - collaborators.
 * @param args - push parameters.
 * @param caller - who calls.
 * @returns the prompt, naming the workspace's repository for the write policy.
 */
export async function pushWorkspacePrompt(deps: OperationDeps, args: PushArgs, caller: Caller): Promise<Prompt> {
  const record = await deps.workspaces.locate(await workspaceTarget(deps, args.path, caller, 'workspacePush'))
  const settings = deps.service.settings.current
  const status = await deps.workspaces.status(record, caller.signal, settings.limits.maxDiffBytes, settings.mirror.gitTimeoutMs)
  const remote = (await deps.service.mirrors.store.resolveRef(record.repo, record.branch, caller.signal).catch(() => undefined)) === undefined
  return { ...pushPrompt(status, args, remote), repo: record.repo }
}

/**
 * Commit and push a workspace, then open a PR/MR when asked and none is open, and watch the open ones.
 * @param deps - collaborators.
 * @param args - push parameters.
 * @param caller - who calls.
 * @returns the push outcome with the open PRs/MRs; a failure after the push is reported in `mrError` or `watchError`.
 * @throws {RepoError} see `DshRepoService.workspacePush`.
 */
export async function pushWorkspace(deps: OperationDeps, args: PushArgs, caller: Caller): Promise<WorkspacePushResult> {
  const { service, workspaces } = deps
  const record = await workspaces.locate(await workspaceTarget(deps, args.path, caller, 'workspacePush'))
  service.policy.requireWrite(record.repo, 'write', 'workspacePush')
  const settings = service.settings.current
  const session = sessionOf(caller) ?? record.session
  const details = session === undefined ? undefined : await collectDetails(deps.parallel, { session, path: record.path })
  const trailers = details === undefined ? undefined : checkTrailers(details.trailers)
  const committer = await service.hosts.tokenIdentity(record.repo, caller.signal)
  const author = details?.author === undefined ? configuredIdentity(settings) ?? committer : checkAuthor(details.author)
  const outcome = await workspaces.push(record, {
    ...args.message === undefined ? {} : { message: args.message },
    ...args.forceWithLease === undefined ? {} : { forceWithLease: args.forceWithLease },
    author,
    committer,
    ...session === undefined ? {} : { session },
    ...trailers === undefined || trailers.length === 0 ? {} : { trailers },
    signal: caller.signal,
  }, settings.mirror.gitTimeoutMs)
  const base = { repo: record.repo, path: record.path, branch: record.branch, base: record.base, ...outcome }
  let open: readonly MrInfo[]
  let createdMr: MrInfo | undefined
  try {
    open = await openMrsFrom(service, record.repo, record.branch, caller.signal)
    if (args.mr !== undefined && open.length === 0) {
      createdMr = await service.forge.createMr(record.repo, {
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
  for (const mr of open) watched.push(await watchMr(deps.watch, record.repo, mr, caller, mr === createdMr ? 'created' : 'pushed', outcome.commit))
  const watchError = watched.find(entry => entry.watchError !== undefined)?.watchError
  return {
    ...base,
    openMrs: open.map(summary),
    ...createdMr === undefined ? {} : { createdMr: summary(createdMr) },
    watching: watched.some(entry => entry.watching),
    ...watchError === undefined ? {} : { watchError },
  }
}

/**
 * Delete a workspace; a tool may only delete one its Session created or that lies inside its Session's directory.
 * @param deps - collaborators.
 * @param path - workspace directory.
 * @param force - delete despite unsaved work.
 * @param caller - who calls.
 * @returns the directory and what was discarded.
 * @throws {RepoError} `forbidden` for another Session's workspace, and see `DshRepoService.workspaceRemove`.
 */
export async function removeWorkspace(deps: OperationDeps, path: string, force: boolean, caller: Caller): Promise<{ path: string; discardedCommits: number; discardedChanges: boolean }> {
  const record = await deps.workspaces.locate(await workspaceTarget(deps, path, caller, 'workspaceRemove'))
  if (caller.origin === 'tool') {
    const root = (requireAgent(caller, 'repo_workspace_remove') as Agent).session?.header.cwd
    if (root !== undefined && record.session !== sessionOf(caller) && !within(root, record.path)) throw new RepoError('forbidden', `${record.path} 不在当前会话的目录里，也不是当前会话创建的`)
  }
  const removed = await deps.workspaces.remove(record, force, caller.signal, deps.service.settings.current.mirror.gitTimeoutMs)
  return { path: record.path, ...removed }
}
