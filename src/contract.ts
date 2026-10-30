/**
 * Types of the `dshRepos` service: provider-neutral access to code, issues,
 * and pull/merge requests on GitHub (github.com and GitHub Enterprise Server)
 * and GitLab (gitlab.com and self-managed instances).
 *
 * This module has no runtime exports, and the package subpath
 * `@modesto_ma/dsh-repo/contract` exposes only its types. A consumer imports
 * them with `import type`, looks the service up per call with
 * `ctx.get('dshRepos')` (absent while dsh-repo is not loaded or reloading),
 * and checks {@link DshRepoService.version} before calling.
 *
 * Every method rejects with an error whose `name` is `RepoError` and whose
 * `code` is a {@link RepoErrorCode}; nothing else is thrown for an expected
 * failure. A repository is addressed by a {@link RepoTarget}; only hosts and
 * repositories the deployment configured are reachable.
 *
 * @module dsh-repo/contract
 */

/** Name the service is provided under (`ctx.get('dshRepos')`). */
export type DshReposServiceName = 'dshRepos'

/**
 * Version of this contract. It changes only when a change would make an older
 * consumer misbehave; a consumer refuses a provider whose version it does not
 * know.
 */
export type DshReposVersion = 1

/** Code host family. */
export type ForgeKind = 'github' | 'gitlab'

/**
 * A repository: its web or clone URL (`https://host/owner/name`,
 * `git@host:owner/name.git`, `ssh://git@host/owner/name.git`) or
 * `host/owner/name`. GitLab paths may have nested groups.
 */
export type RepoTarget = string

/** Why a call failed. */
export type RepoErrorCode =
  /** The arguments break a documented rule. */
  | 'invalid'
  /** No configured host serves the repository, or it is outside the configured repositories. */
  | 'not-allowed'
  /** The host's token is missing or rejected. */
  | 'unauthenticated'
  /** The token lacks permission, or the target branch is protected. */
  | 'forbidden'
  /** The repository, branch, file, issue, or change request does not exist. */
  | 'not-found'
  /** The state moved (branch exists, head SHA changed, not mergeable). */
  | 'conflict'
  /** The host's rate limit was reached. */
  | 'rate-limited'
  /** The answer exceeds a configured size limit. */
  | 'too-large'
  /** Network failure, timeout, or another host error. */
  | 'unavailable'

/** Fields of a rejection from the service. */
export interface RepoFailure {
  readonly name: 'RepoError'
  readonly code: RepoErrorCode
  /** Readable reason (Chinese), including the host's message when there is one. */
  readonly message: string
}

/** Options every call accepts. */
export interface CallOptions {
  /** Aborting stops waiting for the host; a write may still have reached it. */
  readonly signal?: AbortSignal
}

/** Offset paging of list calls. */
export interface PageOptions extends CallOptions {
  /** 1-based page; default 1. */
  readonly page?: number
  /** Items per page; default and maximum are configured. */
  readonly perPage?: number
}

/** One page of a list call. */
export interface Page<T> {
  readonly items: readonly T[]
  /** Next page number when the page was full; absent on the last page. */
  readonly nextPage?: number
}

/** A user as the host shows them. */
export interface RepoUser {
  /** Login (GitHub) or username (GitLab). */
  readonly username: string
  readonly webUrl?: string
}

/** The resolved repository a call ran against. */
export interface RepoRef {
  readonly kind: ForgeKind
  /** Host name with port when not default, e.g. `gitlab.example.com:8443`. */
  readonly host: string
  /** `owner/name` (GitHub) or `group/…/project` (GitLab). */
  readonly path: string
  readonly webUrl: string
}

/** Repository metadata. */
export interface RepoInfo extends RepoRef {
  readonly defaultBranch: string
  readonly description?: string
  readonly visibility: 'public' | 'private' | 'internal'
  readonly archived: boolean
  readonly cloneUrl: string
}

/** One branch. */
export interface BranchInfo {
  readonly name: string
  readonly commit: string
  readonly protected: boolean
  readonly default: boolean
}

/** One commit. */
export interface CommitInfo {
  readonly sha: string
  /** First line of the message. */
  readonly title: string
  readonly message: string
  readonly authorName: string
  readonly authorEmail?: string
  readonly authoredAt?: string
  readonly webUrl?: string
}

/** One entry of a tree listing. */
export interface TreeEntry {
  /** Path from the repository root. */
  readonly path: string
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule'
  /** Bytes, when the host reports it. */
  readonly size?: number
}

