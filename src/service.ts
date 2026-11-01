/**
 * The `dshRepos` service: resolves each target against the configured hosts
 * and repositories, validates arguments, attaches the call deadline, delegates
 * to the host family's provider, and turns every failure into a
 * {@link RepoError}.
 *
 * Tokens are read through `ctx.credentials` and settings from the settings
 * file's store on every request, so a rotated token or a saved setting takes
 * effect without a reload.
 *
 * @module dsh-repo/service
 */

import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  CallOptions, ChangeCreate, ChangeInfo, CommitAuthor, CommitTrailer, ChangeListOptions, ChangeUpdate, DshRepoService, IssueCreate, IssueListOptions, IssueUpdate,
  HostCreate, HostInfo, HostsChange, MergedBranchDeletion, MergeOptions, MirrorSettings, MirrorState, MirrorSyncOptions, MirrorTreeEntry, Page, PageOptions, RepoRef, RepoTarget,
  SnapshotLease, TokenStatus, WorkspaceChanges, WorkspaceInfo, WorkspaceOpenOptions, WorkspacePushOptions, WorkspacePushResult,
} from './contract.ts'
import { apiBaseUrl, DEFAULT_SETTINGS, expandHome, resolveSettings } from './config.ts'
import type { HostSpec, RepoSettings } from './config.ts'
import { RepoError, toRepoError } from './errors.ts'
import type { HostCredentials, HostLogger } from './host.ts'
import { HostStore, isAcceptedToken, MAX_TOKEN_LENGTH } from './hosts.ts'
import { credentialEnvironment } from './mirror/git.ts'
import type { MirrorStore } from './mirror/store.ts'
import type { WorkspaceStore } from './mirror/workspace.ts'
import { GithubProvider } from './providers/github.ts'
import { GitlabProvider } from './providers/gitlab.ts'
import type { Call, Paging, Provider } from './providers/types.ts'
import { hostOf, resolveTarget } from './target.ts'
import type { ResolvedTarget } from './target.ts'

/** Name the service is provided under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** Builds the provider of one host; tests substitute it. */
export type ProviderFactory = (spec: HostSpec, token: () => Promise<string>, timeoutMs: number) => Provider

/** Default factory: Octokit for GitHub, GitBeaker for GitLab. */
export const defaultProviderFactory: ProviderFactory = (spec, token, timeoutMs) => spec.kind === 'github'
  ? new GithubProvider(apiBaseUrl(spec), token)
  : new GitlabProvider(apiBaseUrl(spec), token, timeoutMs)

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[^\s~^:?*[\\\u0000-\u001f\u007f]+$/

/** Pages of change requests from one branch read before giving up. */
const MAX_BRANCH_CHANGE_PAGES = 10

/** Every change request, in any state, from a branch of the repository. */
async function allChangesFrom(provider: Provider, ref: RepoRef, branch: string, call: Call): Promise<ChangeInfo[]> {
  const found: ChangeInfo[] = []
  for (let page: number | undefined = 1; page !== undefined;) {
    if (page > MAX_BRANCH_CHANGE_PAGES) throw new RepoError('too-large', `分支 ${branch} 上的 PR/MR 超过 ${MAX_BRANCH_CHANGE_PAGES * call.limits.maxPerPage} 个`)
    const result: Page<ChangeInfo> = await provider.listChanges(ref, { page, perPage: call.limits.maxPerPage, state: 'all', sourceBranch: branch }, call)
    found.push(...result.items)
    page = result.nextPage
  }
  return found
}

function requireBranch(value: string, label: string): void {
  if (!BRANCH.test(value) || value.startsWith('/') || value === '@') throw new RepoError('invalid', `${label}不合法：${value}`)
}

function requireRepoPath(value: string, label: string): void {
  const segments = value.split('/')
  if (value === '' || value.startsWith('/') || segments.some(segment => segment === '' || segment === '.' || segment === '..') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RepoError('invalid', `${label}不合法：${value}（用仓库根目录下的相对路径，例如 src/index.ts）`)
  }
}

function requireNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RepoError('invalid', `编号必须是正整数：${value}`)
}

function requireText(value: string, label: string): void {
  if (value.trim() === '') throw new RepoError('invalid', `${label}不能为空`)
}

