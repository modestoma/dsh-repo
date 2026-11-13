/**
 * GitLab provider on `@gitbeaker/rest`, the TypeScript SDK GitLab's
 * documentation lists: gitlab.com and self-managed instances, including ones
 * served under a path prefix. Merge requests are this module's PRs/MRs;
 * issue and merge request numbers are project-scoped IIDs. {@link gitlabForge}
 * is the family's adapter.
 *
 * @module dsh-repo/providers/gitlab
 */

import { Gitlab } from '@gitbeaker/rest'
import type {
  BranchInfo, MrDiff, MrDiscussion, MrDiscussionResolveResult, MrInfo, MrState, MrStatus, CheckInfo, CiActionResult, CiFailure, CiJob, CiRun, CiRunDetail, CiState, CiTestCounts,
  CommentInfo, CommitAuthor, CommitInfo, DiffPosition, DiscussionNote, DraftInlineComment, IssueInfo, Page, RepoInfo, RepoRef, RepoUser, ReviewVerdict, SourceBranchDeletion, TreeEntry,
} from '../contract.ts'
import { RepoError } from '../errors.ts'
import { forgeKindInfo } from '../settings/contract.ts'
import { capFailures, composeReviewBody, errorText, joinRepoPath, nextPage, okBody, pathSegments, titleOf, truncateBytes } from './types.ts'
import type { ActivityItem, ActivityRequest, Call, ForgeAdapter, MrActivity, MrReplyOutcome, MrReviewOutcome, MrReviewRequest, CiRunQuery, Paging, Provider, TokenSource } from './types.ts'

/** GitLab's maximum page size. */
const MAX_PAGE = 100
/** Pages of notes read for one watch poll. */
const MAX_NOTE_PAGES = 10
/** Pages of jobs read for one pipeline. */
const MAX_JOB_PAGES = 10

/** Prefix GitLab uses to mark a draft merge request in its title. */
const DRAFT_PREFIX = 'Draft: '

interface GitlabUser { readonly username: string; readonly web_url?: string }

function user(value: GitlabUser | null | undefined): RepoUser {
  return value === null || value === undefined ? { username: 'ghost' } : { username: value.username, ...value.web_url === undefined ? {} : { webUrl: value.web_url } }
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return labels.map(label => typeof label === 'string' ? label : typeof label === 'object' && label !== null && 'name' in label ? String(label.name) : '').filter(name => name !== '')
}

interface GitlabIssue {
  readonly iid: number
  readonly title: string
  readonly description?: string | null
  readonly state: string
  readonly author: GitlabUser
  readonly labels?: unknown
  readonly assignees?: readonly GitlabUser[] | null
  readonly created_at: string
  readonly updated_at: string
  readonly web_url: string
}

function issue(value: GitlabIssue): IssueInfo {
  return {
    number: value.iid,
    title: value.title,
    body: value.description ?? '',
    state: value.state === 'closed' ? 'closed' : 'open',
    author: user(value.author),
    labels: labelNames(value.labels),
    assignees: (value.assignees ?? []).map(user),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    webUrl: value.web_url,
  }
}

interface GitlabMergeRequest extends GitlabIssue {
  readonly draft?: boolean
  readonly work_in_progress?: boolean
  readonly source_branch: string
  readonly target_branch: string
  readonly sha: string
  readonly source_project_id?: number
  readonly target_project_id?: number
  readonly should_remove_source_branch?: boolean | null
  readonly force_remove_source_branch?: boolean | null
  readonly diff_refs?: { readonly base_sha: string; readonly head_sha: string; readonly start_sha: string } | null
}

/** Whether a merge request comes from a fork. */
function fromFork(value: GitlabMergeRequest): boolean {
  return value.source_project_id !== undefined && value.source_project_id !== value.target_project_id
}

function mergeRequest(value: GitlabMergeRequest): MrInfo {
  const state: MrState = value.state === 'merged' ? 'merged' : value.state === 'opened' ? 'open' : 'closed'
  return {
    ...issue(value),
    state,
    draft: value.draft === true || value.work_in_progress === true,
    sourceBranch: value.source_branch,
    targetBranch: value.target_branch,
    headSha: value.sha,
  }
}

interface GitlabNote {
  readonly id: number
  readonly body: string
  readonly author: GitlabUser
  readonly created_at: string
  readonly system?: boolean
  readonly position?: { readonly new_path?: string | null } | null
}

/**
 * The activity of one note: user notes are comments; GitLab records approvals
 * and requested changes as system notes with fixed English bodies; other
 * system notes are not activity.
 */
function noteKind(value: GitlabNote): ActivityItem['kind'] | undefined {
  if (value.system !== true) return 'comment'
  if (value.body === 'approved this merge request') return 'approved'
  if (value.body.startsWith('requested changes')) return 'changes-requested'
  return undefined
}

interface GitlabMergeStatus {
  readonly sha: string
  readonly head_pipeline?: { readonly id: number; readonly status: string; readonly web_url?: string } | null
  readonly detailed_merge_status?: unknown
}

function statusOf(data: GitlabMergeStatus): MrStatus {
  const pipeline = data.head_pipeline
  const checks: CheckInfo[] = pipeline === undefined || pipeline === null
    ? []
    : [{ name: `pipeline #${pipeline.id}`, state: pipelineState(pipeline.status), ...pipeline.web_url === undefined ? {} : { webUrl: pipeline.web_url }, runId: pipeline.id }]
  const detailed = data.detailed_merge_status
  return {
    headSha: data.sha,
    checks,
    overall: checks[0]?.state ?? 'none' as const,
    ...typeof detailed !== 'string' || COMPUTING.has(detailed) ? {} : { mergeable: detailed === 'mergeable' },
  }
}

