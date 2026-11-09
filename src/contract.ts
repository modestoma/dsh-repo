/**
 * Types of the `dshRepos` service: provider-neutral access to code, issues,
 * pull/merge requests, and CI (GitLab pipelines, GitHub Actions) on GitHub (github.com and GitHub Enterprise Server)
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
 * failure. A repository is addressed by a {@link RepoTarget}. Only
 * repositories in the deployment's repository catalog ({@link CatalogRepo})
 * are reachable, through the host APIs and as snapshots and workspaces alike,
 * and each only up to the catalog's {@link RepoAccess}; everything else fails
 * with `not-allowed`.
 *
 * Every model tool `repo_<object>_<action>` has exactly one service method
 * `<object><Action>` (`repo_list` ↔ {@link DshRepoService.repoList}), taking
 * the same parameter object plus the caller fields of {@link CallOptions}
 * and, for writes, {@link WriteOptions}, and running the same validation,
 * catalog check, `access/authorize` dispatch, and approval. The remaining
 * methods serve plugins and the settings page only.
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
export type DshReposVersion = 6

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
  /** No configured host serves the repository, it is not in the catalog, or its catalog access does not allow the call. */
  | 'not-allowed'
  /** The host's token is missing or rejected. */
  | 'unauthenticated'
  /** The token lacks permission, or the target branch is protected. */
  | 'forbidden'
  /** The repository, branch, file, issue, pull/merge request, or workspace does not exist. */
  | 'not-found'
  /** The state moved (branch exists, head SHA changed, not mergeable). */
  | 'conflict'
  /** The user did not approve a write made for an Agent. */
  | 'declined'
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

/** Caller fields every service method accepts besides its parameters. */
export interface CallOptions {
  /** Aborting stops waiting for the host; a write may still have reached it. */
  readonly signal?: AbortSignal
}

/**
 * The host Agent a call is made for: the `agent` a DSH tool's `execute`
 * receives. dsh-repo uses its Session id and hands it to DSH's approval
 * service, which needs a live Agent whose Session has an open turn.
 */
export interface CallerAgent {
  readonly id: string
  readonly session?: { readonly header: { readonly id: string } }
}

/**
 * Caller fields of a write. With {@link agent} the write runs exactly as the
 * matching tool does for that Agent: `access/authorize` is dispatched for its
 * Session and, while the settings say `ask`, the user approves the same card
 * the tool shows (a refusal fails with `declined`, writes turned `off` with
 * `forbidden`). Without it the calling plugin answers for the write itself:
 * nothing is dispatched or asked.
 */
