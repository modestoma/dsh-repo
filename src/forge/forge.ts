/**
 * Code host API calls: each call resolves its target and requires it in the
 * repository catalog with enough access, a write also requires writes on
 * (see `dsh-repo/policy`), validates its arguments, attaches
 * the API deadline, delegates to the host's provider, and turns every failure
 * into a {@link RepoError}. Approval and `access/authorize` are not done here
 * but in the operation registry (`dsh-repo/operations`).
 *
 * @module dsh-repo/forge
 */

import { z } from 'zod'
import type {
  CallOptions, CiActionResult, CiJob, CiJobLog, DraftInlineComment, MergedBranchDeletion, MergeMethod, MrDiff, MrDiscussion, MrDiscussionResolveResult,
  MrInfo, MrState, Page, RepoAccess, RepoRef, RepoTarget, RepoUser, ReviewVerdict,
} from '../contract.ts'
import type { RepoCatalog } from '../catalog/catalog.ts'
import type { CatalogEntry } from '../catalog/entry.ts'
import { readLog } from '../ci/log.ts'
import type { RepoSettings } from '../config.ts'
import { RepoError, toRepoError } from '../errors.ts'
import type { ActivityRequest, Call, MrActivity, MrReplyOutcome, MrReviewOutcome, Paging, Provider } from '../providers/types.ts'
import { requireWritesOn } from '../policy.ts'
import { requireBranch, requireCommit } from '../refs.ts'
import type { HostRegistry } from './hosts.ts'

/** Paging as list calls pass it. */
export interface PageOptions extends CallOptions {
  readonly page?: number
  readonly perPage?: number
}

/** Filters of a CI run listing; `mr` is a pull/merge request number. */
export interface CiRunListOptions extends PageOptions {
  readonly ref?: string
  readonly sha?: string
  readonly mr?: number
  readonly state?: 'pending' | 'running' | 'success' | 'failure' | 'canceled'
}

/** A run or a job to retry or cancel. */
export type CiTarget = { readonly runId: number; readonly jobId?: undefined } | { readonly jobId: number; readonly runId?: undefined }

/** Options of {@link Forge.ciJobLog}. */
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
  /** Default: the catalog entry's baseline branch, else the remote's default branch. */
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

/** Fields of a pull/merge request review. */
export interface MrReviewFields extends CallOptions {
  readonly headSha: string
  readonly verdict: ReviewVerdict
  readonly body?: string
  readonly comments?: readonly DraftInlineComment[]
  readonly signature?: string
}

/** Most inline comments in one review call. */
const MAX_REVIEW_COMMENTS = 50
const ISO_DATETIME = z.iso.datetime({ offset: true })

function requireIsoTimestamp(value: string, label: string): void {
  if (!ISO_DATETIME.safeParse(value).success || !Number.isFinite(Date.parse(value))) {
    throw new RepoError('invalid', `${label}必须是合法的 ISO-8601 时间戳（例如 2026-11-13T00:00:00Z）：${value}`)
  }
}

/** Pages of pull/merge requests from one branch read before giving up. */
const MAX_BRANCH_MR_PAGES = 10

