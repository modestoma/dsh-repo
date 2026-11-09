/**
 * The repository engine behind the `dshRepos` service, the tools, the
 * watcher, the local syncs, and the settings page: resolves each target
 * against the configured hosts, requires it to be in the repository catalog
 * with enough access, validates arguments, attaches the call deadline,
 * delegates to the host family's provider, and turns every failure into a
 * {@link RepoError}. Approval and `access/authorize` are not done here but in
 * the operation registry (`dsh-repo/operations`).
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
  CallOptions, CatalogRepo, CiActionResult, CiJob, CiJobLog, CommitAuthor, HostCreate, HostInfo, HostsChange, MergedBranchDeletion, MergeMethod, MrInfo, MrState, Page, RepoAccess,
  RepoAddResult, RepoFeature, RepoRef, RepoTarget, TokenStatus,
} from './contract.ts'
import { readLog } from './ci/log.ts'
import { requireBranch, requireCommit } from './refs.ts'
import { RepoCatalog } from './catalog/catalog.ts'
import { publicRepo } from './catalog/entry.ts'
import { apiBaseUrl, DEFAULT_SETTINGS, resolveSettings } from './config.ts'
import type { HostSpec, RepoSettings } from './config.ts'
import type { MirrorSettings, MirrorUsage } from './settings/contract.ts'
import { RepoError, toRepoError } from './errors.ts'
import type { HostCredentials, HostLogger } from './host.ts'
import { SettingsStore, isAcceptedToken, MAX_TOKEN_LENGTH } from './settings/store.ts'
import { credentialEnvironment } from './mirror/git.ts'
import { checkMirrorDir } from './mirror/root.ts'
import type { MirrorState, MirrorStore } from './mirror/store.ts'
import { GithubProvider } from './providers/github.ts'
import { GitlabProvider } from './providers/gitlab.ts'
import type { ActivityRequest, Call, ChangeActivity, Paging, Provider } from './providers/types.ts'
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

/** Paging as list calls pass it. */
export interface PageOptions extends CallOptions {
  readonly page?: number
  readonly perPage?: number
}

/** Filters of a CI run listing; `change` is a pull/merge request number. */
export interface CiRunListOptions extends PageOptions {
  readonly ref?: string
  readonly sha?: string
  readonly change?: number
  readonly state?: 'pending' | 'running' | 'success' | 'failure' | 'canceled'
}

/** A run or a job to retry or cancel. */
export type CiTarget = { readonly runId: number; readonly jobId?: undefined } | { readonly jobId: number; readonly runId?: undefined }

/** Options of {@link RepoService.ciJobLog}. */
export interface CiLogOptions extends CallOptions {
  readonly search?: readonly string[]
  readonly context?: number
  readonly section?: string
  readonly beforeLine?: number
}

/** Fields of a new pull/merge request. */
export interface MrCreateFields extends CallOptions {
  readonly title: string
  readonly body?: string
  readonly sourceBranch: string
  readonly targetBranch?: string
  readonly draft?: boolean
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
  /** GitLab: tick "delete source branch" so GitLab deletes it on merge. */
  readonly deleteSourceBranch?: boolean
}

