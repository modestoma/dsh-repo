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
 * Local mirrors and workspaces take HTTPS addresses (or local paths); an
 * address on a configured host carries that host's token, and addresses on
 * other hosts are mirrored without credentials unless the deployment turned
 * that off.
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
export type DshReposVersion = 2

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

/** Name and email recorded on a commit. */
export interface CommitAuthor {
  readonly name: string
  readonly email: string
}

/**
 * One extra `Token: value` line at the end of a commit message. The token is
 * an ASCII letter followed by up to 63 letters, digits, or `-`, and is not
 * `DSH-Session` (any case); the value is one line of 1 to 200 characters
 * without control characters.
 */
export interface CommitTrailer {
  readonly token: string
  readonly value: string
}

/**
 * Payload of the `repo/commit-trailers` event, dispatched with
 * `ctx.parallel` before `repo_workspace_push` records uncommitted changes
 * for an Agent's Session. Listeners call {@link add} before their returned
 * promise settles. Calls made after every listener has settled are ignored;
 * a call a listener makes after its own promise settled, while another
 * listener is still running, is still recorded. A listener that throws fails the
 * push with `unavailable` and nothing is committed. Every added trailer is
 * validated like {@link WorkspacePushOptions.trailers}.
 */
export interface CommitTrailersEvent {
  /** Session id of the Agent that called the tool. */
  readonly session: string
  /** Workspace directory being pushed. */
  readonly dir: string
  /**
   * Append one trailer to the commit.
   * @param token - trailer token, e.g. `Feishu-User`.
   * @param value - one-line trailer value.
   */
  add(token: string, value: string): void
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
  /** Branch of this repository the change requests come from; requests from forks are left out. */
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
  /**
   * GitLab: tick the merge request's "delete source branch" option, so GitLab
   * deletes the branch when the request is merged, by any means. GitHub has
   * no per-request option and ignores it. Default false.
   */
  readonly deleteSourceBranch?: boolean
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
  /**
   * Delete the source branch after the merge. Only a branch of the same
   * repository is deleted, never one in a fork or the default branch; a
   * failed deletion is reported in {@link MergeResult.sourceBranch} and does
   * not fail the merge. Default false.
   */
  readonly deleteSourceBranch?: boolean
}

/** Outcome of a merge. */
export interface MergeResult {
  /** The merge (or squash) commit, when the host reports it. */
  readonly sha?: string
  /** Present when {@link MergeOptions.deleteSourceBranch} was set. */
  readonly sourceBranch?: SourceBranchDeletion
}

/** What happened to the source branch of a merged change request. */
export interface SourceBranchDeletion {
  readonly name: string
  /** Whether the branch is gone or the host deletes it as part of the merge (GitLab). */
  readonly deleted: boolean
  /** Why the branch was kept, when {@link deleted} is false. */
  readonly reason?: string
}

/** A branch deleted by {@link DshRepoService.deleteMergedBranch}. */
export interface MergedBranchDeletion {
  readonly branch: string
  /** The commit the branch pointed to. */
  readonly commit: string
  /** The merged change request whose head was that commit. */
  readonly change: { readonly number: number; readonly webUrl: string }
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
  /** GitHub only: REST API base when it is not derived from `url`. */
  readonly apiUrl?: string
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
  /** GitHub only: REST API base when it is not `https://api.github.com` (github.com) or `<url>/api/v3` (GitHub Enterprise Server). */
  readonly apiUrl?: string
  /** Display name, at most 64 characters. */
  readonly alias?: string
  /** Token value stored under a generated credential reference; omitted leaves the token unset. */
  readonly token?: string
}

/**
 * One successful change reported to {@link DshRepoService.onHostsChange}:
 * `added` and `removed` change the host list, `token` stored or removed a
 * host's token, `mirror` moved the mirror directory.
 */
export type HostsChange =
  | {
    readonly kind: 'added' | 'removed' | 'token'
    /** Normalized address of the host. */
    readonly url: string
  }
  | {
    readonly kind: 'mirror'
    /** The new mirror directory. */
    readonly dir: string
  }