/** Every pull/merge request, in any state, from a branch of the repository. */
async function allMrsFrom(provider: Provider, ref: RepoRef, branch: string, call: Call): Promise<MrInfo[]> {
  const found: MrInfo[] = []
  for (let page: number | undefined = 1; page !== undefined;) {
    if (page > MAX_BRANCH_MR_PAGES) throw new RepoError('too-large', `分支 ${branch} 上的 PR/MR 超过 ${MAX_BRANCH_MR_PAGES * call.limits.maxPerPage} 个`)
    const result: Page<MrInfo> = await provider.listMrs(ref, { page, perPage: call.limits.maxPerPage, state: 'all', sourceBranch: branch }, call)
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

/** Collaborators of {@link Forge}. */
export interface ForgeDeps {
  readonly hosts: HostRegistry
  readonly catalog: RepoCatalog
  /** @returns the run-time settings now in effect, read on every call. */
  readonly settings: () => RepoSettings
}

/** Code host API calls, checked against the catalog. */
export class Forge {
  /** @param deps - hosts, catalog, and settings. */
  constructor(private readonly deps: ForgeDeps) {}

  /**
   * Resolve a target to its host without consulting the catalog.
   * @param repo - repository address, `host/path`, or PR/MR URL.
   * @returns the host kind, host, path, and web address.
   * @throws {RepoError} `invalid` for an unreadable target, `not-allowed` when no configured host serves it.
   */
  resolve(repo: RepoTarget): RepoRef {
    const { spec: _spec, ...ref } = this.deps.hosts.resolve(repo)
    return ref
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

  async listMrs(repo: RepoTarget, options: PageOptions & { readonly state?: MrState | 'all'; readonly sourceBranch?: string; readonly targetBranch?: string; readonly sort?: 'created' | 'updated'; readonly updatedAfter?: string } = {}) {
    if (options.sort !== undefined && options.sort !== 'created' && options.sort !== 'updated') {
      throw new RepoError('invalid', `sort 必须是 created 或 updated：${String(options.sort)}`)
    }
    if (options.updatedAfter !== undefined) requireIsoTimestamp(options.updatedAfter, 'updatedAfter ')
    const sort = options.sort ?? (options.updatedAfter === undefined ? undefined : 'updated')
    const query = {
      ...this.paging(options),
      state: options.state ?? 'open',
      ...options.sourceBranch === undefined ? {} : { sourceBranch: options.sourceBranch },
      ...options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch },
      ...sort === undefined ? {} : { sort },
      ...options.updatedAfter === undefined ? {} : { updatedAfter: options.updatedAfter },
    }
    return await this.run(repo, options, '列出 PR/MR', 'read', (provider, ref, call) => provider.listMrs(ref, query, call))
  }

  async getMr(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number}`, 'read', (provider, ref, call) => provider.getMr(ref, number, call))
  }

  async mrDiff(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number} 的 diff`, 'read', (provider, ref, call) => provider.mrDiff(ref, number, call))
  }

  async mrCompare(repo: RepoTarget, baseSha: string, headSha: string, options: CallOptions = {}): Promise<MrDiff> {
    requireBranch(baseSha, 'baseSha ')
    requireBranch(headSha, 'headSha ')
    return await this.run(repo, options, `比较提交 ${baseSha.slice(0, 12)}...${headSha.slice(0, 12)}`, 'read', (provider, ref, call) => provider.mrCompare(ref, baseSha, headSha, call))
  }

  async mrDiscussions(repo: RepoTarget, number: number, options: PageOptions & { readonly onlyUnresolved?: boolean } = {}): Promise<Page<MrDiscussion>> {
    requireNumber(number)
    const query = {
      ...this.paging(options),
      ...options.onlyUnresolved === undefined ? {} : { onlyUnresolved: options.onlyUnresolved },
    }
    return await this.run(repo, options, `读取 PR/MR #${number} 的讨论线程`, 'read', (provider, ref, call) => provider.mrDiscussions(ref, number, query, call))
  }

  async mrStatus(repo: RepoTarget, number: number, options: CallOptions = {}) {
    requireNumber(number)
    return await this.run(repo, options, `读取 PR/MR #${number} 的状态`, 'read', (provider, ref, call) => provider.mrStatus(ref, number, call))
  }

  /**
   * One poll of a PR/MR for a watch; not part of the `dshRepos` service.
   * @param repo - repository target.
   * @param number - PR/MR number.
   * @param request - what the watch already knows.
   * @param options - cancellation.
   * @returns the PR/MR, with CI and comments when they were read.
   * @throws {RepoError} classified as every other call.
   */
  async mrActivity(repo: RepoTarget, number: number, request: ActivityRequest, options: CallOptions = {}): Promise<MrActivity> {
    requireNumber(number)
    return await this.run(repo, options, `检查 PR/MR #${number} 的动态`, 'read', (provider, ref, call) => provider.mrActivity(ref, number, request, call))
  }

  async listCiRuns(repo: RepoTarget, options: CiRunListOptions = {}) {
    if (options.ref !== undefined) requireBranch(options.ref, 'ref')
    if (options.sha !== undefined) requireCommit(options.sha, 'sha ')
    if (options.mr !== undefined) {
      requireNumber(options.mr)
      if (options.ref !== undefined || options.sha !== undefined) throw new RepoError('invalid', '按 PR/MR 列出时不能再给 ref 或 sha')
    }
    const query = {
      ...this.paging(options),
      ...options.ref === undefined ? {} : { ref: options.ref },
      ...options.sha === undefined ? {} : { sha: options.sha },
      ...options.mr === undefined ? {} : { mr: options.mr },
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

  async createMr(repo: RepoTarget, change: MrCreateFields) {
    requireText(change.title, '标题')
    requireBranch(change.sourceBranch, '源分支名')
    if (change.targetBranch !== undefined) requireBranch(change.targetBranch, '目标分支名')
    return await this.run(repo, change, '创建 PR/MR', 'write', async (provider, ref, call, entry) => {
      const targetBranch = change.targetBranch ?? entry.base ?? (await provider.repoInfo(ref, call)).defaultBranch
      if (targetBranch === change.sourceBranch) throw new RepoError('invalid', '源分支和目标分支不能相同')
      const { signal: _signal, ...fields } = change
      return await provider.createMr(ref, { ...fields, targetBranch, draft: change.draft === true, deleteSourceBranch: change.deleteSourceBranch === true }, call)
    })
  }

  async updateMr(repo: RepoTarget, number: number, update: MrUpdateFields) {
    requireNumber(number)
    if (update.title !== undefined) requireText(update.title, '标题')
    if (update.targetBranch !== undefined) requireBranch(update.targetBranch, '目标分支名')
    return await this.run(repo, update, `更新 PR/MR #${number}`, 'write', (provider, ref, call) => provider.updateMr(ref, number, update, call))
  }

  async commentMr(repo: RepoTarget, number: number, body: string, options: CallOptions = {}) {
    requireNumber(number)
    requireText(body, '评论内容')
    return await this.run(repo, options, `评论 PR/MR #${number}`, 'write', (provider, ref, call) => provider.commentMr(ref, number, body, call))
  }

  async reviewMr(repo: RepoTarget, number: number, fields: MrReviewFields): Promise<MrReviewOutcome> {
    requireNumber(number)
    requireCommit(fields.headSha.toLowerCase(), 'headSha ')
    if (fields.verdict !== 'comment' && fields.verdict !== 'approve' && fields.verdict !== 'request-changes') {
      throw new RepoError('invalid', `verdict 必须是 comment、approve 或 request-changes：${String(fields.verdict)}`)
    }
    const comments = fields.comments ?? []
    if (comments.length > MAX_REVIEW_COMMENTS) throw new RepoError('invalid', `行级评论最多 ${MAX_REVIEW_COMMENTS} 条`)
    for (const item of comments) {
      requireRepoPath(item.path, '行级评论路径')
      requireText(item.body, '行级评论内容')
      if (item.newLine === undefined && item.oldLine === undefined) {
        throw new RepoError('invalid', `行级评论（${item.path}）至少需要提供 newLine 或 oldLine`)
      }
      if (item.newLine !== undefined) requireId(item.newLine, 'newLine ')
      if (item.oldLine !== undefined) requireId(item.oldLine, 'oldLine ')
    }
    const body = fields.body !== undefined && fields.body.trim() !== '' ? fields.body : undefined
    if (fields.verdict !== 'approve' && body === undefined && comments.length === 0) {
      throw new RepoError('invalid', `${fields.verdict} 评审至少需要提供 body 或行级 comments`)
    }
    return await this.run(repo, fields, `评审 PR/MR #${number}`, 'write', async (provider, ref, call, entry) => {
      const bot = fields.verdict === 'comment'
        ? undefined
        : await this.deps.hosts.botUser(entry.url, call.signal).catch(() => undefined)
      return await provider.mrReview(ref, number, {
        headSha: fields.headSha,
        verdict: fields.verdict,
        ...body === undefined ? {} : { body },
        comments,
        signature: fields.signature ?? '',
        ...bot === undefined ? {} : { botUsername: bot.username },
      }, call)
    })
  }

  async replyMrDiscussion(repo: RepoTarget, number: number, discussionId: string, body: string, options: CallOptions = {}): Promise<MrReplyOutcome> {
    requireNumber(number)
    requireText(discussionId, 'discussionId')
    requireText(body, '回复内容')
    return await this.run(repo, options, `回复 PR/MR #${number} 讨论线程 ${discussionId}`, 'write', (provider, ref, call) => provider.mrDiscussionReply(ref, number, discussionId, body, call))
  }

  async resolveMrDiscussion(repo: RepoTarget, number: number, discussionId: string, resolved: boolean, options: CallOptions = {}): Promise<MrDiscussionResolveResult> {
    requireNumber(number)
    requireText(discussionId, 'discussionId')
    return await this.run(repo, options, `${resolved ? '解决' : '重新打开'} PR/MR #${number} 讨论线程 ${discussionId}`, 'write', (provider, ref, call) => provider.mrDiscussionResolve(ref, number, discussionId, resolved, call))
  }

  async currentBotUser(repo: RepoTarget, options: CallOptions = {}): Promise<RepoUser> {
    const { target } = this.deps.catalog.open(repo, 'read')
    return await this.deps.hosts.botUser(target.spec.url, options.signal)
  }

  async mergeMr(repo: RepoTarget, number: number, options: MergeFields) {
    requireNumber(number)
    requireCommit(options.headSha.toLowerCase(), 'headSha ')
    const request = { headSha: options.headSha, ...options.method === undefined ? {} : { method: options.method }, deleteSourceBranch: options.deleteSourceBranch === true }
    return await this.run(repo, options, `合并 PR/MR #${number}`, 'merge', (provider, ref, call) => provider.mergeMr(ref, number, request, call))
  }

  async deleteMergedBranch(repo: RepoTarget, branch: string, options: CallOptions = {}): Promise<MergedBranchDeletion> {
    requireBranch(branch, '分支名')
    return await this.run(repo, options, `删除分支 ${branch}`, 'write', async (provider, ref, call) => {
      // The hosts' branch deletion takes no expected commit, so the head is read last, right before the deletion, to keep the window for a concurrent push small.
      const changes = await allMrsFrom(provider, ref, branch, call)
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

  private paging(options: PageOptions): Paging {
    const { limits } = this.deps.settings()
    const page = options.page ?? 1
    const perPage = options.perPage ?? limits.perPage
    if (!Number.isSafeInteger(page) || page < 1) throw new RepoError('invalid', `page 必须是正整数：${page}`)
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > limits.maxPerPage) {
      throw new RepoError('invalid', `perPage 必须在 1 到 ${limits.maxPerPage} 之间：${perPage}`)
    }
    return { page, perPage }
  }

  private async run<T>(repo: RepoTarget, options: CallOptions, what: string, level: RepoAccess, body: (provider: Provider, ref: RepoRef, call: Call, entry: CatalogEntry) => Promise<T>): Promise<T> {
    const settings = this.deps.settings()
    if (level !== 'read') requireWritesOn(settings, what)
    const { entry, target } = this.deps.catalog.open(repo, level)
    const { spec, ...ref } = target
    const deadline = AbortSignal.timeout(settings.timeoutMs)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    try {
      return await body(this.deps.hosts.provider(spec), ref, { signal, limits: settings.limits }, entry)
    } catch (error) {
      throw toRepoError(error, `${what}（${ref.host}/${ref.path}）`)
    }
  }
}