export interface WriteOptions extends CallOptions {
  readonly agent?: CallerAgent
  /** The calling plugin's own tool call id, so the approval card shows that call. */
  readonly callId?: string
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

/**
 * What an `access/authorize` listener is asked to allow. dsh-repo asks for
 * `code-write` before its writes and git pushes and `admin` before
 * {@link DshRepoService.repoAdd} changes the catalog; other plugins use the
 * levels for their own writes. Listeners refuse a level they do not know.
 */
export type AuthorizeLevel = 'code-write' | 'wiki-read' | 'wiki-write' | 'admin'

/**
 * Payload of the `access/authorize` event, dispatched with `ctx.parallel`
 * before a write is made for a Session: by every write tool and by every
 * write method called with {@link WriteOptions.agent}, after the arguments are
 * validated and before the user is asked to approve; and by the local git
 * proxy before it forwards a push from a workspace, for the Session that
 * created the workspace. A listener that knows the Session and refuses throws
 * an `Error` whose message says why; the write then fails with `forbidden`
 * and nothing is asked or changed. A listener that does not know the Session
 * returns. No listener means allowed. The Session may be a subagent's;
 * listeners resolve it to the Session they know (e.g. through
 * `parentSession`).
 */
export interface AuthorizeEvent {
  /** Session id of the Agent the write is made for. */
  readonly session: string
  readonly level: AuthorizeLevel
  /** What is about to happen: the service method, or `git-push` for a push through the proxy. */
  readonly action: string
  /** Chinese description of the write, as the approval request shows it. */
  readonly summary: string
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
 * `ctx.parallel` before {@link DshRepoService.workspacePush} commits
 * uncommitted changes of a workspace that a Session created or that is pushed
 * for an Agent, after `access/authorize` allowed it. Listeners call
 * {@link add} and {@link setAuthor} before their returned promise settles.
 * Calls made after every listener has settled are ignored; a call a listener
 * makes after its own promise settled, while another listener is still
 * running, is still recorded. A listener that throws fails the push with
 * `unavailable` and nothing is committed. Every added trailer is validated
 * like {@link CommitTrailer}, the author like {@link setAuthor}'s parameters.
 */
export interface CommitTrailersEvent {
  /** Session the push is made for. */
  readonly session: string
  /** Directory of the workspace being pushed. */
  readonly path: string
  /**
   * Append one trailer to the commit.
   * @param token - trailer token, e.g. `Feishu-User`.
   * @param value - one-line trailer value.
   */
  add(token: string, value: string): void
  /**
   * Make someone other than the committer the commit's author, e.g. the person
   * who asked for the change; the committer stays the host token's account.
   * It wins over the configured commit identity. More than
   * one call during one push, from any listeners, fails the push with
   * `invalid` and nothing is committed.
   * @param name - author name: one line without `<` or `>`.
   * @param email - author email: no `<`, `>`, or whitespace.
   */
  setAuthor(name: string, email: string): void
}

/** What the `repo/commit-trailers` listeners contributed to one push. */
export interface CommitDetails {
  /** Trailers in the order they were added. */
  readonly trailers: readonly CommitTrailer[]
  /** Author set by a listener; absent means the committer. */
  readonly author?: CommitAuthor
}

/** Lifecycle state of an issue. */
export type IssueState = 'open' | 'closed'

/** One comment on an issue or pull/merge request. */
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

/** Lifecycle state of a pull or merge request. */
export type MrState = 'open' | 'closed' | 'merged'

/** One pull request (GitHub) or merge request (GitLab). */
export interface MrInfo {
  /** Number (GitHub) or project-scoped IID (GitLab). */
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: MrState
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

/** A pull/merge request with its comments. */
export interface MrDetail extends MrInfo {
  /** Conversation comments, oldest first, at most one page; inline review comments are not included. */
  readonly comments: readonly CommentInfo[]
}

/** A unified diff. */
export interface MrDiff {
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
  /** The CI run behind the check, for {@link DshRepoService.ciGet}: a GitLab pipeline or a GitHub Actions workflow run. */
  readonly runId?: number
  /** The GitHub Actions job behind a check run, for {@link DshRepoService.ciLog}. */
  readonly jobId?: number
}

/** CI and merge readiness of a pull/merge request. */
export interface MrStatus {
  readonly headSha: string
  readonly checks: readonly CheckInfo[]
  readonly overall: CheckState
  /** Whether the host reports the request as mergeable now; absent while the host is still computing it. */
  readonly mergeable?: boolean
}

/**
 * State of a CI run, job, or step: `pending` covers created, queued, waiting,
 * and scheduled; `manual` waits for someone to start it (GitLab manual jobs,
 * GitHub runs that need approval).
 */
export type CiState = 'pending' | 'running' | 'success' | 'failure' | 'canceled' | 'skipped' | 'manual'

/** One CI run: a GitLab pipeline or a GitHub Actions workflow run. */
export interface CiRun {
  readonly id: number
  /** GitHub: the workflow's name; GitLab: the pipeline's name when it has one. */
  readonly name?: string
  readonly state: CiState
  /** The host's own status word, e.g. `failed`, `waiting_for_resource`, `timed_out`. */
  readonly status: string
  /** Branch or tag. */
  readonly ref: string
  readonly sha: string
  /** What started it: GitLab `source` (`push`, `merge_request_event`, `schedule`, …), GitHub `event`. */
  readonly event?: string
  readonly createdAt: string
  readonly updatedAt?: string
  /** GitHub: attempt number, above 1 after a rerun. */
  readonly attempt?: number
  readonly webUrl: string
}

/** One step of a GitHub Actions job. */
export interface CiStep {
  readonly number: number
  readonly name: string
  readonly state: CiState
  readonly status: string
}

/** The pipeline a GitLab trigger job started. */
export interface CiDownstream {
  readonly id: number
  readonly state: CiState
  readonly status: string
  readonly webUrl: string
  /** Whether it belongs to the same repository, so its id works with that repository (child pipelines). */
  readonly sameRepo: boolean
}

/** One CI job. */
export interface CiJob {
  readonly id: number
  readonly name: string
  /** GitLab stage. */
  readonly stage?: string
  readonly state: CiState
  readonly status: string
  /** GitLab: a failure of this job does not fail its pipeline. GitHub does not report it and gives false. */
  readonly allowFailure: boolean
  /** GitLab `failure_reason`, e.g. `script_failure`, `runner_system_failure`, `job_execution_timeout`. */
  readonly failureReason?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationSeconds?: number
  readonly webUrl?: string
  /** GitHub: the job's steps. */
  readonly steps?: readonly CiStep[]
  /** GitLab trigger job: the pipeline it started, once started. */
  readonly downstream?: CiDownstream
}

/** One failed test case (GitLab test report) or failure annotation (GitHub). */
export interface CiFailure {
  /** GitHub: the job that reported it. */
  readonly job?: string
  /** GitLab: the test suite. */
  readonly suite?: string
  /** Test case name or annotation title. */
  readonly name: string
  /** Failure output or annotation message, cut to an equal share of the log limit per failure. */
  readonly message?: string
  readonly path?: string
  readonly line?: number
}

/** Test counts of a GitLab pipeline's test report. */
export interface CiTestCounts {
  readonly total: number
  readonly success: number
  readonly failed: number
  readonly skipped: number
  readonly error: number
}

/** A CI run with its jobs and, for a failed run, what failed. */
export interface CiRunDetail extends CiRun {
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationSeconds?: number
  /** GitLab: why the CI configuration was rejected. */
  readonly yamlErrors?: string
  /** Jobs in the host's order (GitLab: trigger jobs last); only failed ones with `onlyFailed`. */
  readonly jobs: readonly CiJob[]
  /** Whether jobs past the read limit were left out. */
  readonly jobsTruncated: boolean
  /** GitLab: counts of the test report, read for failed pipelines that have one. */
  readonly tests?: CiTestCounts
  /** Failed test cases (GitLab) or failure annotations of failed jobs (GitHub), read for failed runs. */
  readonly failures: readonly CiFailure[]
  /** Whether failures past the configured limit were left out. */
  readonly failuresTruncated: boolean
  /** Why the test report or annotations could not be read; the jobs are still complete. */
  readonly failuresError?: string
}

/** An excerpt of a job log; every excerpt is at most the configured log limit. */
export interface CiJobLog {
  readonly job: CiJob
  /** Cleaned lines in the whole log; a running job's log is incomplete. */
  readonly totalLines: number
  /** Number of the first line in {@link text}; absent when nothing was selected. */
  readonly fromLine?: number
  /** Number of the last line in {@link text}. */
  readonly toLine?: number
  /**
   * Without search: the selected lines at the end of the log. With search:
   * matching lines and their context as `<number>: <text>`, separate
   * excerpts divided by `--`. ANSI colors, redrawn progress lines, and
   * timestamps are removed; section starts read `▶ <title>`.
   */
  readonly text: string
  /** Without search: earlier lines were left out (pass `beforeLine: fromLine`); with search: later matches did not fit. */
  readonly more: boolean
  /** With search: the number of matching lines in the whole log. */
  readonly matches?: number
  /** Section titles in order of appearance, for {@link CiLogParams.section}. */
  readonly sections: readonly string[]
  readonly sectionsTruncated: boolean
}

/** Outcome of {@link DshRepoService.ciRetry} and {@link DshRepoService.ciCancel}. */
export interface CiActionResult {
  /** The run acted on; on GitHub a retried run keeps its id with a new attempt. */
  readonly runId?: number
  /** The job acted on, or the new job a GitLab job retry created. */
  readonly jobId?: number
  /** State after the request, when the host returned it. */
  readonly state?: CiState
  readonly webUrl?: string
}

/** Whether a credential reference has a value — never the value. */
export interface TokenStatus {
  /** Whether resolving the reference currently returns a value. */
  readonly configured: boolean
  /** Credential store layer supplying the value (`file`, `env`, …); absent while unconfigured. */
  readonly source?: string
  /** Whether {@link DshRepoService.hostSetToken} can store a value for this reference. */
  readonly writable: boolean
  /** Why the credential store could not describe the reference. */
  readonly error?: string
}

/** One host as {@link DshRepoService.hostList} reports it. */
export interface HostInfo {
  readonly kind: ForgeKind
  /** Normalized `https://host[:port][/path]`. */
  readonly url: string
  /** GitHub only: REST API base when it is not derived from `url`. */
  readonly apiUrl?: string
  readonly alias?: string
  /** Credential reference holding the host's token. */
  readonly tokenRef: string
  /** `config`: from cordis.yml, read-only; `added`: added through {@link DshRepoService.hostAdd}, removable. */
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
 * One successful change reported to {@link DshRepoService.hostOnChange}:
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
    /** The new mirror directory, or undefined when the choice was cleared. */
    readonly dir: string | undefined
  }

/**
 * What dsh-repo may do in one catalog repository, each level including the
 * ones before it: `read` reads code, history, issues, PRs/MRs, CI runs and
 * logs, and uses mirrors, snapshots, and workspaces; `write` also pushes
 * workspaces, creates, edits, and comments on issues and PRs/MRs, deletes
 * merged branches, and retries or cancels CI; `merge` also merges PRs/MRs.
 */
export type RepoAccess = 'read' | 'write' | 'merge'

/**
 * A feature other plugins offer per catalog repository (for example log
 * analysis). The settings page shows one switch per registered feature on
 * every repository; dsh-repo stores which repositories turned it on and
 * attaches no behavior of its own.
 */
export interface RepoFeature {
  /** Lowercase letters, digits, and `-`, starting with a letter, at most 40 characters. */
  readonly id: string
  /** Column title on the settings page, at most 20 characters. */
  readonly title: string
  /** One line explaining the switch, at most 200 characters. */
  readonly description?: string
}

/** Keeping a local directory equal to the head of the repository's branch. */
export interface LocalSyncSpec {
  /** Whether the directory is kept up to date; a disabled sync keeps its directory and interval. */
  readonly enabled: boolean
  /** Absolute directory on the Host the files are expanded into. */
  readonly dir: string
  /** Minutes between two syncs. */
  readonly intervalMinutes: number
}

/** One repository of the catalog. */
export interface CatalogRepo {
  /** Stable id, 12 lowercase hex characters. */
  readonly id: string
  /** HTTPS address on a configured host. */
  readonly url: string
  /** Branch consumers and the local sync follow; absent follows the remote's default branch. */
  readonly branch?: string
  readonly access: RepoAccess
  /** Ids of the {@link RepoFeature}s turned on, including features whose plugin is not loaded now. */
  readonly features: readonly string[]
  /** Absent until a local directory was configured. */
  readonly localSync?: LocalSyncSpec
}

/** Outcome of {@link DshRepoService.repoAdd}. */
export interface RepoAddResult {
  /** `added`: a new entry; `updated`: features were turned on; `unchanged`: nothing to do. */
  readonly status: 'added' | 'updated' | 'unchanged'
  readonly repo: CatalogRepo
}


/** How to merge. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** Outcome of a merge. */
export interface MergeResult {
  /** The merge (or squash) commit, when the host reports it. */
  readonly sha?: string
  /** Present when the settings delete source branches after a merge. */
  readonly sourceBranch?: SourceBranchDeletion
}

/** What happened to the source branch of a merged pull/merge request. */
export interface SourceBranchDeletion {
  readonly name: string
  /** Whether the branch is gone or the host deletes it as part of the merge (GitLab). */
  readonly deleted: boolean
  /** Why the branch was kept, when {@link deleted} is false. */
  readonly reason?: string
}

/** A branch deleted by {@link DshRepoService.branchDelete}. */
export interface MergedBranchDeletion {
  readonly branch: string
  /** The commit the branch pointed to. */
  readonly commit: string
  /** The merged pull/merge request whose head was that commit. */
  readonly mr: { readonly number: number; readonly webUrl: string }
}

/** Whether PR/MR watching delivers the request's activity to the calling Session. */
export interface WatchState {
  /** True while the request's CI results, comments, and merge or close arrive in the Session as messages. */
  readonly watching: boolean
  /** Why watching could not start; the write itself succeeded. */
  readonly watchError?: string
}

/** Offset paging of list methods. */
export interface PageParams {
  /** 1-based page; default 1. */
  readonly page?: number
  /** Items per page; default and maximum are configured. */
  readonly perPage?: number
}

/** Parameters naming a repository. */
export interface RepoParams {
  readonly repo: RepoTarget
}

/** Parameters of {@link DshRepoService.repoList}. */
export interface RepoListParams {
  /** Keep only repositories with this feature turned on. */
  readonly feature?: string
}

/** Parameters of {@link DshRepoService.repoAdd}. */
export interface RepoAddParams {
  /** HTTPS address on a configured host. */
  readonly repo: string
  /** Branch of a new entry; for an existing entry it must equal the entry's branch. */
  readonly branch?: string
  /** Access of a new entry, default `read`; an existing entry keeps its access. */
  readonly access?: RepoAccess
  /** Features turned on in addition to the ones already on. */
  readonly features?: readonly string[]
}

/** Outcome of {@link DshRepoService.repoAdd}. */
export interface RepoAddResult {
  /** `added`: a new entry; `updated`: features were turned on; `unchanged`: nothing to do. */
  readonly status: 'added' | 'updated' | 'unchanged'
  readonly repo: CatalogRepo
}

/** Parameters of {@link DshRepoService.branchList}. */
export interface BranchListParams extends RepoParams, PageParams {
  /** Substring of the branch name. */
  readonly search?: string
}

/** Parameters of {@link DshRepoService.branchGet}. */
export interface BranchGetParams extends RepoParams {
  readonly name: string
}

/** Parameters of {@link DshRepoService.branchDelete}. */
export interface BranchDeleteParams extends RepoParams {
  readonly branch: string
}

/** Parameters of {@link DshRepoService.commitList}. */
export interface CommitListParams extends RepoParams, PageParams {
  /** Branch, tag, or commit; default: the default branch. */
  readonly ref?: string
  /** Only commits touching this path. */
  readonly path?: string
}

/** Parameters of {@link DshRepoService.treeList}. */
export interface TreeListParams extends RepoParams {
  /** Directory from the repository root; default: the root. */
  readonly path?: string
  /** Branch, tag, or commit; default: the default branch. */
  readonly ref?: string
  readonly recursive?: boolean
}

/** Parameters of {@link DshRepoService.fileRead}. */
export interface FileReadParams extends RepoParams {
  readonly path: string
  /** Branch, tag, or commit; default: the default branch. */
  readonly ref?: string
}

/** Parameters of {@link DshRepoService.issueList}. */
export interface IssueListParams extends RepoParams, PageParams {
  /** Default `open`. */
  readonly state?: IssueState | 'all'
  /** Issues carrying all these labels. */
  readonly labels?: readonly string[]
  readonly assignee?: string
  /** Words in the title or description. */
  readonly search?: string
}

/** Parameters naming one issue or pull/merge request. */
export interface NumberParams extends RepoParams {
  /** Number (GitHub) or project-scoped IID (GitLab), as shown in the web UI. */
  readonly number: number
}

/** Parameters of {@link DshRepoService.issueCreate}. */
export interface IssueCreateParams extends RepoParams {
  readonly title: string
  /** The tools' signature setting is appended. */
  readonly body?: string
  readonly labels?: readonly string[]
  /** Usernames. */
  readonly assignees?: readonly string[]
}

/** Parameters of {@link DshRepoService.issueUpdate}; omitted fields stay. */
export interface IssueUpdateParams extends NumberParams {
  readonly title?: string
  readonly body?: string
  readonly state?: IssueState
  /** Replaces the labels. */
  readonly labels?: readonly string[]
  /** Replaces the assignees (usernames). */
  readonly assignees?: readonly string[]
}

/** Parameters of {@link DshRepoService.issueComment} and {@link DshRepoService.mrComment}. */
export interface CommentParams extends NumberParams {
  /** The tools' signature setting is appended. */
  readonly body: string
}

/** Parameters of {@link DshRepoService.mrList}. */
export interface MrListParams extends RepoParams, PageParams {
  /** Default `open`. */
  readonly state?: MrState | 'all'
  /** Branch of this repository the requests come from; requests from forks are left out. */
  readonly sourceBranch?: string
  readonly targetBranch?: string
}

/** Parameters of {@link DshRepoService.mrCreate}. */
export interface MrCreateParams extends RepoParams {
  readonly title: string
  /** The tools' signature setting is appended. */
  readonly body?: string
  readonly sourceBranch: string
  /** Default: the repository's default branch. */
  readonly targetBranch?: string
  readonly draft?: boolean
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Parameters of {@link DshRepoService.mrUpdate}; omitted fields stay. */
export interface MrUpdateParams extends NumberParams {
  readonly title?: string
  readonly body?: string
  /** `closed` closes, `open` reopens. */
  readonly state?: 'open' | 'closed'
  readonly targetBranch?: string
  readonly labels?: readonly string[]
  readonly assignees?: readonly string[]
}

/** Parameters of {@link DshRepoService.mrMerge}. */
export interface MrMergeParams extends NumberParams {
  /** The head the request must still have; refused with `conflict` when it moved. */
  readonly headSha: string
  /** Default: the repository's setting. GitLab honors `squash`; `rebase` is GitHub only. */
  readonly method?: MergeMethod
}

/** Parameters of {@link DshRepoService.mrWatch}. */
export interface MrWatchParams extends NumberParams {
  /** false stops watching; default true. */
  readonly watch?: boolean
}

/** Outcome of {@link DshRepoService.mrWatch}. */
export interface MrWatchResult {
  readonly watching: boolean
  /** With `watch: false`: whether a watch was stopped. */
  readonly stopped?: boolean
  readonly number: number
  readonly title?: string
  readonly webUrl?: string
}

/** Parameters of {@link DshRepoService.ciList}. */
export interface CiListParams extends RepoParams, PageParams {
  /** Branch or tag. */
  readonly ref?: string
  /** Full commit id. */
  readonly sha?: string
  /** Pull/merge request: on GitLab its pipelines, on GitHub the runs of its current head commit. Not with {@link ref} or {@link sha}. */
  readonly number?: number
  readonly state?: 'pending' | 'running' | 'success' | 'failure' | 'canceled'
}

/** Parameters of {@link DshRepoService.ciGet}. */
export interface CiGetParams extends RepoParams {
  /** GitLab pipeline id or GitHub workflow run id. */
  readonly runId: number
  /** Keep only failed jobs. */
  readonly onlyFailed?: boolean
}

/** Parameters of {@link DshRepoService.ciLog}. */
export interface CiLogParams extends RepoParams {
  readonly jobId: number
  /** Return the lines containing any of these texts (ignoring case), with context, instead of the end of the log. */
  readonly search?: readonly string[]
  /** Lines kept before and after each matching line; default 3, at most 50. */
  readonly context?: number
  /** Only lines inside a section whose title contains this text, ignoring case: a GitLab section (`step_script`, `after_script`, …) or a GitHub group (`Run npm test`). */
  readonly section?: string
  /** Without {@link search}: end before this line number, to read the part before an earlier excerpt. */
  readonly beforeLine?: number
}

/** Parameters of {@link DshRepoService.ciRetry} and {@link DshRepoService.ciCancel}: exactly one of a run and a job. */
export type CiActionParams = RepoParams & ({ readonly runId: number; readonly jobId?: undefined } | { readonly jobId: number; readonly runId?: undefined })

/** Parameters of {@link DshRepoService.snapshotAcquire}. */
export interface SnapshotAcquireParams extends RepoParams {
  /** Branch, tag, or full commit id; default: the catalog entry's branch, or the default branch. */
  readonly ref?: string
}

/**
 * Read-only plain files of one commit (no `.git`), shared by every holder of
 * the same repository and commit. The directory stays unchanged until every
 * holder released it; release exactly once.
 */
export interface SnapshotLease {
  /** Catalog address of the repository. */
  readonly repo: string
  readonly commit: string
  /** Absolute directory of the files. */
  readonly path: string
  release(): void
}

/** Parameters of {@link DshRepoService.workspaceCreate}. */
export interface WorkspaceCreateParams extends RepoParams {
  /**
   * Absolute directory of the new workspace: missing or empty, and not inside
   * another workspace or the mirror directory. The tool defaults to a new
   * directory under the Session's working directory and requires it inside
   * the Session's directory; the service requires it.
   */
  readonly path?: string
  /** Branch the work merges into, and starts from unless {@link branch} exists; default: the default branch. */
  readonly base?: string
  /** Full commit id on {@link base} to start from; not when {@link branch} already exists. */
  readonly commit?: string
  /**
   * Remote branch the workspace pushes to. An existing branch is continued
   * from its head; a missing one is created from the start point on the first
   * push. Default `dsh/<first 8 characters of the Session id>` (a random
   * suffix without a Session). Never the default branch, {@link base}, or a
   * protected branch.
   */
  readonly branch?: string
}

/**
 * A workspace: an ordinary git clone with its own `.git`, whose `origin`
 * reaches the remote through dsh-repo's local git proxy, so plain `git fetch`
 * and `git push` work there without a token. Pushes to the default branch, to
 * protected branches, of tags, and branch deletions are refused.
 */
export interface WorkspaceInfo {
  /** Random id, 16 lowercase hex characters. */
  readonly id: string
  /** Catalog address of the repository. */
  readonly repo: string
  /** Absolute directory. */
  readonly path: string
  /** Branch the work merges into. */
  readonly base: string
  /** Commit the work started from. */
  readonly baseCommit: string
  /** Remote branch the workspace pushes to. */
  readonly branch: string
  /** Session that created it; the proxy authorizes pushes for it. */
  readonly session?: string
  readonly createdAt: string
}

/** Parameters of {@link DshRepoService.workspaceList}. */
export interface WorkspaceListParams {
  /** Only workspaces of this repository. */
  readonly repo?: RepoTarget
}

/** Parameters naming one workspace. */
export interface WorkspacePathParams {
  /** The workspace directory or a directory inside it; the tool defaults to the Session's working directory. */
  readonly path?: string
}

/** One file that differs from the workspace's start commit. */
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

/** What a workspace changed since its start commit, committed or not. */
export interface WorkspaceStatus {
  readonly workspace: WorkspaceInfo
  /** Commit checked out now. */
  readonly head: string
  /** Local branch checked out now; absent on a detached head. */
  readonly currentBranch?: string
  /** Commits on top of the start commit, oldest first. */
  readonly commits: readonly { readonly sha: string; readonly subject: string }[]
  /** Commits not yet on the remote branch, as the workspace last saw it. */
  readonly unpushed: number
  /** Whether the working tree has changes that are not committed. */
  readonly uncommitted: boolean
  /** Files differing between the start commit and the working tree (untracked included, ignored excluded). */
  readonly files: readonly WorkspaceFileChange[]
  /** Unified diff from the start commit to the working tree. */
  readonly diff: string
  /** Whether {@link diff} was cut at the configured diff limit. */
  readonly truncated: boolean
}

/** Parameters of {@link DshRepoService.workspacePush}. */
export interface WorkspacePushParams extends WorkspacePathParams {
  /** Message of the commit recording uncommitted changes; required when there are any. */
  readonly message?: string
  /** Replace the remote branch when it moved, as long as it is where the workspace last saw it (`git push --force-with-lease`). */
  readonly forceWithLease?: boolean
  /** Open a pull/merge request from the branch unless one is open already. */
  readonly mr?: {
    readonly title: string
    readonly body?: string
    /** Default: the workspace's base branch. */
    readonly target?: string
    readonly draft?: boolean
  }
}

/** A pull/merge request a push reported. */
export interface MrSummary {
  readonly number: number
  readonly title: string
  readonly targetBranch: string
  readonly webUrl: string
}

/** Outcome of {@link DshRepoService.workspacePush}. */
export interface WorkspacePushResult extends WatchState {
  readonly repo: string
  readonly path: string
  readonly branch: string
  readonly base: string
  /** Commit the remote branch points to after the push. */
  readonly commit: string
  /** Whether this push committed uncommitted changes. */
  readonly committed: boolean
  /** Author of that commit. */
  readonly author?: CommitAuthor
  /** Whether this push created the remote branch. */
  readonly created: boolean
  /** Open requests from the branch after the push, including one opened for {@link WorkspacePushParams.mr}. */
  readonly openMrs: readonly MrSummary[]
  /** The request opened for {@link WorkspacePushParams.mr}; absent when one was already open or none was asked for. */
  readonly createdMr?: MrSummary
  /** Why listing or opening requests failed; the push itself succeeded. */
  readonly mrError?: string
}

/** Parameters of {@link DshRepoService.workspaceRemove}. */
export interface WorkspaceRemoveParams {
  /** The workspace directory. */
  readonly path: string
  /** Delete even with uncommitted changes or unpushed commits. */
  readonly force?: boolean
}

/** Outcome of {@link DshRepoService.workspaceRemove}. */
export interface WorkspaceRemoveResult {
  readonly path: string
  /** Unpushed commits that were deleted with it. */
  readonly discardedCommits: number
  /** Whether uncommitted changes were deleted with it. */
  readonly discardedChanges: boolean
}

/**
 * Settings other plugins and the settings page read and change. The mirror
 * directory has no default: while it is unset, every call that needs a mirror
 * (snapshots, workspaces, the proxy) rejects with `unavailable`.
 */
export interface RepoPublicSettings {
  /** Absolute directory holding the mirrors and snapshots; undefined while none is chosen or the stored choice is unusable. */
  readonly mirrorDir: string | undefined
  /** Why the stored mirror directory is not in use; absent otherwise. */
  readonly mirrorProblem?: string
  /** Directory the settings page creates workspaces in; undefined while none is chosen. */
  readonly workspaceDir: string | undefined
  /** Configured proxy port; 0 picks one. */
  readonly proxyPort: number
  /** Port the proxy listens on now; absent while it is not running. */
  readonly proxyListening?: number
  /** Commit name of new workspaces; empty uses the token account's name. */
  readonly commitName: string
  /** Commit email of new workspaces; empty uses the token account's email. */
  readonly commitEmail: string
}

/** Fields of {@link DshRepoService.settingsUpdate}; omitted fields stay, `null` clears a directory. */
export interface RepoSettingsUpdate {
  /** Absolute directory (`~` expands); not inside `$DSH_HOME`, the system temporary directory, or `/tmp`; created when missing. */
  readonly mirrorDir?: string | null
  /** Absolute directory; created when missing. */
  readonly workspaceDir?: string | null
  readonly proxyPort?: number
  readonly commitName?: string
  readonly commitEmail?: string
}

/** The `dshRepos` service. */
export interface DshRepoService {
  readonly version: DshReposVersion