/** A tree listing. */
export interface TreeListing {
  readonly ref: string
  readonly entries: readonly TreeEntry[]
  /** Whether entries beyond the configured limit were left out. */
  readonly truncated: boolean
}

/** A file read at a ref. */
export interface FileContent {
  readonly path: string
  readonly ref: string
  /** UTF-8 text; empty for a binary file. */
  readonly text: string
  /** Whether the file contains NUL bytes and was not returned as text. */
  readonly binary: boolean
  /** Whether {@link text} was cut at the configured limit. */
  readonly truncated: boolean
}

/** One file of a commit request. */
export type FileChange =
  | { readonly action: 'write'; readonly path: string; readonly content: string }
  | { readonly action: 'delete'; readonly path: string }

/** A multi-file commit. */
export interface CommitRequest extends CallOptions {
  /** Target branch; created from {@link base} when it does not exist. Never the default or a protected branch. */
  readonly branch: string
  /** Start point of a new branch; default: the repository's default branch. Ignored when the branch exists. */
  readonly base?: string
  readonly message: string
  readonly files: readonly FileChange[]
}

/** Outcome of a commit. */
export interface CommitResult {
  readonly sha: string
  readonly branch: string
  /** Whether the branch was created by this commit. */
  readonly createdBranch: boolean
  readonly webUrl?: string
}

/** Lifecycle state of an issue. */
export type IssueState = 'open' | 'closed'

/** One comment on an issue or change request. */
export interface CommentInfo {
  readonly id: string
  readonly author: RepoUser
  readonly body: string
  readonly createdAt: string
  readonly webUrl?: string
}

/** One issue. */
export interface IssueInfo {
  /** Number (GitHub) or project-scoped IID (GitLab), as shown in the web UI. */
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: IssueState
  readonly author: RepoUser
  readonly labels: readonly string[]
  readonly assignees: readonly RepoUser[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly webUrl: string
}

/** An issue with its comments. */
export interface IssueDetail extends IssueInfo {
  /** Oldest first, at most one page. */
  readonly comments: readonly CommentInfo[]
}

/** Filters of an issue listing. */
export interface IssueListOptions extends PageOptions {
  /** Default `open`. */
  readonly state?: IssueState | 'all'
  /** Issues carrying all these labels. */
  readonly labels?: readonly string[]
  readonly assignee?: string
}

/** Fields of a new issue. */
export interface IssueCreate extends CallOptions {
  readonly title: string
  readonly body?: string
  readonly labels?: readonly string[]
  /** Usernames. */
  readonly assignees?: readonly string[]
}

/** Fields to change on an issue; omitted fields stay. */
export interface IssueUpdate extends CallOptions {
  readonly title?: string
  readonly body?: string
  readonly state?: IssueState
  /** Replaces the labels. */
  readonly labels?: readonly string[]
  /** Replaces the assignees (usernames). */
  readonly assignees?: readonly string[]
}

/** Lifecycle state of a pull or merge request. */
export type ChangeState = 'open' | 'closed' | 'merged'

/** One pull request (GitHub) or merge request (GitLab). */
export interface ChangeInfo {
  /** Number (GitHub) or project-scoped IID (GitLab). */
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: ChangeState
  readonly draft: boolean
  readonly sourceBranch: string
  readonly targetBranch: string
  /** Commit SHA at the head of the source branch. */
  readonly headSha: string
  readonly author: RepoUser
  readonly labels: readonly string[]
  readonly assignees: readonly RepoUser[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly webUrl: string
}

/** A change request with its comments. */
export interface ChangeDetail extends ChangeInfo {
  /** Conversation comments, oldest first, at most one page; inline review comments are not included. */
  readonly comments: readonly CommentInfo[]
}

/** Filters of a change request listing. */
export interface ChangeListOptions extends PageOptions {
  /** Default `open`. */
  readonly state?: ChangeState | 'all'
  readonly sourceBranch?: string
  readonly targetBranch?: string
}

/** A unified diff. */
export interface ChangeDiff {
  readonly diff: string
  /** Whether {@link diff} is incomplete: cut at the configured limit, or the host left out some files. */
  readonly truncated: boolean
}

/** Aggregated CI result. */
export type CheckState = 'success' | 'failure' | 'pending' | 'none'

/** One CI check, status, or pipeline. */
export interface CheckInfo {
  readonly name: string
  readonly state: Exclude<CheckState, 'none'>
  readonly webUrl?: string
}

/** CI and merge readiness of a change request. */
export interface ChangeStatus {
  readonly headSha: string
  readonly checks: readonly CheckInfo[]
  readonly overall: CheckState
  /** Whether the host reports the change request as mergeable now; absent while the host is still computing it. */
  readonly mergeable?: boolean
}

/** Fields of a new change request. */
export interface ChangeCreate extends CallOptions {
  readonly title: string
  readonly body?: string
  readonly sourceBranch: string
  /** Default: the repository's default branch. */
  readonly targetBranch?: string
  readonly draft?: boolean
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Fields to change on a change request; omitted fields stay. */
export interface ChangeUpdate extends CallOptions {
  readonly title?: string
  readonly body?: string
  /** `closed` closes, `open` reopens. */
  readonly state?: 'open' | 'closed'
  readonly targetBranch?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** How to merge. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** A merge request; refused (`conflict`) when the head moved past {@link headSha}. */
export interface MergeOptions extends CallOptions {
  readonly headSha: string
  /** Default: the repository's setting. GitLab honors `squash`; `rebase` is GitHub only. */
  readonly method?: MergeMethod
}

/** Outcome of a merge. */
export interface MergeResult {
  /** The merge (or squash) commit, when the host reports it. */
  readonly sha?: string
}

/** The `dshRepos` service. */
export interface DshRepoService {
  readonly version: DshReposVersion
  /**
   * Resolve a target against the configured hosts and repositories without
   * calling the host.
   * @param repo - repository target.
   * @returns the resolved repository.
   */
  resolve(repo: RepoTarget): RepoRef