/** Most trailers one push may add besides `DSH-Session:`. */
const MAX_TRAILERS = 20
const TRAILER_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

/**
 * Validate extra commit trailers, trimming each value.
 * @param trailers - trailers from the caller or the `repo/commit-trailers` listeners.
 * @returns the trimmed trailers.
 * @throws {RepoError} `invalid` naming the first bad trailer.
 */
function checkTrailers(trailers: readonly CommitTrailer[]): CommitTrailer[] {
  if (trailers.length > MAX_TRAILERS) throw new RepoError('invalid', `提交尾注最多 ${MAX_TRAILERS} 条，收到 ${trailers.length} 条`)
  return trailers.map(({ token, value }) => {
    if (!TRAILER_TOKEN.test(token)) throw new RepoError('invalid', `提交尾注名只能是字母开头的字母、数字和 -，最长 64 个字符：${JSON.stringify(token)}`)
    if (token.toLowerCase() === 'dsh-session') throw new RepoError('invalid', 'DSH-Session 尾注由 dsh-repo 自己写入，不能另外添加')
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new RepoError('invalid', `提交尾注 ${token} 的值不能为空、超过 200 个字符或包含换行等控制字符`)
    return { token, value: trimmed }
  })
}

/** Rejects with the signal's reason once it aborts. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

/** HTTP username git sends with a host's token. */
function gitUsername(kind: HostSpec['kind']): string {
  return kind === 'gitlab' ? 'oauth2' : 'x-access-token'
}

/** Collaborators of the service. */
export interface RepoServiceDeps {
  /** DSH credential store; tokens are resolved per request. */
  readonly credentials: HostCredentials
  /** Configured and added hosts, the mirror directory, and the run-time settings. */
  readonly hosts: HostStore
  /** Local mirrors. */
  readonly mirrors: MirrorStore
  /** Writable checkouts of mirror commits. */
  readonly workspaces: WorkspaceStore
  readonly factory?: ProviderFactory
  /** Mirror directory used while none is chosen; default: the mirrors' starting root. */
  readonly defaultMirrorDir?: string
  /** Reports a throwing {@link RepoService.onHostsChange} listener. */
  readonly logger?: HostLogger
}

/** The service implementation. */
export class RepoService implements DshRepoService {
  readonly version = 2 as const
  private readonly providers = new Map<string, Provider>()
  private readonly credentials: HostCredentials
  private readonly hosts: HostStore
  private readonly mirrors: MirrorStore
  private readonly workspaces: WorkspaceStore
  private readonly factory: ProviderFactory
  private readonly logger: HostLogger | undefined
  private readonly defaultMirrorDir: string
  private readonly hostListeners = new Set<(change: HostsChange) => void>()
  /** Commit identity of each host's token account, keyed by host URL and checked against the token it was read with. */
  private readonly identities = new Map<string, { readonly token: string; readonly author: Promise<CommitAuthor> }>()

  /** @param deps - credential store, hosts and settings, mirrors, and provider factory. */
  constructor(deps: RepoServiceDeps) {
    this.credentials = deps.credentials
    this.hosts = deps.hosts
    this.mirrors = deps.mirrors
    this.workspaces = deps.workspaces
    this.factory = deps.factory ?? defaultProviderFactory
    this.logger = deps.logger
    this.defaultMirrorDir = deps.defaultMirrorDir ?? deps.mirrors.root
  }

  /** Whether any host is configured or added. */
  /** @returns the run-time settings now in effect. */
  get settings(): RepoSettings {
    return this.hosts.settings()
  }

  /** @returns the value of every setting while nothing is stored. */
  get defaultSettings(): RepoSettings {
    return DEFAULT_SETTINGS
  }

  /** @returns absolute path of the settings file. */
  get settingsFile(): string {
    return this.hosts.file
  }

  /**
   * Validate and persist the run-time settings, or return to the defaults
   * with undefined. Calls that start afterwards use them; providers are
   * rebuilt so the API deadline applies to their HTTP clients too.
   * @param input - complete settings from the settings page.
   * @returns the settings now in effect.
   * @throws {RepoError} `invalid` naming every bad field, `unavailable` when the file cannot be written.
   */
  async updateSettings(input: unknown): Promise<RepoSettings> {
    const next = input === undefined ? DEFAULT_SETTINGS : resolveSettings(input)
    await this.hosts.setSettings(next)
    this.providers.clear()
    return next
  }