  /** @returns the catalog repositories in catalog order. */
  repoList(params?: RepoListParams & CallOptions): Promise<readonly CatalogRepo[]>
  /** @returns repository metadata. */
  repoGet(params: RepoParams & CallOptions): Promise<RepoInfo>
  /**
   * Add a repository to the catalog, or turn features on for the entry that holds it; asks `access/authorize` at level `admin`.
   * @returns the outcome and the entry.
   * @throws `invalid` for a bad address, branch, or feature id; `not-allowed` for an unconfigured host; `conflict` when the entry follows another branch; `too-large` when the catalog is full.
   */
  repoAdd(params: RepoAddParams & WriteOptions): Promise<RepoAddResult>

  /** @returns one page of branches. */
  branchList(params: BranchListParams & CallOptions): Promise<Page<BranchInfo>>
  /** @returns the branch, or null when the repository has no branch of that name. */
  branchGet(params: BranchGetParams & CallOptions): Promise<BranchInfo | null>
  /**
   * Delete a branch whose head is the head of a merged request from this repository and from which no request is open.
   * @returns the deleted branch and the request that merged it.
   * @throws `not-found` for a missing branch, `forbidden` for the default or a protected branch, `conflict` when its head is not merged or a request from it is open.
   */
  branchDelete(params: BranchDeleteParams & WriteOptions): Promise<MergedBranchDeletion>

