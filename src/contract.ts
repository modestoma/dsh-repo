/**
 * Types of the `dshRepos` service: provider-neutral access to code, issues,
 * and pull/merge requests on GitHub (github.com and GitHub Enterprise Server)
 * and GitLab (gitlab.com and self-managed instances).
 *
 * This module has no runtime exports, and the package subpath
 * `dsh-repo/contract` exposes only its types. A consumer imports
 * them with `import type`, looks the service up per call with
 * `ctx.get('dshRepos')` (absent while dsh-repo is not loaded or reloading),
 * and checks {@link DshRepoService.version} before calling.
 *
 * Every method rejects with an error whose `name` is `RepoError` and whose
 * `code` is a {@link RepoErrorCode}; nothing else is thrown for an expected
 * failure. A repository is addressed by a {@link RepoTarget}; only hosts and
 * repositories the deployment configured are reachable through the host APIs.
 * Local mirrors ({@link DshRepoService.syncMirror}) also accept addresses on
 * other hosts unless the deployment turned that off; those use the machine's
 * own git credentials.
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

/** Name and email recorded as a commit's author. */
export interface CommitAuthor {
  readonly name: string
  readonly email: string
}

/** A multi-file commit. */
export interface CommitRequest extends CallOptions {
  /** Target branch; created from {@link base} when it does not exist. Never the default or a protected branch. */
  readonly branch: string
  /** Start branch of a new branch; default: the repository's default branch. Ignored when the branch exists. Not with {@link baseSha}. */
  readonly base?: string
  /** Start commit of a new branch, as a full hexadecimal object id. Ignored when the branch exists. Not with {@link base}. */
  readonly baseSha?: string
  /** When true, the call fails with `conflict` instead of committing on top of a branch that already exists. */
  readonly newBranch?: boolean
  /** Commit author; default: the token's user. The committer is always the token's user. */
  readonly author?: CommitAuthor
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

/** Whether a credential reference has a value — never the value. */
export interface TokenStatus {
  /** Whether resolving the reference currently returns a value. */
  readonly configured: boolean
  /** Credential store layer supplying the value (`file`, `env`, …); absent while unconfigured. */
  readonly source?: string
  /** Whether {@link DshRepoService.setHostToken} can store a value for this reference. */
  readonly writable: boolean
  /** Why the credential store could not describe the reference. */
  readonly error?: string
}

/** One host as {@link DshRepoService.listHosts} reports it. */
export interface HostInfo {
  readonly kind: ForgeKind
  /** Normalized `https://host[:port][/path]`. */
  readonly url: string
  readonly alias?: string
  /** Credential reference holding the host's token. */
  readonly tokenRef: string
  /** `config`: from cordis.yml, read-only; `added`: added through {@link DshRepoService.addHost}, removable. */
  readonly origin: 'config' | 'added'
  readonly token: TokenStatus
}

/** Fields of a host added at run time. */
export interface HostCreate {
  /** Default `gitlab`. */
  readonly kind?: ForgeKind
  /** `https://host[:port][/path]`; must differ from every existing host's address. */
  readonly url: string
  /** Display name, at most 64 characters. */
  readonly alias?: string
  /** Token value stored under a generated credential reference; omitted leaves the token unset. */
  readonly token?: string
}

/** One successful host change reported to {@link DshRepoService.onHostsChange}. */
export interface HostsChange {
  /** `added` and `removed` change the host list; `token` stored or removed a host's token. */
  readonly kind: 'added' | 'removed' | 'token'
  /** Normalized address of the host. */
  readonly url: string
}

/** Where local mirrors live. */
export interface MirrorSettings {
  /** Absolute directory holding the mirrors; snapshots live under its `.snapshots/`. */
  readonly dir: string
}

/** Options of {@link DshRepoService.syncMirror}. */
export interface MirrorSyncOptions extends CallOptions {
  /** Remote branch to resolve; default: the remote's default branch. */
  readonly branch?: string
}

/** A mirror after a successful clone or fetch. */
export interface MirrorState {
  /** The address as passed in. */
  readonly url: string
  /** Absolute directory of the fetch-only mirror (no checkout). */
  readonly dir: string
  /** The requested branch, or the remote's default branch. */
  readonly branch: string
  /** Commit the branch points to after the fetch. */
  readonly commit: string
  /** Committer date of {@link commit}, ISO 8601. */
  readonly commitTime: string
}

/** One entry of a mirror tree listing. */
export interface MirrorTreeEntry {
  /** Path from the repository root, `/`-separated. */
  readonly path: string
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule'
  /** Whether the file is executable (`file` only). */
  readonly executable?: boolean
}

/**
 * A read-only checkout of one commit, shared by every holder of the same
 * mirror and commit. The directory stays unchanged until every holder released
 * it; release exactly once.
 */
export interface SnapshotLease {
  readonly url: string
  readonly commit: string
  /** Absolute directory of the checkout. */
  readonly dir: string
  release(): void
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
  /** @returns the branch, or undefined when the repository has no branch of that name. */
  getBranch(repo: RepoTarget, name: string, options?: CallOptions): Promise<BranchInfo | undefined>
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