  get configured(): boolean {
    return this.hosts.all().length > 0
  }

  resolve(repo: RepoTarget): RepoRef {
    const { spec: _spec, ...ref } = this.target(repo)
    return ref
  }

  async repoInfo(repo: RepoTarget, options: CallOptions = {}) {
    return await this.run(repo, options, '读取仓库信息', (provider, ref, call) => provider.repoInfo(ref, call))
  }

  async listBranches(repo: RepoTarget, options: PageOptions & { readonly search?: string } = {}) {
    const query = { ...this.paging(options), ...options.search === undefined ? {} : { search: options.search } }
    return await this.run(repo, options, '列出分支', (provider, ref, call) => provider.listBranches(ref, query, call))
  }

  async getBranch(repo: RepoTarget, name: string, options: CallOptions = {}) {
    requireBranch(name, '分支名')
    return await this.run(repo, options, `读取分支 ${name}`, (provider, ref, call) => provider.getBranch(ref, name, call))
  }

  async listCommits(repo: RepoTarget, options: PageOptions & { readonly ref?: string; readonly path?: string } = {}) {
    if (options.path !== undefined) requireRepoPath(options.path, '路径')
    const query = { ...this.paging(options), ...options.ref === undefined ? {} : { ref: options.ref }, ...options.path === undefined ? {} : { path: options.path } }
    return await this.run(repo, options, '列出提交', (provider, ref, call) => provider.listCommits(ref, query, call))
  }

  async listTree(repo: RepoTarget, options: CallOptions & { readonly ref?: string; readonly path?: string; readonly recursive?: boolean } = {}) {
    const path = (options.path ?? '').replace(/^\/+|\/+$/g, '')
    if (path !== '') requireRepoPath(path, '目录')
    const query = { path, recursive: options.recursive === true, ...options.ref === undefined ? {} : { ref: options.ref } }
    return await this.run(repo, options, '列出目录', (provider, ref, call) => provider.listTree(ref, query, call))
  }

  async readFile(repo: RepoTarget, path: string, options: CallOptions & { readonly ref?: string } = {}) {
    requireRepoPath(path, '文件路径')
    return await this.run(repo, options, `读取文件 ${path}`, (provider, ref, call) => provider.readFile(ref, path, options.ref, call))
  }

  async listIssues(repo: RepoTarget, options: IssueListOptions = {}) {
    const query = {
      ...this.paging(options),
      state: options.state ?? 'open',
      ...options.labels === undefined ? {} : { labels: options.labels },
      ...options.assignee === undefined ? {} : { assignee: options.assignee },
    }
    return await this.run(repo, options, '列出 issue', (provider, ref, call) => provider.listIssues(ref, query, call))
  }

  async getIssue(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 issue #${number}`, (provider, ref, call) => provider.getIssue(ref, number, call))
  }

  async createIssue(repo: RepoTarget, fields: IssueCreate) {
    requireText(fields.title, '标题')
    return await this.run(repo, fields, '创建 issue', (provider, ref, call) => provider.createIssue(ref, fields, call))
  }

  async updateIssue(repo: RepoTarget, number: number, update: IssueUpdate) {
    requireNumber(number)
    if (update.title !== undefined) requireText(update.title, '标题')
    return await this.run(repo, update, `更新 issue #${number}`, (provider, ref, call) => provider.updateIssue(ref, number, update, call))
  }

  async commentIssue(repo: RepoTarget, number: number, body: string, options: CallOptions = {}) {
    requireNumber(number)
    requireText(body, '评论内容')
    return await this.run(repo, options, `评论 issue #${number}`, (provider, ref, call) => provider.commentIssue(ref, number, body, call))
  }