  /** @returns one page of commits, newest first. */
  commitList(params: CommitListParams & CallOptions): Promise<Page<CommitInfo>>
  /** @returns entries below the path at the ref, read through the host API. */
  treeList(params: TreeListParams & CallOptions): Promise<TreeListing>
  /** @returns one file at the ref, read through the host API. */
  fileRead(params: FileReadParams & CallOptions): Promise<FileContent>

  /** @returns one page of issues (requests excluded). */
  issueList(params: IssueListParams & CallOptions): Promise<Page<IssueInfo>>
  /** @returns the issue and its first page of comments. */
  issueGet(params: NumberParams & CallOptions): Promise<IssueDetail>
  /** @returns the new issue. */
  issueCreate(params: IssueCreateParams & WriteOptions): Promise<IssueInfo>
  /** @returns the updated issue. */
  issueUpdate(params: IssueUpdateParams & WriteOptions): Promise<IssueInfo>
  /** @returns the new comment. */
  issueComment(params: CommentParams & WriteOptions): Promise<CommentInfo>

  /** @returns one page of pull/merge requests. */
  mrList(params: MrListParams & CallOptions): Promise<Page<MrInfo>>
  /** @returns the request and its first page of conversation comments. */
  mrGet(params: NumberParams & CallOptions): Promise<MrDetail>
  /** @returns the request's unified diff. */
  mrDiff(params: NumberParams & CallOptions): Promise<MrDiff>
  /** @returns CI and merge readiness. */
  mrStatus(params: NumberParams & CallOptions): Promise<MrStatus>
  /** @returns the new request, watched for the Agent's Session while watching is on. */
  mrCreate(params: MrCreateParams & WriteOptions): Promise<MrInfo & WatchState>
  /** @returns the updated request; a reopened one is watched again for the Agent's Session. */
  mrUpdate(params: MrUpdateParams & WriteOptions): Promise<MrInfo & Partial<WatchState>>
  /** @returns the new comment. */
  mrComment(params: CommentParams & WriteOptions): Promise<CommentInfo>
  /** @returns the merge outcome; needs catalog access `merge`. */
  mrMerge(params: MrMergeParams & WriteOptions): Promise<MergeResult>
  /**
   * Watch a request for the Agent's Session, or stop watching it.
   * @throws `invalid` without an Agent Session, `unavailable` while watching is off.
   */
  mrWatch(params: MrWatchParams & CallOptions & { readonly agent: CallerAgent }): Promise<MrWatchResult>