/** Fields to change on a pull/merge request. */
export interface MrUpdateFields extends CallOptions {
  readonly title?: string
  readonly body?: string
  readonly state?: 'open' | 'closed'
  readonly targetBranch?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Fields of a new issue. */
export interface IssueCreateFields extends CallOptions {
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Fields to change on an issue. */
export interface IssueUpdateFields extends CallOptions {
  readonly title?: string
  readonly body?: string
  readonly state?: 'open' | 'closed'
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** A merge request after validation. */
export interface MergeFields extends CallOptions {
  readonly headSha: string
  readonly method?: MergeMethod
  readonly deleteSourceBranch?: boolean
}

/** Credentials of a configured host for git over HTTPS. */
export interface HostGitCredentials {
  /** Normalized host address. */
  readonly hostUrl: string
  /** HTTP username git sends with the token. */
  readonly username: string
  readonly token: string
}

/** Pages of pull/merge requests from one branch read before giving up. */
const MAX_BRANCH_CHANGE_PAGES = 10

/** Every pull/merge request, in any state, from a branch of the repository. */
async function allChangesFrom(provider: Provider, ref: RepoRef, branch: string, call: Call): Promise<MrInfo[]> {
  const found: MrInfo[] = []
  for (let page: number | undefined = 1; page !== undefined;) {
    if (page > MAX_BRANCH_CHANGE_PAGES) throw new RepoError('too-large', `分支 ${branch} 上的 PR/MR 超过 ${MAX_BRANCH_CHANGE_PAGES * call.limits.maxPerPage} 个`)
    const result: Page<MrInfo> = await provider.listChanges(ref, { page, perPage: call.limits.maxPerPage, state: 'all', sourceBranch: branch }, call)
    found.push(...result.items)
    page = result.nextPage
  }
  return found
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

function requireId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RepoError('invalid', `${label}必须是正整数：${value}`)
}

/** Most search texts of one job log call. */
const MAX_LOG_SEARCH = 20
/** Longest search text or section filter. */
const MAX_LOG_TERM = 200
/** Default and largest context of a job log search. */
const LOG_CONTEXT = { default: 3, max: 50 } as const

/** The run or job a retry or cancel names, with the label for messages. */
function ciTarget(target: CiTarget): { readonly kind: 'run' | 'job'; readonly id: number; readonly label: string } {
  if ((target.runId === undefined) === (target.jobId === undefined)) throw new RepoError('invalid', 'runId 和 jobId 必须给且只给一个')
  const kind = target.runId === undefined ? 'job' : 'run'
  const id = target.runId ?? target.jobId ?? 0
  requireId(id, kind === 'run' ? 'runId' : 'jobId')
  return { kind, id, label: kind === 'run' ? `流水线 ${id}` : `作业 ${id}` }
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
  readonly hosts: SettingsStore
  /** Local mirrors. */
  readonly mirrors: MirrorStore
  readonly factory?: ProviderFactory
  /**
   * Roots the mirror directory may not be or lie in; see `forbiddenMirrorRoots`.
   * The stored choice is checked against them at construction and every new
   * choice before it is saved.
   */
  readonly forbiddenMirrorRoots: readonly string[]
  /** Reports a throwing {@link RepoService.onHostsChange} listener. */
  readonly logger?: HostLogger
}

/** The repository engine. */
export class RepoService {
  /** The repository catalog every call is checked against. */
  readonly catalog: RepoCatalog
  /** Configured and added hosts, the stored directories, and the run-time settings. */
  readonly hosts: SettingsStore
  /** Local mirrors. */
  readonly mirrors: MirrorStore
  private readonly providers = new Map<string, Provider>()
  private readonly credentials: HostCredentials
  private readonly factory: ProviderFactory
  private readonly logger: HostLogger | undefined
  private readonly forbiddenMirrorRoots: readonly string[]
  /** Why the stored mirror directory is not in use, while it was rejected at construction. */
  private mirrorProblem: string | undefined
  private readonly hostListeners = new Set<(change: HostsChange) => void>()
  private readonly settingsListeners = new Set<(next: RepoSettings, previous: RepoSettings) => Promise<void>>()
  /** Commit identity of each host's token account, keyed by host URL and checked against the token it was read with. */
  private readonly identities = new Map<string, { readonly token: string; readonly author: Promise<CommitAuthor> }>()