  /** @returns repository metadata. */
  repoInfo(repo: RepoTarget, options?: CallOptions): Promise<RepoInfo>
  /** @returns one page of branches. */
  listBranches(repo: RepoTarget, options?: PageOptions & { readonly search?: string }): Promise<Page<BranchInfo>>
  /** @returns one page of commits, newest first. */
  listCommits(repo: RepoTarget, options?: PageOptions & { readonly ref?: string; readonly path?: string }): Promise<Page<CommitInfo>>
  /** @returns entries below `path` (default: root) at `ref` (default: the default branch). */
  listTree(repo: RepoTarget, options?: CallOptions & { readonly ref?: string; readonly path?: string; readonly recursive?: boolean }): Promise<TreeListing>
  /** @returns one file at `ref` (default: the default branch). */
  readFile(repo: RepoTarget, path: string, options?: CallOptions & { readonly ref?: string }): Promise<FileContent>
  /** @returns the new commit. */
  commitFiles(repo: RepoTarget, request: CommitRequest): Promise<CommitResult>

  /** @returns one page of issues (change requests are excluded). */
  listIssues(repo: RepoTarget, options?: IssueListOptions): Promise<Page<IssueInfo>>
  /** @returns the issue and its first page of comments. */
  getIssue(repo: RepoTarget, number: number, options?: CallOptions): Promise<IssueDetail>
  /** @returns the new issue. */
  createIssue(repo: RepoTarget, issue: IssueCreate): Promise<IssueInfo>
  /** @returns the updated issue. */
  updateIssue(repo: RepoTarget, number: number, update: IssueUpdate): Promise<IssueInfo>
  /** @returns the new comment. */
  commentIssue(repo: RepoTarget, number: number, body: string, options?: CallOptions): Promise<CommentInfo>

  /** @returns one page of change requests. */
  listChanges(repo: RepoTarget, options?: ChangeListOptions): Promise<Page<ChangeInfo>>
  /** @returns the change request and its first page of comments. */
  getChange(repo: RepoTarget, number: number, options?: CallOptions): Promise<ChangeDetail>
  /** @returns the change request's unified diff. */
  changeDiff(repo: RepoTarget, number: number, options?: CallOptions): Promise<ChangeDiff>
  /** @returns CI and merge readiness. */
  changeStatus(repo: RepoTarget, number: number, options?: CallOptions): Promise<ChangeStatus>
  /** @returns the new change request. */
  createChange(repo: RepoTarget, change: ChangeCreate): Promise<ChangeInfo>
  /** @returns the updated change request. */
  updateChange(repo: RepoTarget, number: number, update: ChangeUpdate): Promise<ChangeInfo>
  /** @returns the new comment. */
  commentChange(repo: RepoTarget, number: number, body: string, options?: CallOptions): Promise<CommentInfo>
  /** @returns the merge outcome. */
  mergeChange(repo: RepoTarget, number: number, options: MergeOptions): Promise<MergeResult>
}