/** Where local mirrors live. */
export interface MirrorSettings {
  /** Absolute directory holding the mirrors; snapshots live under its `.snapshots/`. */
  readonly dir: string
  /** The directory used while none is chosen: `$DSH_HOME/dsh-repo/mirrors`. */
  readonly defaultDir: string
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

/** Options of {@link DshRepoService.openWorkspace}. */
export interface WorkspaceOpenOptions extends CallOptions {
  /** Absolute directory of the checkout; must not exist yet (its parent is created). */
  readonly dir: string
  /** Branch the work merges into, and starts from unless {@link branch} is given; default: the remote's default branch. */
  readonly baseBranch?: string
  /** Full commit id to start from, fetched by an earlier {@link DshRepoService.syncMirror}; default: the head of {@link baseBranch} after a fetch. Not allowed with {@link branch}. */
  readonly commit?: string
  /**
   * Existing remote branch to continue, for example the source branch of an
   * open change request. The workspace starts from its head after a fetch
   * and every {@link DshRepoService.pushWorkspace} adds fast-forward commits
   * to it, so a change request from it updates. Cannot be {@link baseBranch}
   * or the remote's default branch.
   */
  readonly branch?: string
}

/** A writable checkout opened by {@link DshRepoService.openWorkspace}. */
export interface WorkspaceInfo {
  /** HTTPS address (or local path) of the repository. */
  readonly url: string
  /** Absolute directory of the checkout. */
  readonly dir: string
  /** Branch the work started from; the natural target of its change request. */
  readonly baseBranch: string
  /** Commit the work started from. */
  readonly baseCommit: string
  /** Remote branch the pushes go to: fixed by the first {@link DshRepoService.pushWorkspace}, or at open when continuing an existing branch; absent before either. */
  readonly branch?: string
}

/** One file that differs from the workspace's base commit. */
export interface WorkspaceFileChange {
  /** Path from the repository root, `/`-separated. */
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed'
  /** Former path of a renamed file. */
  readonly previousPath?: string
  /** Whether git treats the file as binary; such files have no line counts. */
  readonly binary: boolean
  readonly additions?: number
  readonly deletions?: number
}

/** Everything a workspace changed relative to its base commit, committed or not. */
export interface WorkspaceChanges {
  readonly workspace: WorkspaceInfo
  /** Commits made by earlier pushes on top of the base commit, oldest first. */
  readonly commits: readonly { readonly sha: string; readonly subject: string }[]
  /** Whether the working tree has changes not yet committed by a push. */
  readonly uncommitted: boolean
  /** Files differing between the base commit and the working tree (untracked files included, ignored files excluded). */
  readonly files: readonly WorkspaceFileChange[]
  /** Unified diff from the base commit to the working tree. */
  readonly diff: string
  /** Whether {@link diff} was cut at the configured diff limit. */
  readonly truncated: boolean
}

/** Options of {@link DshRepoService.pushWorkspace}. */
export interface WorkspacePushOptions extends CallOptions {
  /**
   * Remote branch to push to. Required on the first push of a workspace
   * opened without {@link WorkspaceOpenOptions.branch}, which fails with
   * `conflict` when the remote already has the branch and with `invalid` for
   * the base or default branch; later pushes, and every push of a workspace
   * continuing an existing branch, must name the workspace's branch or omit it.
   */
  readonly branch?: string
  /** Message of the commit recording uncommitted changes; required when there are any. */
  readonly message?: string
  /**
   * Author and committer of that commit. Default: the account that owns the
   * host's token, read from the host's current-user API (on GitHub a missing
   * public email becomes the account's noreply address); the machine's git
   * identity for local addresses. A token that cannot read its own account
   * fails the push with `forbidden` or `unauthenticated`.
   */
  readonly author?: CommitAuthor
  /** Session that made the change, added to that commit's message as a `DSH-Session:` trailer. One line of at most 200 characters. */
  readonly session?: string
  /** Further trailers of that commit, after `DSH-Session:`, in order; at most 20. An invalid one fails the push with `invalid`. */
  readonly trailers?: readonly CommitTrailer[]
}

/** Outcome of {@link DshRepoService.pushWorkspace}. */
export interface WorkspacePushResult {
  readonly url: string
  readonly branch: string
  readonly baseBranch: string
  /** Commit the remote branch points to after the push. */
  readonly commit: string
  /** Whether this push recorded uncommitted changes as a new commit. */
  readonly committed: boolean
  /** Whether this push created the remote branch. */
  readonly created: boolean
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
  /**
   * Delete a branch whose work is already merged: its head is the head of a
   * merged change request from this repository, and no open change request
   * comes from it.
   * @param repo - repository target.
   * @param branch - branch name.
   * @param options - cancellation.
   * @returns the deleted branch and the change request that merged it.
   * @throws `not-found` when the branch does not exist, `forbidden` for the default or a protected branch, `conflict` when its head is not merged or a change request from it is open.
   */
  deleteMergedBranch(repo: RepoTarget, branch: string, options?: CallOptions): Promise<MergedBranchDeletion>

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
   * Observe changes made through {@link addHost}, {@link removeHost},
   * {@link setHostToken}, and {@link setMirrorDir}, whoever made them. The listener runs after the change
   * succeeded; a throwing listener does not affect the change or other listeners.
   * @param listener - receives the change.
   * @returns disposer that stops the observation.
   */
  onHostsChange(listener: (change: HostsChange) => void): () => void