  /**
   * A mirror directory stored in the settings file replaces the mirrors'
   * starting root; one that breaks the rules is left unused and reported by
   * {@link mirrorSettings} until it is replaced or cleared.
   * @param deps - credential store, hosts and settings, mirrors, forbidden mirror roots, and provider factory.
   */
  constructor(deps: RepoServiceDeps) {
    this.credentials = deps.credentials
    this.hosts = deps.hosts
    this.mirrors = deps.mirrors
    this.factory = deps.factory ?? defaultProviderFactory
    this.logger = deps.logger
    this.forbiddenMirrorRoots = deps.forbiddenMirrorRoots
    this.catalog = new RepoCatalog({ store: deps.hosts, mirrorDir: () => this.mirrors.root, ...deps.logger === undefined ? {} : { logger: deps.logger } })
    const stored = deps.hosts.mirrorDir()
    if (stored !== undefined) {
      try {
        this.mirrors.setRoot(checkMirrorDir(stored, this.forbiddenMirrorRoots))
      } catch (error) {
        this.mirrors.setRoot(undefined)
        this.mirrorProblem = `设置文件里的镜像目录不可用，镜像操作已停用：${error instanceof Error ? error.message : String(error)}`
        this.logger?.error?.('dsh-repo: %s', this.mirrorProblem)
      }
    }
  }

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
   * @throws {RepoError} `invalid` naming every bad field, `unavailable` when the file cannot be written or a {@link onSettingsChange} listener failed after the save.
   */
  async updateSettings(input: unknown): Promise<RepoSettings> {
    const previous = this.settings
    const next = input === undefined ? DEFAULT_SETTINGS : resolveSettings(input)
    await this.hosts.setSettings(next)
    this.providers.clear()
    const failures: string[] = []
    for (const listener of this.settingsListeners) {
      try {
        await listener(next, previous)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (failures.length > 0) throw new RepoError('unavailable', `设置已保存，但没有全部生效：${failures.join('；')}`)
    return next
  }

  /**
   * Run a listener after every saved settings change, awaited by {@link updateSettings}.
   * @param listener - receives the new and the previous settings; a rejection is reported to the saving caller.
   * @returns a function that removes the listener.
   */
  onSettingsChange(listener: (next: RepoSettings, previous: RepoSettings) => Promise<void>): () => void {
    this.settingsListeners.add(listener)
    return () => { this.settingsListeners.delete(listener) }
  }

  /** Whether any host is configured or added. */
  get configured(): boolean {
    return this.hosts.all().length > 0
  }

  resolve(repo: RepoTarget): RepoRef {
    const { spec: _spec, ...ref } = resolveTarget(repo, this.hosts.all())
    return ref
  }

  listRepos(options: { readonly feature?: string } = {}): readonly CatalogRepo[] {
    const { feature } = options
    return this.catalog.entries().filter(entry => feature === undefined || entry.features.includes(feature)).map(publicRepo)
  }

  registerFeature(feature: RepoFeature): () => void {
    return this.catalog.registerFeature(feature)
  }

  onReposChange(listener: () => void): () => void {
    return this.catalog.onChange(listener)
  }

  /**
   * Add a repository to the catalog, or turn features on for its entry.
   * @param url - address.
   * @param options - branch, access, and features of the entry.
   * @param confirm - runs with the Chinese summary only when something changes, before the change; throwing cancels it.
   * @returns the outcome and the entry.
   * @throws {RepoError} see `DshRepoService.repoAdd`.
   */
  async addRepo(url: string, options: { readonly branch?: string; readonly access?: RepoAccess; readonly features?: readonly string[] }, confirm: (summary: string) => Promise<void>): Promise<RepoAddResult> {
    return await this.catalog.ensure(url, options, confirm)
  }

  async repoInfo(repo: RepoTarget, options: CallOptions = {}) {
    return await this.run(repo, options, '读取仓库信息', 'read', (provider, ref, call) => provider.repoInfo(ref, call))
  }

  async listBranches(repo: RepoTarget, options: PageOptions & { readonly search?: string } = {}) {
    const query = { ...this.paging(options), ...options.search === undefined ? {} : { search: options.search } }
    return await this.run(repo, options, '列出分支', 'read', (provider, ref, call) => provider.listBranches(ref, query, call))
  }

  async getBranch(repo: RepoTarget, name: string, options: CallOptions = {}) {
    requireBranch(name, '分支名')
    return await this.run(repo, options, `读取分支 ${name}`, 'read', (provider, ref, call) => provider.getBranch(ref, name, call))
  }

  async listCommits(repo: RepoTarget, options: PageOptions & { readonly ref?: string; readonly path?: string } = {}) {
    if (options.path !== undefined) requireRepoPath(options.path, '路径')
    const query = { ...this.paging(options), ...options.ref === undefined ? {} : { ref: options.ref }, ...options.path === undefined ? {} : { path: options.path } }
    return await this.run(repo, options, '列出提交', 'read', (provider, ref, call) => provider.listCommits(ref, query, call))
  }

  async listTree(repo: RepoTarget, options: CallOptions & { readonly ref?: string; readonly path?: string; readonly recursive?: boolean } = {}) {
    const path = (options.path ?? '').replace(/^\/+|\/+$/g, '')
    if (path !== '') requireRepoPath(path, '目录')
    const query = { path, recursive: options.recursive === true, ...options.ref === undefined ? {} : { ref: options.ref } }
    return await this.run(repo, options, '列出目录', 'read', (provider, ref, call) => provider.listTree(ref, query, call))
  }

  async readFile(repo: RepoTarget, path: string, options: CallOptions & { readonly ref?: string } = {}) {
    requireRepoPath(path, '文件路径')
    return await this.run(repo, options, `读取文件 ${path}`, 'read', (provider, ref, call) => provider.readFile(ref, path, options.ref, call))
  }

  async listIssues(repo: RepoTarget, options: PageOptions & { readonly state?: 'open' | 'closed' | 'all'; readonly labels?: readonly string[]; readonly assignee?: string; readonly search?: string } = {}) {
    const search = options.search?.trim()
    const query = {
      ...this.paging(options),
      state: options.state ?? 'open',
      ...options.labels === undefined ? {} : { labels: options.labels },
      ...options.assignee === undefined ? {} : { assignee: options.assignee },
      ...search === undefined || search === '' ? {} : { search },
    }
    return await this.run(repo, options, '列出 issue', 'read', (provider, ref, call) => provider.listIssues(ref, query, call))
  }

  async getIssue(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 issue #${number}`, 'read', (provider, ref, call) => provider.getIssue(ref, number, call))
  }

  async createIssue(repo: RepoTarget, fields: IssueCreateFields) {
    requireText(fields.title, '标题')
    return await this.run(repo, fields, '创建 issue', 'write', (provider, ref, call) => provider.createIssue(ref, fields, call))
  }

  async updateIssue(repo: RepoTarget, number: number, update: IssueUpdateFields) {
    requireNumber(number)
    if (update.title !== undefined) requireText(update.title, '标题')
    return await this.run(repo, update, `更新 issue #${number}`, 'write', (provider, ref, call) => provider.updateIssue(ref, number, update, call))
  }

  async commentIssue(repo: RepoTarget, number: number, body: string, options: CallOptions = {}) {
    requireNumber(number)
    requireText(body, '评论内容')
    return await this.run(repo, options, `评论 issue #${number}`, 'write', (provider, ref, call) => provider.commentIssue(ref, number, body, call))
  }

  async listChanges(repo: RepoTarget, options: PageOptions & { readonly state?: MrState | 'all'; readonly sourceBranch?: string; readonly targetBranch?: string } = {}) {
    const query = {
      ...this.paging(options),
      state: options.state ?? 'open',
      ...options.sourceBranch === undefined ? {} : { sourceBranch: options.sourceBranch },
      ...options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch },
    }
    return await this.run(repo, options, '列出 PR/MR', 'read', (provider, ref, call) => provider.listChanges(ref, query, call))
  }

  async getChange(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number}`, 'read', (provider, ref, call) => provider.getChange(ref, number, call))
  }

  async changeDiff(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number} 的 diff`, 'read', (provider, ref, call) => provider.changeDiff(ref, number, call))
  }

