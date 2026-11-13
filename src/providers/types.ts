/**
 * The per-family provider interface the service delegates to after resolving
 * a target, normalizing paging, and attaching the call deadline, and the
 * adapter that holds everything else that differs between code host
 * families.
 *
 * @module dsh-repo/providers/types
 */

import type {
  BranchInfo, MrDetail, CommitAuthor, MrDiff, MrDiscussion, MrDiscussionResolveResult, MrInfo, MrReviewResult, MrState, MrStatus, CiActionResult, CiJob, CiRun, CiRunDetail,
  CommentInfo, CommitInfo, DiscussionNote, DraftInlineComment, FileContent, IssueDetail, IssueInfo, IssueState, MergeMethod, MergeResult, Page, RepoInfo, RepoRef, RepoUser,
  ReviewVerdict, TreeListing,
} from '../contract.ts'
import type { HostSpec, RepoLimits } from '../config.ts'

/** Per-call input every provider method receives. */
export interface Call {
  /** Combined caller cancellation and configured deadline. */
  readonly signal: AbortSignal
  readonly limits: RepoLimits
}

/** Normalized paging. */
export interface Paging {
  readonly page: number
  readonly perPage: number
}

/** Filters of a CI run listing after validation; `mr` is a pull/merge request number. */
export interface CiRunQuery {
  readonly ref?: string
  readonly sha?: string
  readonly mr?: number
  readonly state?: 'pending' | 'running' | 'success' | 'failure' | 'canceled'
}

/** Validated review payload passed to a provider. */
export interface MrReviewRequest {
  readonly headSha: string
  readonly verdict: ReviewVerdict
  readonly body?: string
  readonly comments: readonly DraftInlineComment[]
  readonly signature: string
  /** Current token's username when known, for proactive self-review detection. */
  readonly botUsername?: string
}

/** Provider review outcome, with posted comment ids so watches ignore own reviews. */
export interface MrReviewOutcome extends MrReviewResult {
  readonly ownCommentIds?: readonly string[]
}

/** Provider thread reply outcome, with extra ids for watch suppression. */
export interface MrReplyOutcome {
  readonly note: DiscussionNote
  readonly ownCommentIds?: readonly string[]
}

/** One code host family. Methods throw SDK errors or {@link RepoError}; the service classifies them. */
export interface Provider {
  /** Commit identity of the account that owns the token. */
  currentUser(call: Call): Promise<CommitAuthor>
  /** Host user of the account that owns the token. */
  botUser(call: Call): Promise<RepoUser>
  repoInfo(ref: RepoRef, call: Call): Promise<RepoInfo>
  getBranch(ref: RepoRef, name: string, call: Call): Promise<BranchInfo | undefined>
  listBranches(ref: RepoRef, query: Paging & { readonly search?: string }, call: Call): Promise<Page<BranchInfo>>
  /** Delete a branch; the service has already checked it may go. */
  deleteBranch(ref: RepoRef, name: string, call: Call): Promise<void>
  listCommits(ref: RepoRef, query: Paging & { readonly ref?: string; readonly path?: string }, call: Call): Promise<Page<CommitInfo>>
  listTree(ref: RepoRef, query: { readonly ref?: string; readonly path: string; readonly recursive: boolean }, call: Call): Promise<TreeListing>
  readFile(ref: RepoRef, path: string, at: string | undefined, call: Call): Promise<FileContent>

  listIssues(ref: RepoRef, query: Paging & { readonly state: IssueState | 'all'; readonly labels?: readonly string[]; readonly assignee?: string; readonly search?: string }, call: Call): Promise<Page<IssueInfo>>
  getIssue(ref: RepoRef, number: number, call: Call): Promise<IssueDetail>
  createIssue(ref: RepoRef, issue: IssueFields & { readonly title: string }, call: Call): Promise<IssueInfo>
  updateIssue(ref: RepoRef, number: number, update: IssueFields & { readonly state?: IssueState }, call: Call): Promise<IssueInfo>
  commentIssue(ref: RepoRef, number: number, body: string, call: Call): Promise<CommentInfo>