  /** @returns one page of CI runs, newest first. */
  ciList(params: CiListParams & CallOptions): Promise<Page<CiRun>>
  /** @returns the run with its jobs; for a failed run also the failed tests (GitLab) or failure annotations (GitHub). */
  ciGet(params: CiGetParams & CallOptions): Promise<CiRunDetail>
  /**
   * Read an excerpt of a job's log: its end, or the lines matching a search.
   * @throws `not-found` for a missing job or log (GitHub serves a log only once the job finished).
   */
  ciLog(params: CiLogParams & CallOptions): Promise<CiJobLog>
  /** @returns what was retried. */
  ciRetry(params: CiActionParams & WriteOptions): Promise<CiActionResult>
  /**
   * Cancel a run, or one job (GitLab only).
   * @throws `invalid` for a job on GitHub.
   */
  ciCancel(params: CiActionParams & WriteOptions): Promise<CiActionResult>

  /**
   * Fetch the mirror and hold read-only files of a commit, creating them on first use.
   * @returns the lease.
   * @throws `not-found` for a missing ref, `unavailable` while no mirror directory is set or git fails.
   */
  snapshotAcquire(params: SnapshotAcquireParams & CallOptions): Promise<SnapshotLease>
  /**
   * Clone the repository into a new workspace (objects borrowed from the mirror) and check out its branch.
   * @returns the workspace.
   * @throws `invalid` for a bad path, branch, or commit; `not-found` for a missing base or commit; `unavailable` while no mirror directory is set or git fails.
   */
  workspaceCreate(params: WorkspaceCreateParams & WriteOptions & { readonly path: string }): Promise<WorkspaceInfo>
  /** @returns the workspaces whose directories still exist, oldest first. */
  workspaceList(params?: WorkspaceListParams & CallOptions): Promise<readonly WorkspaceInfo[]>
  /**
   * Describe what a workspace changed since its start commit.
   * @throws `not-found` when the path is not inside a workspace.
   */
  workspaceStatus(params: WorkspacePathParams & CallOptions & { readonly path: string }): Promise<WorkspaceStatus>
  /**
   * Commit uncommitted changes, push `HEAD` to the workspace's branch through the proxy, and with `mr` open a request unless one is open.
   * @returns the push outcome.
   * @throws `invalid` for a missing message or nothing to push; `conflict` when the remote branch moved; `forbidden` when the host or `access/authorize` refused; `not-found` when the path is not inside a workspace.
   */
  workspacePush(params: WorkspacePushParams & WriteOptions & { readonly path: string }): Promise<WorkspacePushResult>
  /**
   * Delete a workspace's directory and record.
   * @returns what was discarded.
   * @throws `conflict` with uncommitted changes or unpushed commits unless `force`; `not-found` when the path is not a workspace.
   */
  workspaceRemove(params: WorkspaceRemoveParams & CallOptions): Promise<WorkspaceRemoveResult>