function note(value: GitlabNote): CommentInfo {
  return { id: String(value.id), author: user(value.author), body: value.body, createdAt: value.created_at }
}

interface GitlabDiscussionPosition {
  readonly position_type?: string
  readonly new_path?: string | null
  readonly old_path?: string | null
  readonly new_line?: number | string | null
  readonly old_line?: number | string | null
}

function lineNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

interface GitlabDiscussionNote {
  readonly id: number
  readonly body: string
  readonly author: GitlabUser
  readonly created_at: string
  readonly updated_at?: string | null
  readonly system?: boolean
  readonly resolvable?: boolean
  readonly resolved?: boolean
  readonly resolved_by?: GitlabUser | string | null
  readonly position?: GitlabDiscussionPosition | null
}

interface GitlabDiscussion {
  readonly id: string
  readonly individual_note?: boolean
  readonly notes?: readonly GitlabDiscussionNote[]
}

interface GitlabDiffFile {
  readonly old_path: string
  readonly new_path: string
  readonly new_file: boolean
  readonly deleted_file: boolean
  readonly diff: string
  readonly too_large?: boolean
  readonly collapsed?: boolean
}

function isNoteResolvable(entry: GitlabDiscussionNote): boolean {
  if (typeof entry.resolvable === 'boolean') return entry.resolvable
  return typeof entry.resolved === 'boolean' || (entry.position !== undefined && entry.position !== null)
}

function discussionNote(entry: GitlabDiscussionNote, repoWebUrl: string, number: number): DiscussionNote {
  return {
    id: String(entry.id),
    author: user(entry.author),
    body: entry.body,
    createdAt: entry.created_at,
    ...typeof entry.updated_at === 'string' && entry.updated_at !== '' ? { updatedAt: entry.updated_at } : {},
    webUrl: `${repoWebUrl}/-/merge_requests/${number}#note_${entry.id}`,
  }
}

function mapDiscussion(entry: GitlabDiscussion, repoWebUrl: string, number: number): MrDiscussion | undefined {
  const userNotes = (entry.notes ?? []).filter(item => item.system !== true)
  const first = userNotes[0]
  if (first === undefined) return undefined
  const pos = first.position
  const path = pos?.new_path ?? pos?.old_path ?? undefined
  const inline = typeof path === 'string' && path !== ''
  const newLine = lineNumber(pos?.new_line)
  const oldLine = lineNumber(pos?.old_line)
  const position: DiffPosition | undefined = inline
    ? {
      path,
      ...newLine === undefined ? {} : { newLine },
      ...oldLine === undefined ? {} : { oldLine },
    }
    : undefined
  const resolvableNotes = userNotes.filter(isNoteResolvable)
  const resolvable = resolvableNotes.length > 0
  const resolved = resolvable && resolvableNotes.every(item => item.resolved === true)
  const resolver = resolved ? resolvableNotes.find(item => item.resolved_by !== undefined && item.resolved_by !== null)?.resolved_by : undefined
  return {
    id: entry.id,
    inline,
    ...position === undefined ? {} : { position },
    resolvable,
    resolved,
    ...resolver === undefined || resolver === null ? {} : { resolvedBy: typeof resolver === 'string' ? { username: resolver } : user(resolver) },
    notes: userNotes.map(item => discussionNote(item, repoWebUrl, number)),
  }
}

function formatDiffs(files: readonly GitlabDiffFile[], maxDiffBytes: number, extraTruncated = false): MrDiff {
  // GitLab leaves `diff` empty for collapsed or oversized files; say so instead of presenting a complete diff.
  let omitted = false
  const parts = files.map((file) => {
    const from = file.new_file ? '/dev/null' : `a/${file.old_path}`
    const to = file.deleted_file ? '/dev/null' : `b/${file.new_path}`
    const skipped = file.too_large === true || (file.collapsed === true && file.diff === '')
    if (skipped) omitted = true
    return `diff --git a/${file.old_path} b/${file.new_path}\n--- ${from}\n+++ ${to}\n${skipped ? '# GitLab 未返回这个文件的 diff（文件过大或已折叠）\n' : file.diff}`
  })
  const { text, truncated } = truncateBytes(parts.join(''), maxDiffBytes)
  return { diff: text, truncated: truncated || omitted || extraTruncated }
}

function gitlabStatus(error: unknown): number | undefined {
  const status = (error as { cause?: { response?: { status?: unknown } } } | null | undefined)?.cause?.response?.status
  return typeof status === 'number' ? status : undefined
}

function pipelineState(status: string): CheckInfo['state'] {
  if (status === 'success' || status === 'skipped') return 'success'
  if (status === 'failed' || status === 'canceled') return 'failure'
  return 'pending'
}

/** Pipeline and job statuses as {@link CiState}. */
function ciState(status: string): CiState {
  switch (status) {
    case 'running': return 'running'
    case 'success': return 'success'
    case 'failed': return 'failure'
    case 'canceled':
    case 'canceling': return 'canceled'
    case 'skipped': return 'skipped'
    case 'manual': return 'manual'
    default: return 'pending'
  }
}

/** {@link CiRunQuery.state} as a GitLab pipeline status. */
const PIPELINE_STATUS = { pending: 'pending', running: 'running', success: 'success', failure: 'failed', canceled: 'canceled' } as const

interface GitlabPipeline {
  readonly id: number
  readonly project_id: number
  readonly sha: string
  readonly ref: string
  readonly status: string
  readonly source?: string
  readonly name?: unknown
  readonly created_at: string
  readonly updated_at?: string
  readonly web_url: string
}

interface GitlabPipelineDetail extends GitlabPipeline {
  readonly started_at?: string | null
  readonly finished_at?: string | null
  readonly duration?: number | null
  readonly yaml_errors?: unknown
}