  async changeStatus(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number} 的状态`, 'read', (provider, ref, call) => provider.changeStatus(ref, number, call))
  }

  /**
   * One poll of a change request for a watch; not part of the `dshRepos` service.
   * @param repo - repository target.
   * @param number - change request number.
   * @param request - what the watch already knows.
   * @param options - cancellation.
   * @returns the change request, with CI and comments when they were read.
   * @throws {RepoError} classified as every other call.
   */
  async changeActivity(repo: RepoTarget, number: number, request: ActivityRequest, options: CallOptions = {}): Promise<ChangeActivity> {
    requireNumber(number)
    return await this.run(repo, options, `检查 PR/MR #${number} 的动态`, 'read', (provider, ref, call) => provider.changeActivity(ref, number, request, call))
  }

  async listCiRuns(repo: RepoTarget, options: CiRunListOptions = {}) {
    if (options.ref !== undefined) requireBranch(options.ref, 'ref')
    if (options.sha !== undefined) requireCommit(options.sha, 'sha ')
    if (options.change !== undefined) {
      requireNumber(options.change)
      if (options.ref !== undefined || options.sha !== undefined) throw new RepoError('invalid', '按 PR/MR 列出时不能再给 ref 或 sha')
    }
    const query = {
      ...this.paging(options),
      ...options.ref === undefined ? {} : { ref: options.ref },
      ...options.sha === undefined ? {} : { sha: options.sha },
      ...options.change === undefined ? {} : { change: options.change },
      ...options.state === undefined ? {} : { state: options.state },
    }
    return await this.run(repo, options, '列出 CI 流水线', 'read', (provider, ref, call) => provider.listRuns(ref, query, call))
  }