  async listChanges(repo: RepoTarget, options: ChangeListOptions = {}) {
    const query = {
      ...this.paging(options),
      state: options.state ?? 'open',
      ...options.sourceBranch === undefined ? {} : { sourceBranch: options.sourceBranch },
      ...options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch },
    }
    return await this.run(repo, options, '列出 PR/MR', (provider, ref, call) => provider.listChanges(ref, query, call))
  }

  async getChange(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number}`, (provider, ref, call) => provider.getChange(ref, number, call))
  }

  async changeDiff(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number} 的 diff`, (provider, ref, call) => provider.changeDiff(ref, number, call))
  }

  async changeStatus(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number} 的状态`, (provider, ref, call) => provider.changeStatus(ref, number, call))
  }

  async createChange(repo: RepoTarget, change: ChangeCreate) {
    requireText(change.title, '标题')
    requireBranch(change.sourceBranch, '源分支名')
    if (change.targetBranch !== undefined) requireBranch(change.targetBranch, '目标分支名')
    return await this.run(repo, change, '创建 PR/MR', async (provider, ref, call) => {
      const targetBranch = change.targetBranch ?? (await provider.repoInfo(ref, call)).defaultBranch
      if (targetBranch === change.sourceBranch) throw new RepoError('invalid', '源分支和目标分支不能相同')
      const { signal: _signal, ...fields } = change
      return await provider.createChange(ref, { ...fields, targetBranch, draft: change.draft === true, deleteSourceBranch: change.deleteSourceBranch === true }, call)
    })
  }

  async updateChange(repo: RepoTarget, number: number, update: ChangeUpdate) {
    requireNumber(number)
    if (update.title !== undefined) requireText(update.title, '标题')
    if (update.targetBranch !== undefined) requireBranch(update.targetBranch, '目标分支名')
    return await this.run(repo, update, `更新 PR/MR #${number}`, (provider, ref, call) => provider.updateChange(ref, number, update, call))
  }

  async commentChange(repo: RepoTarget, number: number, body: string, options: CallOptions = {}) {
    requireNumber(number)
    requireText(body, '评论内容')
    return await this.run(repo, options, `评论 PR/MR #${number}`, (provider, ref, call) => provider.commentChange(ref, number, body, call))
  }

  async mergeChange(repo: RepoTarget, number: number, options: MergeOptions) {
    requireNumber(number)
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(options.headSha)) throw new RepoError('invalid', `headSha 必须是完整的提交号：${options.headSha}`)
    const request = { headSha: options.headSha, ...options.method === undefined ? {} : { method: options.method }, deleteSourceBranch: options.deleteSourceBranch === true }
    return await this.run(repo, options, `合并 PR/MR #${number}`, (provider, ref, call) => provider.mergeChange(ref, number, request, call))
  }

  async deleteMergedBranch(repo: RepoTarget, branch: string, options: CallOptions = {}): Promise<MergedBranchDeletion> {
    requireBranch(branch, '分支名')
    return await this.run(repo, options, `删除分支 ${branch}`, async (provider, ref, call) => {
      const head = await provider.getBranch(ref, branch, call)
      if (head === undefined) throw new RepoError('not-found', `没有分支 ${branch}`)
      if (head.default) throw new RepoError('forbidden', `${branch} 是默认分支，不能删除`)
      if (head.protected) throw new RepoError('forbidden', `${branch} 是受保护分支，不能删除`)
      const changes = await allChangesFrom(provider, ref, branch, call)
      const open = changes.find(change => change.state === 'open')
      if (open !== undefined) throw new RepoError('conflict', `${branch} 还是打开中的 PR/MR #${open.number} 的源分支，不能删除`)
      const merged = changes.find(change => change.state === 'merged' && change.headSha === head.commit)
      if (merged === undefined) throw new RepoError('conflict', `${branch} 的最新提交 ${head.commit.slice(0, 12)} 没有通过已合并的 PR/MR 合入，可能还有没合入的工作，不删除`)
      await provider.deleteBranch(ref, branch, call)
      return { branch, commit: head.commit, change: { number: merged.number, webUrl: merged.webUrl } }
    })
  }

  async listHosts(): Promise<readonly HostInfo[]> {
    return await Promise.all(this.hosts.all().map(spec => this.hostInfo(spec)))
  }

  async addHost(host: HostCreate): Promise<HostInfo> {
    const token = host.token?.trim()
    if (token !== undefined && !isAcceptedToken(token)) throw new RepoError('invalid', `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
    const spec = await this.hosts.add(host)
    try {
      if (token !== undefined) await this.storeToken(spec, token)
    } finally {
      this.emitHostsChange({ kind: 'added', url: spec.url })
    }
    return await this.hostInfo(spec)
  }

  async removeHost(url: string): Promise<void> {
    const spec = await this.hosts.remove(url)
    this.providers.delete(spec.url)
    this.identities.delete(spec.url)
    try {
      await this.credentials.unset(spec.tokenRef)
    } catch (error) {
      throw new RepoError('unavailable', `已删除主机 ${spec.url}，但清除令牌 ${spec.tokenRef} 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.emitHostsChange({ kind: 'removed', url: spec.url })
    }
  }

  async setHostToken(url: string, token: string | undefined): Promise<HostInfo> {
    const spec = this.hosts.find(url)
    if (token === undefined) {
      try {
        await this.credentials.unset(spec.tokenRef)
      } catch (error) {
        throw new RepoError('unavailable', `清除 ${spec.tokenRef} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      const value = token.trim()
      if (!isAcceptedToken(value)) throw new RepoError('invalid', `令牌不能为空、超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
      await this.storeToken(spec, value)
    }
    this.emitHostsChange({ kind: 'token', url: spec.url })
    return await this.hostInfo(spec)
  }

  onHostsChange(listener: (change: HostsChange) => void): () => void {
    const entry = (change: HostsChange): void => { listener(change) }
    this.hostListeners.add(entry)
    return () => { this.hostListeners.delete(entry) }
  }

  private emitHostsChange(change: HostsChange): void {
    for (const listener of [...this.hostListeners]) {
      try {
        listener(change)
      } catch (error) {
        this.logger?.error?.('dsh-repo: 主机变更监听器出错：%s', error instanceof Error ? error.message : String(error))
      }
    }
  }

  mirrorSettings(): MirrorSettings {
    return { dir: this.mirrors.root, defaultDir: this.defaultMirrorDir }
  }

  async setMirrorDir(dir: string | undefined): Promise<MirrorSettings> {
    let target = this.defaultMirrorDir
    if (dir !== undefined) {
      const trimmed = dir.trim()
      if (trimmed === '' || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new RepoError('invalid', '镜像目录不能为空或包含控制字符')
      if (!isAbsolute(trimmed) && trimmed !== '~' && !trimmed.startsWith('~/')) throw new RepoError('invalid', `镜像目录必须是绝对路径：${trimmed}`)
      target = expandHome(trimmed)
    }
    try {
      await mkdir(target, { recursive: true })
      await access(target, constants.W_OK)
    } catch (error) {
      throw new RepoError('invalid', `无法创建或写入镜像目录 ${target}：${error instanceof Error ? error.message : String(error)}`)
    }
    await this.hosts.setMirrorDir(target === this.defaultMirrorDir ? undefined : target)
    this.mirrors.setRoot(target)
    this.emitHostsChange({ kind: 'mirror', dir: target })
    return this.mirrorSettings()
  }

  async syncMirror(url: string, options: MirrorSyncOptions = {}): Promise<MirrorState> {
    const env = await this.mirrorAuth(url)
    return await this.mirrors.sync(url, options.branch, env, options.signal)
  }

  async readMirrorFile(url: string, commit: string, path: string, options: CallOptions = {}): Promise<string | undefined> {
    requireRepoPath(path, '文件路径')
    return await this.mirrors.readFile(url, commit, path, options.signal)
  }

  async listMirrorTree(url: string, commit: string, path: string, options: CallOptions = {}): Promise<readonly MirrorTreeEntry[]> {
    const directory = path.replace(/^\/+|\/+$/g, '')
    if (directory !== '') requireRepoPath(directory, '目录')
    return await this.mirrors.listTree(url, commit, directory, options.signal)
  }

  async acquireSnapshot(url: string, commit: string, options: CallOptions = {}): Promise<SnapshotLease> {
    return await this.mirrors.acquire(url, commit, options.signal)
  }

  async openWorkspace(url: string, options: WorkspaceOpenOptions): Promise<WorkspaceInfo> {
    const { branch, signal } = options
    if (options.commit !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.commit)) throw new RepoError('invalid', `起点提交必须是完整的十六进制提交 id：${options.commit}`)
    if (branch !== undefined) {
      requireBranch(branch, '分支名')
      if (options.commit !== undefined) throw new RepoError('invalid', `接着分支 ${branch} 修改时从它的最新提交开始，不能再指定起点提交`)
    }
    if (!isAbsolute(options.dir)) throw new RepoError('invalid', `工作区目录必须是绝对路径：${options.dir}`)
    const env = await this.mirrorAuth(url)
    const base = await this.mirrors.sync(url, options.baseBranch, env, signal)
    if (branch === undefined) return await this.workspaces.open(url, options.dir, { commit: options.commit ?? base.commit, baseBranch: base.branch }, env, signal)
    if (branch === base.branch) throw new RepoError('invalid', `分支 ${branch} 是合入目标，不能同时作为要接着修改的分支`)
    const defaultBranch = options.baseBranch === undefined ? base.branch : await this.mirrors.remoteDefaultBranch(url, env, signal)
    if (branch === defaultBranch) throw new RepoError('invalid', `不能接着默认分支 ${branch} 修改；从默认分支开始时用 baseBranch，推送到新分支`)
    const head = await this.mirrors.sync(url, branch, env, signal)
    return await this.workspaces.open(url, options.dir, { commit: head.commit, baseBranch: base.branch, branch }, env, signal)
  }

  async workspaceChanges(dir: string, options: CallOptions = {}): Promise<WorkspaceChanges> {
    return await this.workspaces.changes(dir, options.signal)
  }

  async pushWorkspace(dir: string, options: WorkspacePushOptions = {}): Promise<WorkspacePushResult> {
    if (options.branch !== undefined) requireBranch(options.branch, '分支名')
    if (options.author !== undefined) {
      if (!/^[^<>\n]+$/.test(options.author.name.trim())) throw new RepoError('invalid', '提交作者名不能为空，也不能包含 < > 或换行')
      if (!/^[^<>\s]+$/.test(options.author.email.trim())) throw new RepoError('invalid', '提交作者邮箱不能为空，也不能包含 < > 或空白')
    }
    const session = options.session?.trim()
    if (session !== undefined && (session === '' || session.length > 200 || /[\u0000-\u001f\u007f]/.test(session))) throw new RepoError('invalid', '会话 id 不能为空、超过 200 个字符或包含换行等控制字符')
    const trailers = options.trailers === undefined ? undefined : checkTrailers(options.trailers)
    const { url } = await this.workspaces.locate(dir)
    const env = await this.mirrorAuth(url, true)
    const author = options.author === undefined ? await this.tokenIdentity(url, options.signal) : { name: options.author.name.trim(), email: options.author.email.trim() }
    return await this.workspaces.push(dir, {
      env,
      ...options.branch === undefined ? {} : { branch: options.branch },
      ...options.message === undefined ? {} : { message: options.message },
      ...author === undefined ? {} : { author },
      ...session === undefined ? {} : { session },
      ...trailers === undefined || trailers.length === 0 ? {} : { trailers },
      ...options.signal === undefined ? {} : { signal: options.signal },
    }, async (remote, branch) => (await this.mirrors.remoteDefaultBranch(remote, env, options.signal)) === branch)
  }

  /**
   * Environment of a mirror's or workspace's network commands: the host's
   * token for an address under a configured host, nothing for local paths
   * and (when allowed) other hosts.
   * @param url - accepted git address.
   * @param push - whether the command writes, which needs a configured host's token unless the address is local.
   * @throws {RepoError} `invalid` for an unsupported address, `not-allowed` outside the configured repositories or on another host when those are refused, `unauthenticated` when the host's token is unset or a push targets a host without one.
   */
  private async mirrorAuth(url: string, push = false): Promise<Record<string, string>> {
    this.mirrors.dirOf(url)
    if (isAbsolute(url) || url.startsWith('file:')) return {}
    const spec = hostOf(url, this.hosts.all())
    if (spec === undefined) {
      if (push) throw new RepoError('unauthenticated', `${url} 不属于已配置的主机，没有令牌可用于推送；先在 dsh-repo 中添加该主机并设置令牌`)
      if (!this.settings.mirror.otherHosts) throw new RepoError('not-allowed', `${url} 不属于已配置的主机，dsh-repo 不镜像其他主机上的仓库`)
      return {}
    }
    resolveTarget(url, this.hosts.all(), this.settings.repos)
    return credentialEnvironment(spec.url, gitUsername(spec.kind), await this.token(spec))
  }

  /**
   * Commit identity of the token account of the host `url` belongs to; read
   * once per token value.
   * @param url - accepted git address that passed {@link mirrorAuth} for a push.
   * @param signal - caller cancellation of the wait.
   * @returns the identity, or `undefined` for a local address.
   * @throws {RepoError} classified failure of the host's current-user API.
   */
  private async tokenIdentity(url: string, signal: AbortSignal | undefined): Promise<CommitAuthor | undefined> {
    const spec = hostOf(url, this.hosts.all())
    if (spec === undefined) return undefined
    const token = await this.token(spec)
    let entry = this.identities.get(spec.url)
    if (entry?.token !== token) {
      // Concurrent pushes share this read, so only the deadline cancels it.
      const author = this.provider(spec).currentUser({ signal: AbortSignal.timeout(this.settings.timeoutMs), limits: this.settings.limits })
      entry = { token, author }
      this.identities.set(spec.url, entry)
      // A failed read is not kept, so the next push asks again.
      author.catch(() => { if (this.identities.get(spec.url) === entry) this.identities.delete(spec.url) })
    }
    try {
      return await (signal === undefined ? entry.author : Promise.race([entry.author, abortion(signal)]))
    } catch (error) {
      throw toRepoError(error, `读取 ${spec.url} 令牌账号的提交身份（作者默认用令牌账号）`)
    }
  }

  private async storeToken(spec: HostSpec, value: string): Promise<void> {
    try {
      await this.credentials.set(spec.tokenRef, value)
    } catch (error) {
      throw new RepoError('unavailable', `保存 ${spec.tokenRef} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async hostInfo(spec: HostSpec): Promise<HostInfo> {
    let token: TokenStatus
    try {
      const info = await this.credentials.describe(spec.tokenRef)
      token = { configured: info.configured, ...info.source === undefined ? {} : { source: info.source }, writable: info.writable }
    } catch (error) {
      token = { configured: false, writable: false, error: error instanceof Error ? error.message : String(error) }
    }
    return {
      kind: spec.kind,
      url: spec.url,
      ...spec.apiUrl === undefined ? {} : { apiUrl: spec.apiUrl },
      ...spec.alias === undefined ? {} : { alias: spec.alias },
      tokenRef: spec.tokenRef,
      origin: this.hosts.isAdded(spec.url) ? 'added' : 'config',
      token,
    }
  }

  private async token(spec: HostSpec): Promise<string> {
    const resolved = await this.credentials.resolve(spec.tokenRef)
    if (resolved === undefined || resolved.value === '') throw new RepoError('unauthenticated', `${spec.url} 的令牌 ${spec.tokenRef} 未设置（在 DSH 凭据库或同名环境变量中设置）`)
    if (!isAcceptedToken(resolved.value)) throw new RepoError('unauthenticated', `${spec.tokenRef} 的值不能用作令牌：不能超过 ${MAX_TOKEN_LENGTH} 个字符或包含换行等控制字符`)
    return resolved.value
  }

  private target(repo: RepoTarget): ResolvedTarget {
    return resolveTarget(repo, this.hosts.all(), this.settings.repos)
  }

  private paging(options: PageOptions): Paging {
    const page = options.page ?? 1
    const perPage = options.perPage ?? this.settings.limits.perPage
    if (!Number.isSafeInteger(page) || page < 1) throw new RepoError('invalid', `page 必须是正整数：${page}`)
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > this.settings.limits.maxPerPage) {
      throw new RepoError('invalid', `perPage 必须在 1 到 ${this.settings.limits.maxPerPage} 之间：${perPage}`)
    }
    return { page, perPage }
  }

  private provider(spec: HostSpec): Provider {
    const existing = this.providers.get(spec.url)
    if (existing !== undefined) return existing
    const created = this.factory(spec, () => this.token(spec), this.settings.timeoutMs)
    this.providers.set(spec.url, created)
    return created
  }

  private async run<T>(repo: RepoTarget, options: CallOptions, what: string, body: (provider: Provider, ref: RepoRef, call: Call) => Promise<T>): Promise<T> {
    const { spec, ...ref } = this.target(repo)
    const settings = this.settings
    const deadline = AbortSignal.timeout(settings.timeoutMs)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    try {
      return await body(this.provider(spec), ref, { signal, limits: settings.limits })
    } catch (error) {
      throw toRepoError(error, `${what}（${ref.host}/${ref.path}）`)
    }
  }
}