function pipeline(value: GitlabPipeline): CiRun {
  return {
    id: value.id,
    ...typeof value.name === 'string' && value.name !== '' ? { name: value.name } : {},
    state: ciState(value.status),
    status: value.status,
    ref: value.ref,
    sha: value.sha,
    ...value.source === undefined ? {} : { event: value.source },
    createdAt: value.created_at,
    ...value.updated_at === undefined ? {} : { updatedAt: value.updated_at },
    webUrl: value.web_url,
  }
}

interface GitlabJob {
  readonly id: number
  readonly name: string
  readonly stage?: string
  readonly status: string
  readonly allow_failure?: boolean
  readonly failure_reason?: string | null
  readonly started_at?: string | null
  readonly finished_at?: string | null
  readonly duration?: number | null
  readonly web_url?: string
}

interface GitlabBridge extends GitlabJob {
  readonly downstream_pipeline?: { readonly id: number; readonly project_id?: number; readonly status: string; readonly web_url: string } | null
}

function job(value: GitlabJob): CiJob {
  return {
    id: value.id,
    name: value.name,
    ...value.stage === undefined ? {} : { stage: value.stage },
    state: ciState(value.status),
    status: value.status,
    allowFailure: value.allow_failure === true,
    ...typeof value.failure_reason === 'string' && value.failure_reason !== '' ? { failureReason: value.failure_reason } : {},
    ...typeof value.started_at === 'string' ? { startedAt: value.started_at } : {},
    ...typeof value.finished_at === 'string' ? { finishedAt: value.finished_at } : {},
    ...typeof value.duration === 'number' ? { durationSeconds: Math.round(value.duration) } : {},
    ...value.web_url === undefined ? {} : { webUrl: value.web_url },
  }
}

function bridge(value: GitlabBridge, projectId: number): CiJob {
  const downstream = value.downstream_pipeline
  if (downstream === undefined || downstream === null) return job(value)
  return {
    ...job(value),
    downstream: {
      id: downstream.id,
      state: ciState(downstream.status),
      status: downstream.status,
      webUrl: downstream.web_url,
      // Child pipelines run in the parent's project; without `project_id` (older GitLab) the project part of the URLs decides.
      sameRepo: downstream.project_id === undefined ? sameProjectUrl(value.web_url, downstream.web_url) : downstream.project_id === projectId,
    },
  }
}

/** Whether two GitLab web URLs belong to the same project (the part before `/-/`). */
function sameProjectUrl(a: string | undefined, b: string): boolean {
  return a !== undefined && a.split('/-/')[0] === b.split('/-/')[0]
}

interface GitlabTestCase {
  readonly status: string
  readonly name: string
  readonly classname?: string
  readonly file?: string | null
  readonly system_output?: unknown
  readonly stack_trace?: unknown
}

interface GitlabTestReport {
  readonly total_count: number
  readonly success_count: number
  readonly failed_count: number
  readonly skipped_count: number
  readonly error_count: number
  readonly test_suites?: readonly { readonly name: string; readonly test_cases?: readonly GitlabTestCase[] }[]
}

/** A test case's failure output: GitLab sends `system_output` as text, as a list of lines, or not at all. */
function testOutput(value: GitlabTestCase): string | undefined {
  for (const field of [value.system_output, value.stack_trace]) {
    if (typeof field === 'string' && field !== '') return field
    if (Array.isArray(field) && field.length > 0) return field.map(String).join('\n')
  }
  return undefined
}

function testFailures(report: GitlabTestReport): CiFailure[] {
  return (report.test_suites ?? []).flatMap(suite => (suite.test_cases ?? [])
    .filter(test => test.status === 'failed' || test.status === 'error')
    .map((test) => {
      const message = testOutput(test)
      return {
        suite: suite.name,
        name: test.classname === undefined || test.classname === '' ? test.name : `${test.classname} ${test.name}`,
        ...message === undefined ? {} : { message },
        ...typeof test.file === 'string' && test.file !== '' ? { path: test.file } : {},
      }
    }))
}

function testCounts(report: GitlabTestReport): CiTestCounts {
  return { total: report.total_count, success: report.success_count, failed: report.failed_count, skipped: report.skipped_count, error: report.error_count }
}

function jobAction(value: GitlabJob & { readonly pipeline?: { readonly id: number } }): CiActionResult {
  return {
    ...value.pipeline === undefined ? {} : { runId: value.pipeline.id },
    jobId: value.id,
    state: ciState(value.status),
    ...value.web_url === undefined ? {} : { webUrl: value.web_url },
  }
}

/** What GitLab does with the source branch of a merged merge request; GitLab itself never deletes the default or a protected branch. */
function mergedSource(value: GitlabMergeRequest): SourceBranchDeletion {
  if (value.should_remove_source_branch === true || value.force_remove_source_branch === true) return { name: value.source_branch, deleted: true }
  return { name: value.source_branch, deleted: false, reason: 'GitLab 没有接受删除源分支' }
}

/** Detailed merge statuses GitLab reports while it is still computing mergeability. */
const COMPUTING = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing'])

function paging(query: Paging): { page: number; perPage: number; maxPages: number } {
  return { page: query.page, perPage: query.perPage, maxPages: 1 }
}

/** GitLab provider bound to one host. */
export class GitlabProvider implements Provider {
  private readonly api: InstanceType<typeof Gitlab<false>>

  /**
   * @param host - instance URL, with its path prefix when it has one.
   * @param token - resolves the host's token for every request.
   * @param timeoutMs - per-request timeout; GitBeaker takes no per-call signal.
   */
  constructor(private readonly host: string, private readonly token: TokenSource, timeoutMs: number) {
    this.api = new Gitlab({ host, token, queryTimeout: timeoutMs })
  }