  async getCiRun(repo: RepoTarget, runId: number, options: CallOptions & { readonly onlyFailed?: boolean } = {}) {
    requireId(runId, 'runId')
    const detail = await this.run(repo, options, `读取流水线 ${runId}`, 'read', (provider, ref, call) => provider.getRun(ref, runId, call))
    return options.onlyFailed === true ? { ...detail, jobs: detail.jobs.filter(job => job.state === 'failure') } : detail
  }

  /**
   * Failed jobs of a CI run, for a watch's CI failure message; not part of the `dshRepos` service.
   * @param repo - repository target.
   * @param runId - run id.
   * @param options - cancellation.
   * @returns the failed jobs.
   * @throws {RepoError} classified as every other call.
   */
  async failedCiJobs(repo: RepoTarget, runId: number, options: CallOptions = {}): Promise<CiJob[]> {
    requireId(runId, 'runId')
    return await this.run(repo, options, `读取流水线 ${runId} 的失败作业`, 'read', (provider, ref, call) => provider.failedJobs(ref, runId, call))
  }

  async ciJobLog(repo: RepoTarget, jobId: number, options: CiLogOptions = {}): Promise<CiJobLog> {
    requireId(jobId, 'jobId')
    const search = (options.search ?? []).map(term => term.trim()).filter(term => term !== '')
    if (search.length > MAX_LOG_SEARCH) throw new RepoError('invalid', `搜索词最多 ${MAX_LOG_SEARCH} 个`)
    if (search.some(term => term.length > MAX_LOG_TERM)) throw new RepoError('invalid', `每个搜索词最多 ${MAX_LOG_TERM} 个字符`)
    const context = options.context ?? LOG_CONTEXT.default
    if (!Number.isSafeInteger(context) || context < 0 || context > LOG_CONTEXT.max) throw new RepoError('invalid', `context 必须在 0 到 ${LOG_CONTEXT.max} 之间：${context}`)
    if (options.beforeLine !== undefined) {
      requireId(options.beforeLine, 'beforeLine')
      if (search.length > 0) throw new RepoError('invalid', 'beforeLine 只用于读取日志末尾，不能和 search 一起用')
    }
    const section = options.section?.trim()
    if (section !== undefined && (section === '' || section.length > MAX_LOG_TERM)) throw new RepoError('invalid', `section 不能为空，最多 ${MAX_LOG_TERM} 个字符`)
    return await this.run(repo, options, `读取作业 ${jobId} 的日志`, 'read', async (provider, ref, call) => {
      const { job, body } = await provider.jobLog(ref, jobId, call)
      const excerpt = await readLog(body, {
        search,
        context,
        ...section === undefined ? {} : { section },
        ...options.beforeLine === undefined ? {} : { beforeLine: options.beforeLine },
        maxBytes: call.limits.maxLogBytes,
      }, call.signal)
      return { job, ...excerpt }
    })
  }

  async retryCi(repo: RepoTarget, target: CiTarget, options: CallOptions = {}): Promise<CiActionResult> {
    const { kind, id, label } = ciTarget(target)
    return await this.run(repo, options, `重试${label}`, 'write', (provider, ref, call) => kind === 'run' ? provider.retryRun(ref, id, call) : provider.retryJob(ref, id, call))
  }

