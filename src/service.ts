/**
 * The `dshRepos` service: resolves each target against the configured hosts
 * and repositories, validates arguments, attaches the call deadline, delegates
 * to the host family's provider, and turns every failure into a
 * {@link RepoError}.
 *
 * Tokens are read through `ctx.credentials` on every request, so a rotated
 * token takes effect without a reload.
 *
 * @module dsh-repo/service
 */

import type {
  CallOptions, ChangeCreate, ChangeListOptions, ChangeUpdate, CommitRequest, DshRepoService, IssueCreate, IssueListOptions, IssueUpdate,
  MergeOptions, PageOptions, RepoRef, RepoTarget,
} from './contract.ts'
import { apiBaseUrl } from './config.ts'
import type { HostSpec, RepoConfig } from './config.ts'
import { RepoError, toRepoError } from './errors.ts'
import type { HostCredentials } from './host.ts'
import { GithubProvider } from './providers/github.ts'
import { GitlabProvider } from './providers/gitlab.ts'
import type { Call, Paging, Provider } from './providers/types.ts'
import { resolveTarget } from './target.ts'
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

/** The service implementation. */
export class RepoService implements DshRepoService {
  readonly version = 1 as const
  private readonly providers = new Map<string, Provider>()

  /**
   * @param config - validated configuration.
   * @param credentials - DSH credential store; tokens are resolved per request.
   * @param factory - provider factory.
   */
  constructor(
    private readonly config: RepoConfig,
    private readonly credentials: HostCredentials,
    private readonly factory: ProviderFactory = defaultProviderFactory,
  ) {}

  /** Whether any host is configured. */
  get configured(): boolean {
    return this.config.hosts.length > 0
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

  async commitFiles(repo: RepoTarget, request: CommitRequest) {
    requireBranch(request.branch, '分支名')
    if (request.base !== undefined) requireBranch(request.base, '起点分支名')
    if (request.baseSha !== undefined) {
      if (request.base !== undefined) throw new RepoError('invalid', 'base 和 baseSha 只能给一个')
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.baseSha)) throw new RepoError('invalid', `起点提交必须是完整的十六进制提交 id：${request.baseSha}`)
    }
    requireText(request.message, '提交说明')
    if (request.author !== undefined) {
      if (!/^[^<>\n]+$/.test(request.author.name.trim())) throw new RepoError('invalid', '提交作者名不能为空，也不能包含 < > 或换行')
      if (!/^[^<>\s]+$/.test(request.author.email.trim())) throw new RepoError('invalid', '提交作者邮箱不能为空，也不能包含 < > 或空白')
    }
    if (request.files.length === 0) throw new RepoError('invalid', '提交至少要包含一个文件')
    if (request.files.length > this.config.limits.maxCommitFiles) throw new RepoError('too-large', `一次提交最多 ${this.config.limits.maxCommitFiles} 个文件`)
    const seen = new Set<string>()
    for (const file of request.files) {
      requireRepoPath(file.path, '文件路径')
      if (seen.has(file.path)) throw new RepoError('invalid', `文件重复：${file.path}`)
      seen.add(file.path)
      if (file.action === 'write' && Buffer.byteLength(file.content, 'utf8') > this.config.limits.maxFileBytes) {
        throw new RepoError('too-large', `${file.path} 超过单文件上限 ${this.config.limits.maxFileBytes} 字节`)
      }
    }
    const fields = {
      branch: request.branch,
      message: request.message,
      files: request.files,
      ...request.base === undefined ? {} : { base: request.base },
      ...request.baseSha === undefined ? {} : { baseSha: request.baseSha },
      ...request.newBranch === true ? { newBranch: true } : {},
      ...request.author === undefined ? {} : { author: { name: request.author.name.trim(), email: request.author.email.trim() } },
    }
    return await this.run(repo, request, `提交到分支 ${request.branch}`, (provider, ref, call) => provider.commitFiles(ref, fields, call))
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
      return await provider.createChange(ref, { ...fields, targetBranch, draft: change.draft === true }, call)
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
    const request = { headSha: options.headSha, ...options.method === undefined ? {} : { method: options.method } }
    return await this.run(repo, options, `合并 PR/MR #${number}`, (provider, ref, call) => provider.mergeChange(ref, number, request, call))
  }

  private target(repo: RepoTarget): ResolvedTarget {
    return resolveTarget(repo, this.config.hosts, this.config.repos)
  }

  private paging(options: PageOptions): Paging {
    const page = options.page ?? 1
    const perPage = options.perPage ?? this.config.limits.perPage
    if (!Number.isSafeInteger(page) || page < 1) throw new RepoError('invalid', `page 必须是正整数：${page}`)
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > this.config.limits.maxPerPage) {
      throw new RepoError('invalid', `perPage 必须在 1 到 ${this.config.limits.maxPerPage} 之间：${perPage}`)
    }
    return { page, perPage }
  }

  private provider(spec: HostSpec): Provider {
    const existing = this.providers.get(spec.url)
    if (existing !== undefined) return existing
    const token = async (): Promise<string> => {
      const resolved = await this.credentials.resolve(spec.tokenRef)
      if (resolved === undefined || resolved.value === '') throw new RepoError('unauthenticated', `${spec.url} 的令牌 ${spec.tokenRef} 未设置（在 DSH 凭据库或同名环境变量中设置）`)
      return resolved.value
    }
    const created = this.factory(spec, token, this.config.timeoutMs)
    this.providers.set(spec.url, created)
    return created
  }

  private async run<T>(repo: RepoTarget, options: CallOptions, what: string, body: (provider: Provider, ref: RepoRef, call: Call) => Promise<T>): Promise<T> {
    const { spec, ...ref } = this.target(repo)
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    try {
      return await body(this.provider(spec), ref, { signal, limits: this.config.limits })
    } catch (error) {
      throw toRepoError(error, `${what}（${ref.host}/${ref.path}）`)
    }
  }
}