  async currentUser(call: Call): Promise<CommitAuthor> {
    call.signal.throwIfAborted()
    const data = await this.api.Users.showCurrentUser()
    // `commit_email` is returned for the token's own account but missing from GitBeaker's types.
    const commitEmail: unknown = data.commit_email
    const email = [commitEmail, data.email, data.public_email].find((value): value is string => typeof value === 'string' && value !== '')
    return { name: data.name, email: email ?? `${data.id}-${data.username}@users.noreply.${new URL(this.host).host}` }
  }

  async botUser(call: Call): Promise<RepoUser> {
    call.signal.throwIfAborted()
    return user(await this.api.Users.showCurrentUser())
  }

  async repoInfo(ref: RepoRef, call: Call): Promise<RepoInfo> {
    call.signal.throwIfAborted()
    const data = await this.api.Projects.show(ref.path)
    return {
      ...ref,
      webUrl: data.web_url,
      defaultBranch: data.default_branch,
      ...typeof data.description === 'string' && data.description !== '' ? { description: data.description } : {},
      visibility: data.visibility === 'internal' ? 'internal' : data.visibility === 'private' ? 'private' : 'public',
      archived: data.archived,
      cloneUrl: data.http_url_to_repo,
    }
  }

  async listBranches(ref: RepoRef, query: Paging & { search?: string }, call: Call) {
    call.signal.throwIfAborted()
    const data = await this.api.Branches.all(ref.path, { ...paging(query), ...query.search === undefined ? {} : { search: query.search } })
    const items: BranchInfo[] = data.map(branch => ({ name: branch.name, commit: String(branch.commit.id), protected: branch.protected, default: branch.default }))
    return { items, ...nextPage(query, data.length) }
  }

  async deleteBranch(ref: RepoRef, name: string, call: Call) {
    call.signal.throwIfAborted()
    await this.api.Branches.remove(ref.path, name)
  }

  async getBranch(ref: RepoRef, name: string, call: Call) {
    call.signal.throwIfAborted()
    const branch = await this.api.Branches.show(ref.path, name).catch((error: unknown) => {
      if ((error as { cause?: { response?: { status?: number } } }).cause?.response?.status === 404) return undefined
      throw error
    })
    return branch === undefined ? undefined : { name: branch.name, commit: String(branch.commit.id), protected: branch.protected, default: branch.default }
  }

  async listCommits(ref: RepoRef, query: Paging & { ref?: string; path?: string }, call: Call) {
    call.signal.throwIfAborted()
    const data = await this.api.Commits.all(ref.path, {
      ...paging(query),
      ...query.ref === undefined ? {} : { refName: query.ref },
      ...query.path === undefined ? {} : { path: query.path },
    })
    const items: CommitInfo[] = data.map(entry => ({
      sha: entry.id,
      title: entry.title ?? titleOf(entry.message),
      message: entry.message,
      authorName: entry.author_name,
      authorEmail: entry.author_email,
      authoredAt: entry.authored_date,
      webUrl: entry.web_url,
    }))
    return { items, ...nextPage(query, data.length) }
  }

  async listTree(ref: RepoRef, query: { ref?: string; path: string; recursive: boolean }, call: Call) {
    const at = query.ref ?? (await this.repoInfo(ref, call)).defaultBranch
    const max = call.limits.maxTreeEntries
    const data = await this.api.Repositories.allRepositoryTrees(ref.path, {
      ref: at,
      ...query.path === '' ? {} : { path: query.path },
      recursive: query.recursive,
      perPage: MAX_PAGE,
      maxPages: Math.floor(max / MAX_PAGE) + 1,
    })
    const entries: TreeEntry[] = data.map(entry => ({
      path: entry.path,
      type: entry.type === 'tree' ? 'dir' : entry.type === 'commit' ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'file',
    }))
    return { ref: at, entries: entries.slice(0, max), truncated: entries.length > max }
  }

  async readFile(ref: RepoRef, path: string, at: string | undefined, call: Call) {
    const target = at ?? (await this.repoInfo(ref, call)).defaultBranch
    const raw = await this.api.RepositoryFiles.showRaw(ref.path, path, target)
    const text = typeof raw === 'string' ? raw : await raw.text()
    if (text.includes('\0')) return { path, ref: target, text: '', binary: true, truncated: false }
    return { path, ref: target, binary: false, ...truncateBytes(text, call.limits.maxFileBytes) }
  }

  async listIssues(ref: RepoRef, query: Paging & { state: 'open' | 'closed' | 'all'; labels?: readonly string[]; assignee?: string; search?: string }, call: Call) {
    call.signal.throwIfAborted()
    const data = await this.api.Issues.all({
      projectId: ref.path,
      ...paging(query),
      ...query.state === 'all' ? {} : { state: query.state === 'open' ? 'opened' as const : 'closed' as const },
      ...query.labels === undefined || query.labels.length === 0 ? {} : { labels: query.labels.join(',') },
      ...query.assignee === undefined ? {} : { assigneeUsername: [query.assignee] },
      ...query.search === undefined ? {} : { search: query.search },
    })
    return { items: data.map(entry => issue(entry)), ...nextPage(query, data.length) }
  }

  async getIssue(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    const [data, notes] = await Promise.all([
      this.api.Issues.show(number, { projectId: ref.path }),
      this.api.IssueNotes.all(ref.path, number, { sort: 'asc', perPage: call.limits.maxComments, maxPages: 1 }),
    ])
    return { ...issue(data), comments: notes.filter(entry => entry.system !== true).map(note) }
  }