  listMrs(ref: RepoRef, query: Paging & { readonly state: MrState | 'all'; readonly sourceBranch?: string; readonly targetBranch?: string; readonly sort?: 'created' | 'updated'; readonly updatedAfter?: string }, call: Call): Promise<Page<MrInfo>>
  getMr(ref: RepoRef, number: number, call: Call): Promise<MrDetail>
  mrDiff(ref: RepoRef, number: number, call: Call): Promise<MrDiff>
  mrCompare(ref: RepoRef, baseSha: string, headSha: string, call: Call): Promise<MrDiff>
  mrDiscussions(ref: RepoRef, number: number, query: Paging & { readonly onlyUnresolved?: boolean }, call: Call): Promise<Page<MrDiscussion>>
  mrStatus(ref: RepoRef, number: number, call: Call): Promise<MrStatus>
  createMr(ref: RepoRef, change: IssueFields & { readonly title: string; readonly sourceBranch: string; readonly targetBranch: string; readonly draft: boolean; readonly deleteSourceBranch: boolean }, call: Call): Promise<MrInfo>
  updateMr(ref: RepoRef, number: number, update: IssueFields & { readonly state?: 'open' | 'closed'; readonly targetBranch?: string }, call: Call): Promise<MrInfo>
  commentMr(ref: RepoRef, number: number, body: string, call: Call): Promise<CommentInfo>
  mrReview(ref: RepoRef, number: number, request: MrReviewRequest, call: Call): Promise<MrReviewOutcome>
  mrDiscussionReply(ref: RepoRef, number: number, discussionId: string, body: string, call: Call): Promise<MrReplyOutcome>
  mrDiscussionResolve(ref: RepoRef, number: number, discussionId: string, resolved: boolean, call: Call): Promise<MrDiscussionResolveResult>
  /** With `deleteSourceBranch`, the result reports the source branch; a failed deletion does not throw. */
  mergeMr(ref: RepoRef, number: number, request: { readonly headSha: string; readonly method?: MergeMethod; readonly deleteSourceBranch: boolean }, call: Call): Promise<MergeResult>
  /** One poll for a watch: always the PR/MR, CI and comments only as `request` asks. */
  mrActivity(ref: RepoRef, number: number, request: ActivityRequest, call: Call): Promise<MrActivity>

  listRuns(ref: RepoRef, query: Paging & CiRunQuery, call: Call): Promise<Page<CiRun>>
  /** The run with every job; failures are read only for a failed run. */
  getRun(ref: RepoRef, id: number, call: Call): Promise<CiRunDetail>
  /** Failed jobs of a run, for a watch's CI failure message. */
  failedJobs(ref: RepoRef, runId: number, call: Call): Promise<CiJob[]>
  /** The job and its raw log; the caller reads the stream before the call's deadline. */
  jobLog(ref: RepoRef, jobId: number, call: Call): Promise<{ readonly job: CiJob; readonly body: ReadableStream<Uint8Array> }>
  retryRun(ref: RepoRef, runId: number, call: Call): Promise<CiActionResult>
  retryJob(ref: RepoRef, jobId: number, call: Call): Promise<CiActionResult>
  cancelRun(ref: RepoRef, runId: number, call: Call): Promise<CiActionResult>
  cancelJob(ref: RepoRef, jobId: number, call: Call): Promise<CiActionResult>
}

/**
 * Cut each failure message to an equal share of the log limit and keep at
 * most `maxCiFailures` failures.
 * @param failures - every failure read, in report order.
 * @param limits - the configured limits.
 * @returns the kept failures and whether any were left out.
 */
export function capFailures<T extends { readonly message?: string }>(failures: readonly T[], limits: Pick<RepoLimits, 'maxLogBytes' | 'maxCiFailures'>): { failures: T[]; failuresTruncated: boolean } {
  const share = Math.max(1, Math.floor(limits.maxLogBytes / limits.maxCiFailures))
  const kept = failures.slice(0, limits.maxCiFailures).map((failure) => {
    if (failure.message === undefined) return failure
    const { text, truncated } = truncateBytes(failure.message, share)
    return { ...failure, message: truncated ? `${text}…` : text }
  })
  return { failures: kept, failuresTruncated: failures.length > kept.length }
}

/**
 * A raw HTTP failure from a request made without an SDK, classified like an
 * Octokit error (`name` is `HttpError`).
 */
export class HttpStatusError extends Error {
  override readonly name = 'HttpError'

  /**
   * @param status - HTTP status.
   * @param message - the host's message.
   */
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * The body of a successful response.
 * @param response - the response.
 * @returns its body stream.
 * @throws {HttpStatusError} for a status outside 200–299 or a missing body.
 */
export async function okBody(response: Response): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok) {
    const text = await response.text().catch((error: unknown) => errorText(error))
    throw new HttpStatusError(response.status, text.slice(0, 500))
  }
  if (response.body === null) throw new HttpStatusError(response.status, '响应没有内容')
  return response.body
}

/** What a watch already knows about a PR/MR, so a poll reads only what may have changed. */
export interface ActivityRequest {
  /** `updatedAt` of the last poll; comments and reviews are read only when the PR/MR's differs. */
  readonly updatedAt?: string
  /** Whether CI is read: the head moved, CI was still running, or CI had not reported yet. */
  readonly withStatus: boolean
  /** Comments and reviews created before this time are left out. */
  readonly since: string
}

/** One comment, review comment, or review on a PR/MR, in creation order. */
export interface ActivityItem {
  readonly id: string
  /** `comment` covers conversation comments, code-line comments, and reviews that only comment. */
  readonly kind: 'comment' | 'approved' | 'changes-requested'
  readonly author: RepoUser
  readonly body: string
  readonly createdAt: string
  readonly webUrl?: string
  /** File of a code-line comment. */
  readonly path?: string
}