  /**
   * Resolve a target against the configured hosts without calling the host.
   * @returns the resolved repository.
   */
  repoResolve(repo: RepoTarget): RepoRef
  /**
   * Observe every successful catalog change; a throwing listener does not affect the change.
   * @returns disposer.
   */
  repoOnChange(listener: () => void): () => void
  /** @returns every host, configured ones first, with the status of its token. */
  hostList(): Promise<readonly HostInfo[]>
  /**
   * Add a host and persist it; with `token`, store it in DSH's credential store.
   * @throws `invalid` for a bad address or alias, `conflict` when the address is taken.
   */
  hostAdd(params: HostCreate): Promise<HostInfo>
  /**
   * Remove an added host and its stored token.
   * @throws `not-found` for an unknown address, `forbidden` for a configured host.
   */
  hostRemove(params: { readonly url: string }): Promise<void>
  /**
   * Store (string) or remove (null) a host's token.
   * @returns the host with its new token status.
   * @throws `not-found` for an unknown address, `invalid` for an unusable token.
   */
  hostSetToken(params: { readonly url: string; readonly token: string | null }): Promise<HostInfo>
  /**
   * Observe host, token, and mirror directory changes; a throwing listener does not affect the change.
   * @returns disposer.
   */
  hostOnChange(listener: (change: HostsChange) => void): () => void
  /**
   * Offer a feature as a per-repository switch on the settings page until the disposer runs.
   * @returns disposer.
   * @throws `invalid` for a bad id, title, or description.
   */
  featureRegister(feature: RepoFeature): () => void
  /** @returns the settings other plugins may read. */
  settingsGet(): RepoPublicSettings
  /**
   * Change settings; a new proxy port restarts the proxy and rewrites every workspace's configuration.
   * @returns the settings now in effect.
   * @throws `invalid` for a bad directory or value, `unavailable` when the settings file cannot be written.
   */
  settingsUpdate(update: RepoSettingsUpdate): Promise<RepoPublicSettings>
}