  async createIssue(ref: RepoRef, fields: { title: string; body?: string; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const assigneeIds = await this.userIds(fields.assignees, call)
    call.signal.throwIfAborted()
    const data = await this.api.Issues.create(ref.path, fields.title, {
      ...fields.body === undefined ? {} : { description: fields.body },
      ...fields.labels === undefined ? {} : { labels: fields.labels.join(',') },
      ...assigneeIds === undefined ? {} : { assigneeIds },
    })
    return issue(data)
  }

  async updateIssue(ref: RepoRef, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const assigneeIds = await this.userIds(update.assignees, call)
    call.signal.throwIfAborted()
    const data = await this.api.Issues.edit(ref.path, number, {
      ...update.title === undefined ? {} : { title: update.title },
      ...update.body === undefined ? {} : { description: update.body },
      ...update.state === undefined ? {} : { stateEvent: update.state === 'closed' ? 'close' as const : 'reopen' as const },
      ...update.labels === undefined ? {} : { labels: update.labels.join(',') },
      ...assigneeIds === undefined ? {} : { assigneeIds },
    })
    return issue(data)
  }

  async commentIssue(ref: RepoRef, number: number, body: string, call: Call) {
    call.signal.throwIfAborted()
    return note(await this.api.IssueNotes.create(ref.path, number, body))
  }

  async listMrs(ref: RepoRef, query: Paging & { state: MrState | 'all'; sourceBranch?: string; targetBranch?: string; sort?: 'created' | 'updated'; updatedAfter?: string }, call: Call) {
    call.signal.throwIfAborted()
    const state = query.state === 'all' ? undefined : query.state === 'open' ? 'opened' as const : query.state
    const data = await this.api.MergeRequests.all({
      projectId: ref.path,
      ...paging(query),
      ...state === undefined ? {} : { state },
      ...query.sourceBranch === undefined ? {} : { sourceBranch: query.sourceBranch },
      ...query.targetBranch === undefined ? {} : { targetBranch: query.targetBranch },
      ...query.sort === undefined ? {} : { orderBy: query.sort === 'updated' ? 'updated_at' as const : 'created_at' as const, sort: 'desc' as const },
      ...query.updatedAfter === undefined ? {} : { updatedAfter: query.updatedAfter },
    })
    const afterMs = query.updatedAfter === undefined ? undefined : Date.parse(query.updatedAfter)
    const reachedCutoff = query.sort === 'updated' && afterMs !== undefined && data.length > 0 && Date.parse(data.at(-1)!.updated_at) <= afterMs
    // A source branch names a branch of this project, as GitHub's `head=owner:branch` does; MRs from forks with the same branch name are left out.
    const visible = query.sourceBranch === undefined ? data : data.filter(entry => !fromFork(entry))
    const items = visible.map(entry => mergeRequest(entry)).filter(change => afterMs === undefined || Date.parse(change.updatedAt) > afterMs)
    return { items, ...reachedCutoff ? {} : nextPage(query, data.length) }
  }

  async getMr(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    const [data, notes] = await Promise.all([
      this.api.MergeRequests.show(ref.path, number),
      this.api.MergeRequestNotes.all(ref.path, number, { sort: 'asc', perPage: call.limits.maxComments, maxPages: 1 }),
    ])
    return { ...mergeRequest(data), comments: notes.filter(entry => entry.system !== true).map(note) }
  }

  async mrDiff(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    const files = await this.api.MergeRequests.allDiffs(ref.path, number, { perPage: MAX_PAGE })
    return formatDiffs(files, call.limits.maxDiffBytes)
  }

  async mrCompare(ref: RepoRef, baseSha: string, headSha: string, call: Call): Promise<MrDiff> {
    call.signal.throwIfAborted()
    const data = await this.api.Repositories.compare(ref.path, baseSha, headSha)
    return formatDiffs(data.diffs ?? [], call.limits.maxDiffBytes, data.compare_timeout === true)
  }

  async mrDiscussions(ref: RepoRef, number: number, query: Paging & { readonly onlyUnresolved?: boolean }, call: Call): Promise<Page<MrDiscussion>> {
    call.signal.throwIfAborted()
    if (query.onlyUnresolved !== true) {
      const raw: readonly GitlabDiscussion[] = await this.api.MergeRequestDiscussions.all(ref.path, number, paging(query))
      const items = raw.map(entry => mapDiscussion(entry, ref.webUrl, number)).filter((entry): entry is MrDiscussion => entry !== undefined)
      return { items, ...nextPage(query, raw.length) }
    }
    const needed = query.page * query.perPage + 1
    const matched: MrDiscussion[] = []
    for (let page = 1; page <= MAX_NOTE_PAGES; page += 1) {
      call.signal.throwIfAborted()
      const raw: readonly GitlabDiscussion[] = await this.api.MergeRequestDiscussions.all(ref.path, number, { page, perPage: MAX_PAGE, maxPages: 1 })
      for (const entry of raw) {
        const mapped = mapDiscussion(entry, ref.webUrl, number)
        if (mapped !== undefined && mapped.resolvable && !mapped.resolved) matched.push(mapped)
      }
      const exhausted = raw.length < MAX_PAGE
      if (matched.length >= needed || exhausted) {
        const start = (query.page - 1) * query.perPage
        const items = matched.slice(start, start + query.perPage)
        const hasMore = matched.length > start + query.perPage || !exhausted
        return { items, ...hasMore ? { nextPage: query.page + 1 } : {} }
      }
    }
    throw new RepoError('too-large', `MR !${number} 的讨论线程超过 ${MAX_NOTE_PAGES * MAX_PAGE} 条，无法完成筛选或分页`)
  }

  async mrStatus(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    return statusOf(await this.api.MergeRequests.show(ref.path, number))
  }

  /** The merge request carries its head pipeline, so CI comes with every poll; notes are read only when its `updated_at` moved. */
  async mrActivity(ref: RepoRef, number: number, request: ActivityRequest, call: Call): Promise<MrActivity> {
    call.signal.throwIfAborted()
    const data = await this.api.MergeRequests.show(ref.path, number)
    const change = mergeRequest(data)
    let items: ActivityItem[] | undefined
    if (request.updatedAt !== change.updatedAt) {
      call.signal.throwIfAborted()
      const notes = await this.notesSince(ref.path, number, request.since, call.signal)
      items = notes.filter(entry => entry.created_at >= request.since).reverse().flatMap((entry): ActivityItem[] => {
        const kind = noteKind(entry)
        if (kind === undefined) return []
        const path = entry.position?.new_path
        return [{ ...note(entry), kind, webUrl: `${change.webUrl}#note_${entry.id}`, ...typeof path === 'string' ? { path } : {} }]
      })
    }
    return { mr: change, conflict: data.has_conflicts === true, status: statusOf(data), ...items === undefined ? {} : { items } }
  }

  /**
   * Notes newest first, page by page until one predates `since`.
   * @throws RepoError `too-large` beyond {@link MAX_NOTE_PAGES} pages, so a cursor never skips unread notes.
   */
  private async notesSince(project: string, number: number, since: string, signal: AbortSignal): Promise<GitlabNote[]> {
    const notes: GitlabNote[] = []
    for (let page = 1; page <= MAX_NOTE_PAGES; page += 1) {
      signal.throwIfAborted()
      const batch: readonly GitlabNote[] = await this.api.MergeRequestNotes.all(project, number, { sort: 'desc', orderBy: 'created_at', perPage: MAX_PAGE, page })
      notes.push(...batch)
      if (batch.length < MAX_PAGE || (batch.at(-1)?.created_at ?? '') < since) return notes
    }
    throw new RepoError('too-large', `新评论超过 ${MAX_NOTE_PAGES * MAX_PAGE} 条，无法完整读取`)
  }

  async createMr(ref: RepoRef, fields: { title: string; body?: string; sourceBranch: string; targetBranch: string; draft: boolean; deleteSourceBranch: boolean; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const assigneeIds = await this.userIds(fields.assignees, call)
    call.signal.throwIfAborted()
    const title = fields.draft && !fields.title.startsWith(DRAFT_PREFIX) ? `${DRAFT_PREFIX}${fields.title}` : fields.title
    const data = await this.api.MergeRequests.create(ref.path, fields.sourceBranch, fields.targetBranch, title, {
      ...fields.body === undefined ? {} : { description: fields.body },
      ...fields.labels === undefined ? {} : { labels: fields.labels.join(',') },
      ...assigneeIds === undefined ? {} : { assigneeIds },
      ...fields.deleteSourceBranch ? { removeSourceBranch: true } : {},
    })
    return mergeRequest(data)
  }

  async updateMr(ref: RepoRef, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; targetBranch?: string; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const assigneeIds = await this.userIds(update.assignees, call)
    call.signal.throwIfAborted()
    const data = await this.api.MergeRequests.edit(ref.path, number, {
      ...update.title === undefined ? {} : { title: update.title },
      ...update.body === undefined ? {} : { description: update.body },
      ...update.state === undefined ? {} : { stateEvent: update.state === 'closed' ? 'close' as const : 'reopen' as const },
      ...update.targetBranch === undefined ? {} : { targetBranch: update.targetBranch },
      ...update.labels === undefined ? {} : { labels: update.labels.join(',') },
      ...assigneeIds === undefined ? {} : { assigneeIds },
    })
    return mergeRequest(data)
  }

  async commentMr(ref: RepoRef, number: number, body: string, call: Call) {
    call.signal.throwIfAborted()
    return note(await this.api.MergeRequestNotes.create(ref.path, number, body))
  }

  async mrReview(ref: RepoRef, number: number, request: MrReviewRequest, call: Call): Promise<MrReviewOutcome> {
    call.signal.throwIfAborted()
    const mrData: GitlabMergeRequest = await this.api.MergeRequests.show(ref.path, number)
    const remoteHead = mrData.sha
    const diffRefs = mrData.diff_refs ?? undefined
    if (
      remoteHead.toLowerCase() !== request.headSha.toLowerCase()
      || (diffRefs !== undefined && diffRefs.head_sha !== '' && diffRefs.head_sha.toLowerCase() !== request.headSha.toLowerCase())
    ) {
      throw new RepoError('conflict', `MR !${number} 的最新提交已变为 ${remoteHead.slice(0, 12)}（评审基于 ${request.headSha.slice(0, 12)}）`)
    }

    let verdict: ReviewVerdict = request.verdict
    let downgraded = false
    if (verdict !== 'comment' && request.botUsername !== undefined && mrData.author?.username !== undefined && mrData.author.username.toLowerCase() === request.botUsername.toLowerCase()) {
      verdict = 'comment'
      downgraded = true
    }

    let postedComments = 0
    const fallbacks: DraftInlineComment[] = []
    const ownCommentIds: string[] = []

    for (const item of request.comments) {
      if (diffRefs === undefined) {
        fallbacks.push(item)
        continue
      }
      call.signal.throwIfAborted()
      try {
        const created = await this.api.MergeRequestDiscussions.create(ref.path, number, item.body, {
          position: {
            positionType: 'text',
            baseSha: diffRefs.base_sha,
            startSha: diffRefs.start_sha,
            headSha: diffRefs.head_sha,
            newPath: item.path,
            oldPath: item.path,
            ...item.newLine === undefined ? {} : { newLine: String(item.newLine) },
            ...item.oldLine === undefined ? {} : { oldLine: String(item.oldLine) },
          },
        })
        postedComments += 1
        for (const entry of created.notes ?? []) ownCommentIds.push(String(entry.id))
      } catch (error) {
        const status = gitlabStatus(error)
        if (status === 400 || status === 422) {
          fallbacks.push(item)
        } else {
          throw error
        }
      }
    }

    if (verdict === 'approve') {
      call.signal.throwIfAborted()
      try {
        await this.api.MergeRequestApprovals.approve(ref.path, number, { sha: request.headSha })
      } catch (error) {
        const status = gitlabStatus(error)
        if (status === 422 || ((status === 400 || status === 403) && /author|own|cannot\s+approve/i.test(errorText(error)))) {
          verdict = 'comment'
          downgraded = true
        } else {
          throw error
        }
      }
    }

    let summary = composeReviewBody(request.body, fallbacks, request.signature)
    if (summary === undefined && downgraded && postedComments === 0) {
      summary = composeReviewBody('（自审自动降级为评论）', [], request.signature)
    }
    let webUrl: string | undefined = mrData.web_url
    if (summary !== undefined && summary !== '') {
      call.signal.throwIfAborted()
      const created = await this.api.MergeRequestNotes.create(ref.path, number, summary)
      ownCommentIds.push(String(created.id))
      webUrl = `${mrData.web_url}#note_${created.id}`
    }

    return {
      verdict,
      ...downgraded ? { downgradedVerdict: true } : {},
      postedComments,
      fallbackInlineCount: fallbacks.length,
      ...webUrl === undefined ? {} : { webUrl },
      ownCommentIds,
    }
  }

  async mrDiscussionReply(ref: RepoRef, number: number, discussionId: string, body: string, call: Call): Promise<MrReplyOutcome> {
    if (!/^[A-Za-z0-9_-]+$/.test(discussionId)) throw new RepoError('invalid', `discussionId 不合法：${discussionId}`)
    call.signal.throwIfAborted()
    const created = await this.api.MergeRequestDiscussions.addNote(ref.path, number, discussionId, body)
    const mapped = discussionNote(created, ref.webUrl, number)
    return { note: mapped, ownCommentIds: [mapped.id] }
  }

  async mrDiscussionResolve(ref: RepoRef, number: number, discussionId: string, resolved: boolean, call: Call): Promise<MrDiscussionResolveResult> {
    if (!/^[A-Za-z0-9_-]+$/.test(discussionId)) throw new RepoError('invalid', `discussionId 不合法：${discussionId}`)
    call.signal.throwIfAborted()
    const updated = await this.api.MergeRequestDiscussions.resolve(ref.path, number, discussionId, resolved)
    const userNotes = (updated.notes ?? []).filter(entry => entry.system !== true)
    const resolvableNotes = userNotes.filter(isNoteResolvable)
    const actualResolved = resolvableNotes.length > 0 ? resolvableNotes.every(entry => entry.resolved === true) : resolved
    return { discussionId: updated.id, resolved: actualResolved }
  }

  async mergeMr(ref: RepoRef, number: number, request: { headSha: string; method?: 'merge' | 'squash' | 'rebase'; deleteSourceBranch: boolean }, call: Call) {
    if (request.method === 'rebase') throw new RepoError('invalid', 'GitLab 的合并接口不支持 rebase 方式；可用 merge 或 squash')
    call.signal.throwIfAborted()
    // GitLab would also delete a fork's branch when the token may; look first so only same-project branches go.
    const fork = request.deleteSourceBranch && fromFork(await this.api.MergeRequests.show(ref.path, number))
    call.signal.throwIfAborted()
    const data = await this.api.MergeRequests.merge(ref.path, number, {
      sha: request.headSha,
      ...request.method === undefined ? {} : { squash: request.method === 'squash' },
      ...request.deleteSourceBranch && !fork ? { shouldRemoveSourceBranch: true } : {},
    })
    const sha = data.merge_commit_sha ?? data.squash_commit_sha
    const merged = typeof sha === 'string' ? { sha } : {}
    if (!request.deleteSourceBranch) return merged
    return { ...merged, sourceBranch: fork ? { name: data.source_branch, deleted: false, reason: '源分支在 fork 项目里，不删除' } : mergedSource(data) }
  }

  /** Merge request pipelines come from their own endpoint, which filters nothing, so `state` is applied to the page read. */
  async listRuns(ref: RepoRef, query: Paging & CiRunQuery, call: Call) {
    call.signal.throwIfAborted()
    const data: readonly GitlabPipeline[] = query.mr === undefined
      ? await this.api.Pipelines.all(ref.path, {
        ...paging(query),
        orderBy: 'id',
        sort: 'desc',
        ...query.ref === undefined ? {} : { ref: query.ref },
        ...query.sha === undefined ? {} : { sha: query.sha },
        ...query.state === undefined ? {} : { status: PIPELINE_STATUS[query.state] },
      })
      : await this.api.MergeRequests.allPipelines(ref.path, query.mr, paging(query))
    const runs = data.map(pipeline)
    return { items: query.mr === undefined || query.state === undefined ? runs : runs.filter(run => run.state === query.state), ...nextPage(query, data.length) }
  }

  /** Trigger jobs come from the bridges endpoint and follow the other jobs; the test report is read only for a failed pipeline. */
  async getRun(ref: RepoRef, id: number, call: Call): Promise<CiRunDetail> {
    call.signal.throwIfAborted()
    const [detail, jobs, bridges] = await Promise.all([
      this.api.Pipelines.show(ref.path, id),
      this.allJobs(ref.path, id, undefined, call.signal),
      this.api.Jobs.allPipelineBridges(ref.path, id),
    ])
    const data: GitlabPipelineDetail = detail
    const run = pipeline(data)
    let tests: CiTestCounts | undefined
    let failures: CiFailure[] = []
    let failuresError: string | undefined
    if (run.state === 'failure') {
      try {
        call.signal.throwIfAborted()
        const report: GitlabTestReport = await this.api.Pipelines.showTestReport(ref.path, id)
        if (report.total_count > 0) {
          tests = testCounts(report)
          failures = testFailures(report)
        }
      } catch (error) {
        if (call.signal.aborted) throw error
        failuresError = `读取测试报告失败：${errorText(error)}`
      }
    }
    return {
      ...run,
      ...typeof data.started_at === 'string' ? { startedAt: data.started_at } : {},
      ...typeof data.finished_at === 'string' ? { finishedAt: data.finished_at } : {},
      ...typeof data.duration === 'number' ? { durationSeconds: Math.round(data.duration) } : {},
      ...typeof data.yaml_errors === 'string' && data.yaml_errors !== '' ? { yamlErrors: data.yaml_errors } : {},
      jobs: [...jobs.items.map(job), ...bridges.map(entry => bridge(entry, data.project_id))],
      jobsTruncated: jobs.truncated,
      ...tests === undefined ? {} : { tests },
      ...capFailures(failures, call.limits),
      ...failuresError === undefined ? {} : { failuresError },
    }
  }

  async failedJobs(ref: RepoRef, runId: number, call: Call) {
    call.signal.throwIfAborted()
    const [jobs, bridges] = await Promise.all([
      this.allJobs(ref.path, runId, 'failed', call.signal),
      this.api.Jobs.allPipelineBridges(ref.path, runId, { scope: 'failed' }),
    ])
    return [...jobs.items.map(job), ...bridges.map(entry => job(entry))]
  }

  /** GitBeaker returns a job log as one string, so the trace is requested directly and streamed. */
  async jobLog(ref: RepoRef, jobId: number, call: Call) {
    call.signal.throwIfAborted()
    const data: GitlabJob = await this.api.Jobs.show(ref.path, jobId)
    call.signal.throwIfAborted()
    const response = await fetch(`${this.host}/api/v4/projects/${encodeURIComponent(ref.path)}/jobs/${jobId}/trace`, {
      headers: { 'PRIVATE-TOKEN': await this.token() },
      signal: call.signal,
    })
    return { job: job(data), body: await okBody(response) }
  }

  async retryRun(ref: RepoRef, runId: number, call: Call): Promise<CiActionResult> {
    call.signal.throwIfAborted()
    const data: GitlabPipeline = await this.api.Pipelines.retry(ref.path, runId)
    return { runId: data.id, state: ciState(data.status), webUrl: data.web_url }
  }

  /** GitLab retries a job as a new job in the same pipeline. */
  async retryJob(ref: RepoRef, jobId: number, call: Call): Promise<CiActionResult> {
    call.signal.throwIfAborted()
    return jobAction(await this.api.Jobs.retry(ref.path, jobId))
  }

  async cancelRun(ref: RepoRef, runId: number, call: Call): Promise<CiActionResult> {
    call.signal.throwIfAborted()
    const data: GitlabPipeline = await this.api.Pipelines.cancel(ref.path, runId)
    return { runId: data.id, state: ciState(data.status), webUrl: data.web_url }
  }

  async cancelJob(ref: RepoRef, jobId: number, call: Call): Promise<CiActionResult> {
    call.signal.throwIfAborted()
    return jobAction(await this.api.Jobs.cancel(ref.path, jobId))
  }

  /** Every job of a pipeline (latest attempts), at most {@link MAX_JOB_PAGES} pages. */
  private async allJobs(project: string, pipelineId: number, scope: 'failed' | undefined, signal: AbortSignal): Promise<{ items: GitlabJob[]; truncated: boolean }> {
    const items: GitlabJob[] = []
    for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
      signal.throwIfAborted()
      const batch: readonly GitlabJob[] = await this.api.Jobs.all(project, { pipelineId, ...scope === undefined ? {} : { scope }, perPage: MAX_PAGE, page, maxPages: 1 })
      items.push(...batch)
      if (batch.length < MAX_PAGE) return { items, truncated: false }
    }
    return { items, truncated: true }
  }

  /** User ids for usernames; GitLab assigns by id. */
  private async userIds(usernames: readonly string[] | undefined, call: Call): Promise<number[] | undefined> {
    if (usernames === undefined) return undefined
    const ids: number[] = []
    for (const username of usernames) {
      call.signal.throwIfAborted()
      const [found] = await this.api.Users.all({ username, maxPages: 1 })
      if (found === undefined) throw new RepoError('invalid', `GitLab 上没有用户 ${username}`)
      ids.push(found.id)
    }
    return ids
  }
}

/** The GitLab family: repositories are `group/project` with any number of groups, git authenticates as `oauth2`. */
export const gitlabForge: ForgeAdapter = {
  kind: 'gitlab',
  title: forgeKindInfo('gitlab').label,
  gitUsername: 'oauth2',
  pathHint: 'group/project（可有多级 group）',
  // GitBeaker appends `/api/v4` itself.
  apiBaseUrl: host => host.url,
  repoPath: (rest) => {
    let segments = pathSegments(rest)
    const marker = segments.indexOf('-')
    if (marker >= 0) segments = segments.slice(0, marker)
    return segments.length >= 2 ? joinRepoPath(segments) : undefined
  },
  mrLabel: number => `MR !${number}`,
  createProvider: (spec, token, timeoutMs) => new GitlabProvider(gitlabForge.apiBaseUrl(spec), token, timeoutMs),
}