  /** @returns where mirrors live. */
  mirrorSettings(): MirrorSettings
  /**
   * Choose the mirror directory, or return to the default with undefined. The
   * choice is kept in the settings file. Existing mirrors are not moved: later
   * syncs clone into the new directory, and held snapshots stay valid.
   * @param dir - absolute directory (`~` expands to the home directory); created when missing.
   * @returns the new settings.
   * @throws `invalid` for a relative path or one that cannot be created or written, `unavailable` when the choice cannot be saved.
   */
  setMirrorDir(dir: string | undefined): Promise<MirrorSettings>
  /**
   * Clone the address as a fetch-only mirror, or fetch it, and resolve the
   * branch head. Calls for the same mirror run one at a time. Addresses under
   * a configured host carry its token; other hosts are fetched without
   * credentials.
   * @param url - HTTPS address, `file:` URL, or absolute local path; SSH and other transports are refused.
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
  /**
   * Check out a commit as a writable working tree for editing. Its git
   * metadata stays in the mirror, outside the checkout: callers and agents
   * edit files only, and {@link pushWorkspace} records and pushes the
   * changes. The checkout belongs to the caller and is never deleted by the
   * service; deleting the directory abandons it.
   * @param url - HTTPS address, `file:` URL, or absolute local path.
   * @returns the workspace.
   * @throws `invalid` for an unsupported address, branch, commit, or a directory that exists, for `commit` with `branch`, and for a `branch` that is the base or default branch; `not-allowed` outside the configured repositories; `not-found` for a missing branch or commit; `unavailable` when git fails.
   */
  openWorkspace(url: string, options: WorkspaceOpenOptions): Promise<WorkspaceInfo>
  /**
   * Describe what a workspace changed since its base commit.
   * @param dir - directory returned by {@link openWorkspace}.
   * @returns the changes.
   * @throws `not-found` when the directory is not a workspace of this service, `unavailable` when git fails.
   */
  workspaceChanges(dir: string, options?: CallOptions): Promise<WorkspaceChanges>
  /**
   * Commit uncommitted changes, then push the workspace to its remote branch
   * with the host's token, never forcing. Pushing needs a configured host
   * with a token unless the address is a local path.
   * @param dir - directory returned by {@link openWorkspace}.
   * @returns the push outcome.
   * @throws `invalid` for a missing message or branch, the base or default branch, or nothing to push; `conflict` when the remote branch exists before the first push or moved since the last one; `unauthenticated` without a token; `forbidden` when the host refuses the push; `not-found` when the directory is not a workspace of this service; `unavailable` when git fails.
   */
  pushWorkspace(dir: string, options?: WorkspacePushOptions): Promise<WorkspacePushResult>
}
