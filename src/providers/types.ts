/**
 * The per-family provider interface the service delegates to after resolving
 * a target, normalizing paging, and attaching the call deadline.
 *
 * @module dsh-repo/providers/types
 */

import type {
  BranchInfo, ChangeDetail, CommitAuthor, ChangeDiff, ChangeInfo, ChangeState, ChangeStatus, CommentInfo, CommitInfo,
  FileContent, IssueDetail, IssueInfo, IssueState, MergeMethod, MergeResult, Page, RepoInfo, RepoRef, TreeListing,
} from '../contract.ts'
import type { RepoLimits } from '../config.ts'

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

/** One code host family. Methods throw SDK errors or {@link RepoError}; the service classifies them. */
export interface Provider {
  /** Commit identity of the account that owns the token. */
  currentUser(call: Call): Promise<CommitAuthor>
  repoInfo(ref: RepoRef, call: Call): Promise<RepoInfo>
  getBranch(ref: RepoRef, name: string, call: Call): Promise<BranchInfo | undefined>
  listBranches(ref: RepoRef, query: Paging & { readonly search?: string }, call: Call): Promise<Page<BranchInfo>>
  listCommits(ref: RepoRef, query: Paging & { readonly ref?: string; readonly path?: string }, call: Call): Promise<Page<CommitInfo>>
  listTree(ref: RepoRef, query: { readonly ref?: string; readonly path: string; readonly recursive: boolean }, call: Call): Promise<TreeListing>
  readFile(ref: RepoRef, path: string, at: string | undefined, call: Call): Promise<FileContent>

  listIssues(ref: RepoRef, query: Paging & { readonly state: IssueState | 'all'; readonly labels?: readonly string[]; readonly assignee?: string }, call: Call): Promise<Page<IssueInfo>>
  getIssue(ref: RepoRef, number: number, call: Call): Promise<IssueDetail>
  createIssue(ref: RepoRef, issue: IssueFields & { readonly title: string }, call: Call): Promise<IssueInfo>
  updateIssue(ref: RepoRef, number: number, update: IssueFields & { readonly state?: IssueState }, call: Call): Promise<IssueInfo>
  commentIssue(ref: RepoRef, number: number, body: string, call: Call): Promise<CommentInfo>

  listChanges(ref: RepoRef, query: Paging & { readonly state: ChangeState | 'all'; readonly sourceBranch?: string; readonly targetBranch?: string }, call: Call): Promise<Page<ChangeInfo>>
  getChange(ref: RepoRef, number: number, call: Call): Promise<ChangeDetail>
  changeDiff(ref: RepoRef, number: number, call: Call): Promise<ChangeDiff>
  changeStatus(ref: RepoRef, number: number, call: Call): Promise<ChangeStatus>
  createChange(ref: RepoRef, change: IssueFields & { readonly title: string; readonly sourceBranch: string; readonly targetBranch: string; readonly draft: boolean }, call: Call): Promise<ChangeInfo>
  updateChange(ref: RepoRef, number: number, update: IssueFields & { readonly state?: 'open' | 'closed'; readonly targetBranch?: string }, call: Call): Promise<ChangeInfo>
  commentChange(ref: RepoRef, number: number, body: string, call: Call): Promise<CommentInfo>
  mergeChange(ref: RepoRef, number: number, request: { readonly headSha: string; readonly method?: MergeMethod }, call: Call): Promise<MergeResult>
}

/** Editable fields shared by issues and change requests. */
export interface IssueFields {
  readonly title?: string
  readonly body?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Resolves a host's token for each request. */
export type TokenSource = () => Promise<string>

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
 * The first line of a commit message.
 * @param message - full message.
 * @returns its first line.
 */
export function titleOf(message: string): string {
  return message.split('\n', 1)[0] ?? ''
}