  async cancelCi(repo: RepoTarget, target: CiTarget, options: CallOptions = {}): Promise<CiActionResult> {
    const { kind, id, label } = ciTarget(target)
    return await this.run(repo, options, `取消${label}`, 'write', (provider, ref, call) => kind === 'run' ? provider.cancelRun(ref, id, call) : provider.cancelJob(ref, id, call))
  }

  async createChange(repo: RepoTarget, change: MrCreateFields) {
    requireText(change.title, '标题')
    requireBranch(change.sourceBranch, '源分支名')
    if (change.targetBranch !== undefined) requireBranch(change.targetBranch, '目标分支名')
    return await this.run(repo, change, '创建 PR/MR', 'write', async (provider, ref, call) => {
      const targetBranch = change.targetBranch ?? (await provider.repoInfo(ref, call)).defaultBranch
      if (targetBranch === change.sourceBranch) throw new RepoError('invalid', '源分支和目标分支不能相同')
      const { signal: _signal, ...fields } = change
      return await provider.createChange(ref, { ...fields, targetBranch, draft: change.draft === true, deleteSourceBranch: change.deleteSourceBranch === true }, call)
    })
  }

  async updateChange(repo: RepoTarget, number: number, update: MrUpdateFields) {
    requireNumber(number)
    if (update.title !== undefined) requireText(update.title, '标题')
    if (update.targetBranch !== undefined) requireBranch(update.targetBranch, '目标分支名')
    return await this.run(repo, update, `更新 PR/MR #${number}`, 'write', (provider, ref, call) => provider.updateChange(ref, number, update, call))
  }

  async commentChange(repo: RepoTarget, number: number, body: string, options: CallOptions = {}) {
    requireNumber(number)
    requireText(body, '评论内容')
    return await this.run(repo, options, `评论 PR/MR #${number}`, 'write', (provider, ref, call) => provider.commentChange(ref, number, body, call))
  }

  async mergeChange(repo: RepoTarget, number: number, options: MergeFields) {
    requireNumber(number)
    requireCommit(options.headSha.toLowerCase(), 'headSha ')
    const request = { headSha: options.headSha, ...options.method === undefined ? {} : { method: options.method }, deleteSourceBranch: options.deleteSourceBranch === true }
    return await this.run(repo, options, `合并 PR/MR #${number}`, 'merge', (provider, ref, call) => provider.mergeChange(ref, number, request, call))
  }