  /** @returns every host, configured ones first, with the status of its token. */
  listHosts(): Promise<readonly HostInfo[]>
  /**
   * Add a host and persist it; with `token`, store it in DSH's credential store.
   * @returns the added host.
   * @throws `invalid` for a bad address or alias, `conflict` when the address is taken.
   */
  addHost(host: HostCreate): Promise<HostInfo>
  /**
   * Remove an added host and the token stored for it. Configured hosts cannot be removed.
   * @throws `not-found` for an unknown address, `forbidden` for a configured host.
   */
  removeHost(url: string): Promise<void>
  /**
   * Store (string) or remove (undefined) a host's token in DSH's credential store;
   * after removal an environment variable of the same name applies again.
   * @returns the host with its new token status.
   * @throws `not-found` for an unknown address, `invalid` for an unusable token, `unavailable` when the store cannot be written.
   */
  setHostToken(url: string, token: string | undefined): Promise<HostInfo>
  /**
   * Observe host changes made through {@link addHost}, {@link removeHost}, and
   * {@link setHostToken}, whoever made them. The listener runs after the change
   * succeeded; a throwing listener does not affect the change or other listeners.
   * @param listener - receives the change.
   * @returns disposer that stops the observation.
   */
  onHostsChange(listener: (change: HostsChange) => void): () => void

  /** @returns where mirrors live. */
  mirrorSettings(): MirrorSettings
  /**
   * Clone the address as a fetch-only mirror, or fetch it, and resolve the
   * branch head. Calls for the same mirror run one at a time. HTTPS addresses
   * under a configured host carry its token; other addresses use the
   * machine's git credentials (SSH keys, credential helpers).
   * @param url - git address: HTTPS/SSH/git URL, `user@host:path`, or an absolute local path.
   * @returns the mirror and the branch head.
   * @throws `invalid` for an unsupported address or branch, `not-allowed` outside the configured repositories or on other hosts when they are refused, `not-found` for a missing branch, `unavailable` when git fails.
   */
  syncMirror(url: string, options?: MirrorSyncOptions): Promise<MirrorState>
  /**
   * Read one regular file of a commit from the mirror's object database.
   * @param commit - full commit id fetched by an earlier {@link syncMirror}.
   * @returns UTF-8 text, or undefined when the commit has no such path.
   * @throws `invalid` when the path is not a regular file, `too-large` above the file limit, `not-found` when the mirror or commit is missing.
   */
  readMirrorFile(url: string, commit: string, path: string, options?: CallOptions): Promise<string | undefined>
  /**
   * List the entries below a directory of a commit, recursively.
   * @param path - directory from the repository root; empty lists the whole tree.
   * @returns entries (directories included), or an empty list when the path does not exist.
   * @throws `not-found` when the mirror or commit is missing, `too-large` above the tree limit.
   */
  listMirrorTree(url: string, commit: string, path: string, options?: CallOptions): Promise<readonly MirrorTreeEntry[]>
  /**
   * Hold a read-only checkout of a commit, creating it on first use.
   * @returns the lease.
   * @throws `not-found` when the mirror or commit is missing, `unavailable` when the checkout cannot be created.
   */
  acquireSnapshot(url: string, commit: string, options?: CallOptions): Promise<SnapshotLease>
}