/** One poll of a PR/MR. */
export interface MrActivity {
  readonly mr: MrInfo
  /** Whether the PR/MR conflicts with its target branch. */
  readonly conflict: boolean
  /** Present when CI was read. */
  readonly status?: MrStatus
  /** Present when comments and reviews were read: those created at or after `since`, oldest first. */
  readonly items?: readonly ActivityItem[]
}

/** Editable fields shared by issues and PRs/MRs. */
export interface IssueFields {
  readonly title?: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Resolves a host's token for each request. */
export type TokenSource = () => Promise<string>

/**
 * Everything that differs between code host families, so nothing outside a
 * family's module branches on the host kind.
 */
export interface ForgeAdapter {
  readonly kind: HostSpec['kind']
  /** Product name for messages, e.g. `GitHub`. */
  readonly title: string
  /** HTTP username git sends with the host's token over HTTPS. */
  readonly gitUsername: string
  /** The form of a repository path for messages, e.g. `owner/name`. */
  readonly pathHint: string
  /**
   * The REST API base URL of a host.
   * @param host - host address and the configured API address, if the family allows one.
   * @returns the base URL the provider sends requests to.
   */
  apiBaseUrl(host: { readonly url: string; readonly apiUrl?: string | undefined }): string
  /**
   * The repository path in an address.
   * @param rest - the address path below the host's path prefix, e.g. `/group/sub/app/-/merge_requests/3`.
   * @returns the repository path, or undefined when the address names none.
   */
  repoPath(rest: string): string | undefined
  /**
   * The label of a PR/MR in messages.
   * @param number - PR/MR number as shown in the web UI.
   * @returns e.g. `PR #12` or `MR !12`.
   */
  mrLabel(number: number): string
  /**
   * Build the provider of one host.
   * @param spec - configured or added host of this family.
   * @param token - resolves the host's token for every request.
   * @param timeoutMs - API deadline, for clients that need it at construction.
   * @returns the provider.
   */
  createProvider(spec: HostSpec, token: TokenSource, timeoutMs: number): Provider
}

const SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * Join path segments into a repository path, dropping a `.git` suffix of the last one.
 * @param segments - repository path segments.
 * @returns the path, or undefined when a segment is not a plain name.
 */
export function joinRepoPath(segments: readonly string[]): string | undefined {
  const parts = [...segments]
  if (parts.at(-1)?.endsWith('.git') === true) parts[parts.length - 1] = parts.at(-1)!.slice(0, -4)
  return parts.every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..') ? parts.join('/') : undefined
}

/**
 * Path segments of an address path below the host, without a trailing `.git`.
 * @param rest - address path.
 * @returns the non-empty segments.
 */
export function pathSegments(rest: string): string[] {
  return rest.replace(/\.git$/, '').split('/').filter(segment => segment !== '')
}

/**
 * The next page number after a page of `count` items.
 * @param paging - the requested page.
 * @param count - items returned.
 * @returns `page + 1` when the page was full.
 */
export function nextPage(paging: Paging, count: number): { nextPage?: number } {
  return count >= paging.perPage ? { nextPage: paging.page + 1 } : {}
}

/**
 * Cut text at a byte limit on a character boundary.
 * @param text - full text.
 * @param maxBytes - UTF-8 byte limit.
 * @returns the kept text and whether anything was cut.
 */
export function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  // Step back over UTF-8 continuation bytes so no character is split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/**
 * The message of a thrown value.
 * @param error - anything thrown.
 * @returns its message, or its string form.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first line of a commit message.
 * @param message - full message.
 * @returns its first line.
 */
export function titleOf(message: string): string {
  return message.split('\n', 1)[0] ?? ''
}

/**
 * Format an inline comment rejected by the host (e.g. line outside diff hunk) as a Markdown blockquote.
 * @param item - inline comment to fold into the review summary.
 * @returns Markdown blockquote naming the path, line, and body.
 */
export function formatFallbackInlineComment(item: DraftInlineComment): string {
  const location = item.newLine !== undefined
    ? `${item.path}:${item.newLine}`
    : item.oldLine !== undefined
      ? `${item.path}:${item.oldLine} (old)`
      : item.path
  const quoted = item.body.split('\n').map(line => line === '' ? '>' : `> ${line}`).join('\n')
  return `> **\`${location}\`**\n${quoted}`
}

/**
 * Build the summary body of a review, folding any fallback inline comments and appending the configured signature.
 * @param body - caller-supplied review summary.
 * @param fallbacks - inline comments that could not be anchored on diff hunks.
 * @param signature - configured signature; empty adds none.
 * @returns the composed review body, or undefined when there is neither summary nor fallback comments.
 */
export function composeReviewBody(body: string | undefined, fallbacks: readonly DraftInlineComment[], signature: string): string | undefined {
  const parts: string[] = []
  if (body !== undefined && body !== '') parts.push(body)
  for (const item of fallbacks) parts.push(formatFallbackInlineComment(item))
  if (parts.length === 0) return undefined
  const combined = parts.join('\n\n')
  return signature === '' ? combined : `${combined}\n\n${signature}`
}