  async deleteMergedBranch(repo: RepoTarget, branch: string, options: CallOptions = {}): Promise<MergedBranchDeletion> {
    requireBranch(branch, '分支名')
    return await this.run(repo, options, `删除分支 ${branch}`, 'write', async (provider, ref, call) => {
      // The hosts' branch deletion takes no expected commit, so the head is read last, right before the deletion, to keep the window for a concurrent push small.
      const changes = await allChangesFrom(provider, ref, branch, call)
      const head = await provider.getBranch(ref, branch, call)
      if (head === undefined) throw new RepoError('not-found', `没有分支 ${branch}`)
      if (head.default) throw new RepoError('forbidden', `${branch} 是默认分支，不能删除`)
      if (head.protected) throw new RepoError('forbidden', `${branch} 是受保护分支，不能删除`)
      const open = changes.find(change => change.state === 'open')
      if (open !== undefined) throw new RepoError('conflict', `${branch} 还是打开中的 PR/MR #${open.number} 的源分支，不能删除`)
      const merged = changes.find(change => change.state === 'merged' && change.headSha === head.commit)
      if (merged === undefined) throw new RepoError('conflict', `${branch} 的最新提交 ${head.commit.slice(0, 12)} 没有通过已合并的 PR/MR 合入，可能还有没合入的工作，不删除`)
      await provider.deleteBranch(ref, branch, call)
      return { branch, commit: head.commit, mr: { number: merged.number, webUrl: merged.webUrl } }
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
    return { dir: this.mirrors.root, ...this.mirrorProblem === undefined ? {} : { problem: this.mirrorProblem } }
  }

  async setMirrorDir(dir: string | undefined): Promise<MirrorSettings> {
    const target = dir === undefined ? undefined : checkMirrorDir(dir, this.forbiddenMirrorRoots)
    if (target !== undefined) {
      try {
        await mkdir(target, { recursive: true })
        await access(target, constants.W_OK)
      } catch (error) {
        throw new RepoError('invalid', `无法创建或写入镜像目录 ${target}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.hosts.setMirrorDir(target)
    this.mirrors.setRoot(target)
    this.mirrorProblem = undefined
    this.emitHostsChange({ kind: 'mirror', dir: target })
    return this.mirrorSettings()
  }

  /**
   * Disk usage of the current mirror directory.
   * @returns each mirror with its address and last fetch, the snapshots, and the totals.
   * @throws {RepoError} `unavailable` when the directory cannot be read.
   */
  async mirrorUsage(): Promise<MirrorUsage> {
    return await this.mirrors.usage()
  }

  /**
   * Clone or fetch the mirror of a catalog address and resolve a branch head.
   * @param url - catalog address.
   * @param options - branch (default: the remote's default branch) and cancellation.
   * @returns the mirror state.
   * @throws {RepoError} `not-allowed` outside the catalog, `unavailable` while no mirror directory is set, and the mirror's failures.
   */
  async syncMirror(url: string, options: { readonly branch?: string; readonly signal?: AbortSignal } = {}): Promise<MirrorState> {
    const env = await this.mirrorAuth(url)
    return await this.mirrors.sync(url, options.branch, env, options.signal)
  }

  /**
   * Whether an address is served by a configured host, so its API is reachable.
   * @param url - accepted git address.
   * @returns false for local paths, `file:` URLs, and unconfigured hosts.
   */
  gitHost(url: string): boolean {
    return !isAbsolute(url) && !url.startsWith('file:') && hostOf(url, this.hosts.all()) !== undefined
  }

  /**
   * Credentials git uses to reach a catalog address under a configured host.
   * @param url - accepted git address in the catalog.
   * @returns the credentials, or undefined for a local path or `file:` URL.
   * @throws {RepoError} `not-allowed` without a configured host, `unauthenticated` without a token.
   */
  async gitCredentials(url: string): Promise<HostGitCredentials | undefined> {
    if (isAbsolute(url) || url.startsWith('file:')) return undefined
    const spec = hostOf(url, this.hosts.all())
    if (spec === undefined) throw new RepoError('not-allowed', `${url} 不属于已配置的主机`)
    return { hostUrl: spec.url, username: gitUsername(spec.kind), token: await this.token(spec) }
  }

  /**
   * Environment of a mirror's or workspace's network commands: the host's
   * token for an address under a configured host, nothing for a local path.
   * @param url - accepted git address.
   * @param push - whether the command writes, which needs `write` access.
   * @throws {RepoError} `invalid` for an unsupported address, `not-allowed` outside the catalog or below the access the command needs, `unauthenticated` when the host's token is unset.
   */
  async mirrorAuth(url: string, push = false): Promise<Record<string, string>> {
    this.mirrors.dirOf(url)
    this.catalog.require(url, push ? 'write' : 'read')
    const credentials = await this.gitCredentials(url)
    return credentials === undefined ? {} : credentialEnvironment(credentials.hostUrl, credentials.username, credentials.token)
  }

  /**
   * Commit identity of the token account of the host `url` belongs to; read
   * once per token value.
   * @param url - accepted git address under a configured host.
   * @param signal - caller cancellation of the wait.
   * @returns the identity, or `undefined` for a local address.
   * @throws {RepoError} classified failure of the host's current-user API.
   */
  async tokenIdentity(url: string, signal: AbortSignal | undefined): Promise<CommitAuthor | undefined> {
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

  /**
   * Resolve a target and require it in the catalog.
   * @throws {RepoError} `invalid` for an unreadable target, `not-allowed` without a host, outside the catalog, or below `level`.
   */
  private target(repo: RepoTarget, level: RepoAccess = 'read'): ResolvedTarget {
    const resolved = resolveTarget(repo, this.hosts.all())
    this.catalog.require(repo, level)
    return resolved
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

  private async run<T>(repo: RepoTarget, options: CallOptions, what: string, level: RepoAccess, body: (provider: Provider, ref: RepoRef, call: Call) => Promise<T>): Promise<T> {
    const { spec, ...ref } = this.target(repo, level)
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
