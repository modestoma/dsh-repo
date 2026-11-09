/**
 * GitHub provider on the official `@octokit/rest` SDK: github.com and GitHub
 * Enterprise Server (`<url>/api/v3`). Pull requests are this module's change
 * requests.
 *
 * @module dsh-repo/providers/github
 */

import { Octokit } from '@octokit/rest'
import type {
  BranchInfo, MrInfo, MrState, MrStatus, CheckInfo, CheckState, CiActionResult, CiFailure, CiJob, CiRun, CiRunDetail, CiState, CommentInfo, CommitAuthor, CommitInfo,
  IssueInfo, RepoInfo, RepoRef, RepoUser, SourceBranchDeletion, TreeEntry,
} from '../contract.ts'
import { RepoError } from '../errors.ts'
import { capFailures, errorText, nextPage, okBody, titleOf, truncateBytes } from './types.ts'
import type { ActivityItem, ActivityRequest, Call, ChangeActivity, CiRunQuery, Paging, Provider, TokenSource } from './types.ts'

/** GitHub's largest page. */
const PAGE = 100

/** Pages of check runs or statuses read before giving up on a complete status. */
const MAX_STATUS_PAGES = 10

interface GithubUser { readonly login: string; readonly html_url?: string }
interface GithubLabel { readonly name?: string }

function user(value: GithubUser | null | undefined): RepoUser {
  return value === null || value === undefined ? { username: 'ghost' } : { username: value.login, ...value.html_url === undefined ? {} : { webUrl: value.html_url } }
}

function labelNames(labels: ReadonlyArray<string | GithubLabel>): string[] {
  return labels.map(label => typeof label === 'string' ? label : label.name ?? '').filter(name => name !== '')
}

function split(path: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = path.split('/')
  return { owner, repo }
}

interface GithubIssue {
  readonly number: number
  readonly title: string
  readonly body?: string | null
  readonly state: string
  readonly user: GithubUser | null
  readonly labels: ReadonlyArray<string | GithubLabel>
  readonly assignees?: readonly GithubUser[] | null
  readonly created_at: string
  readonly updated_at: string
  readonly html_url: string
}

function issue(value: GithubIssue): IssueInfo {
  return {
    number: value.number,
    title: value.title,
    body: value.body ?? '',
    state: value.state === 'closed' ? 'closed' : 'open',
    author: user(value.user),
    labels: labelNames(value.labels),
    assignees: (value.assignees ?? []).map(user),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    webUrl: value.html_url,
  }
}

interface GithubPull {
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly state: string
  readonly draft?: boolean
  readonly merged_at: string | null
  readonly head: { readonly ref: string; readonly sha: string }
  readonly base: { readonly ref: string }
  readonly user: GithubUser | null
  readonly labels: readonly GithubLabel[]
  readonly assignees?: readonly GithubUser[] | null
  readonly created_at: string
  readonly updated_at: string
  readonly html_url: string
}

function pull(value: GithubPull): MrInfo {
  const state: MrState = value.merged_at !== null ? 'merged' : value.state === 'closed' ? 'closed' : 'open'
  return {
    number: value.number,
    title: value.title,
    body: value.body ?? '',
    state,
    draft: value.draft === true,
    sourceBranch: value.head.ref,
    targetBranch: value.base.ref,
    headSha: value.head.sha,
    author: user(value.user),
    labels: labelNames(value.labels),
    assignees: (value.assignees ?? []).map(user),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    webUrl: value.html_url,
  }
}

interface GithubComment {
  readonly id: number
  readonly user: GithubUser | null
  readonly body?: string
  readonly created_at: string
  readonly html_url: string
}

function comment(value: GithubComment): CommentInfo {
  return { id: String(value.id), author: user(value.user), body: value.body ?? '', createdAt: value.created_at, webUrl: value.html_url }
}

function overall(checks: readonly CheckInfo[]): CheckState {
  if (checks.length === 0) return 'none'
  if (checks.some(check => check.state === 'failure')) return 'failure'
  if (checks.some(check => check.state === 'pending')) return 'pending'
  return 'success'
}

function checkRunState(status: string, conclusion: string | null): CheckInfo['state'] {
  if (status !== 'completed') return 'pending'
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required' || conclusion === 'startup_failure' || conclusion === 'cancelled'
    ? 'failure'
    : 'success'
}

/** Run, job, and step status with conclusion as {@link CiState}. */
function ciState(status: string | null, conclusion: string | null | undefined): CiState {
  if (status === 'in_progress') return 'running'
  if (status !== 'completed') return 'pending'
  switch (conclusion) {
    case 'success':
    case 'neutral': return 'success'
    case 'cancelled': return 'canceled'
    case 'skipped':
    case 'stale': return 'skipped'
    case 'action_required': return 'manual'
    case null:
    case undefined: return 'pending'
    default: return 'failure'
  }
}

/** {@link CiRunQuery.state} as a workflow run status filter. */
const RUN_STATUS = { pending: 'queued', running: 'in_progress', success: 'success', failure: 'failure', canceled: 'cancelled' } as const

/** The workflow run and job of a GitHub Actions check run, read off its URL. */
const ACTIONS_JOB_URL = /\/actions\/runs\/(\d+)\/jobs?\/(\d+)/

function actionsIds(url: string | null): { runId?: number; jobId?: number } {
  const match = url === null ? null : ACTIONS_JOB_URL.exec(url)
  return match === null ? {} : { runId: Number(match[1]), jobId: Number(match[2]) }
}

interface GithubRun {
  readonly id: number
  readonly name?: string | null
  readonly status: string | null
  readonly conclusion: string | null
  readonly head_branch: string | null
  readonly head_sha: string
  readonly event: string
  readonly created_at: string
  readonly updated_at: string
  readonly run_started_at?: string
  readonly run_attempt?: number
  readonly html_url: string
}

function workflowRun(value: GithubRun): CiRun {
  return {
    id: value.id,
    ...value.name === undefined || value.name === null ? {} : { name: value.name },
    state: ciState(value.status, value.conclusion),
    status: value.conclusion ?? value.status ?? 'unknown',
    ref: value.head_branch ?? '',
    sha: value.head_sha,
    event: value.event,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...value.run_attempt === undefined ? {} : { attempt: value.run_attempt },
    webUrl: value.html_url,
  }
}

interface GithubJob {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly started_at: string
  readonly completed_at: string | null
  readonly html_url: string | null
  readonly steps?: readonly { readonly name: string; readonly status: string; readonly conclusion: string | null; readonly number: number }[]
}

function seconds(from: string | undefined, to: string | null | undefined): number | undefined {
  if (from === undefined || to === undefined || to === null) return undefined
  const span = Date.parse(to) - Date.parse(from)
  return Number.isFinite(span) && span >= 0 ? Math.round(span / 1000) : undefined
}

function actionsJob(value: GithubJob): CiJob {
  const duration = seconds(value.started_at, value.completed_at)
  return {
    id: value.id,
    name: value.name,
    state: ciState(value.status, value.conclusion),
    status: value.conclusion ?? value.status,
    allowFailure: false,
    startedAt: value.started_at,
    ...value.completed_at === null ? {} : { finishedAt: value.completed_at },
    ...duration === undefined ? {} : { durationSeconds: duration },
    ...value.html_url === null ? {} : { webUrl: value.html_url },
    ...value.steps === undefined ? {} : { steps: value.steps.map(step => ({ number: step.number, name: step.name, state: ciState(step.status, step.conclusion), status: step.conclusion ?? step.status })) },
  }
}

/** GitHub provider bound to one host. */
export class GithubProvider implements Provider {
  private readonly octokit: Octokit

  /**
   * @param baseUrl - REST base URL (`https://api.github.com` or `<url>/api/v3`).
   * @param token - resolves the host's token for every request.
   */
  constructor(private readonly baseUrl: string, private readonly token: TokenSource) {
    this.octokit = new Octokit({
      baseUrl,
      userAgent: 'dsh-repo',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    })
    this.octokit.hook.before('request', async (options) => {
      options.headers.authorization = `token ${await token()}`
    })
  }

  async currentUser(call: Call): Promise<CommitAuthor> {
    const { data } = await this.octokit.rest.users.getAuthenticated({ request: { signal: call.signal } })
    const api = new URL(this.baseUrl)
    const web = api.hostname === 'api.github.com' ? 'github.com' : api.host
    return { name: data.name ?? data.login, email: data.email ?? `${data.id}+${data.login}@users.noreply.${web}` }
  }

  async repoInfo(ref: RepoRef, call: Call): Promise<RepoInfo> {
    const { data } = await this.octokit.rest.repos.get({ ...split(ref.path), request: { signal: call.signal } })
    return {
      ...ref,
      webUrl: data.html_url,
      defaultBranch: data.default_branch,
      ...data.description === null ? {} : { description: data.description },
      visibility: data.visibility === 'internal' ? 'internal' : data.private ? 'private' : 'public',
      archived: data.archived,
      cloneUrl: data.clone_url,
    }
  }

  async listBranches(ref: RepoRef, query: { page: number; perPage: number; search?: string }, call: Call) {
    const [{ data }, info] = await Promise.all([
      this.octokit.rest.repos.listBranches({ ...split(ref.path), page: query.page, per_page: query.perPage, request: { signal: call.signal } }),
      this.octokit.rest.repos.get({ ...split(ref.path), request: { signal: call.signal } }),
    ])
    const items: BranchInfo[] = data
      .filter(branch => query.search === undefined || branch.name.includes(query.search))
      .map(branch => ({ name: branch.name, commit: branch.commit.sha, protected: branch.protected, default: branch.name === info.data.default_branch }))
    return { items, ...nextPage(query, data.length) }
  }

  async deleteBranch(ref: RepoRef, name: string, call: Call) {
    await this.octokit.rest.git.deleteRef({ ...split(ref.path), ref: `heads/${name}`, request: { signal: call.signal } })
  }

  async getBranch(ref: RepoRef, name: string, call: Call) {
    const [branch, info] = await Promise.all([
      this.octokit.rest.repos.getBranch({ ...split(ref.path), branch: name, request: { signal: call.signal } }).catch((error: unknown) => {
        if ((error as { status?: number }).status === 404) return undefined
        throw error
      }),
      this.repoInfo(ref, call),
    ])
    // GitHub answers a renamed branch with the branch it was renamed to.
    if (branch === undefined || branch.data.name !== name) return undefined
    return { name, commit: branch.data.commit.sha, protected: branch.data.protected, default: name === info.defaultBranch }
  }

  async listCommits(ref: RepoRef, query: { page: number; perPage: number; ref?: string; path?: string }, call: Call) {
    const { data } = await this.octokit.rest.repos.listCommits({
      ...split(ref.path),
      page: query.page,
      per_page: query.perPage,
      ...query.ref === undefined ? {} : { sha: query.ref },
      ...query.path === undefined ? {} : { path: query.path },
      request: { signal: call.signal },
    })
    const items: CommitInfo[] = data.map(entry => ({
      sha: entry.sha,
      title: titleOf(entry.commit.message),
      message: entry.commit.message,
      authorName: entry.commit.author?.name ?? entry.author?.login ?? '',
      ...entry.commit.author?.email === undefined ? {} : { authorEmail: entry.commit.author.email },
      ...entry.commit.author?.date === undefined ? {} : { authoredAt: entry.commit.author.date },
      webUrl: entry.html_url,
    }))
    return { items, ...nextPage(query, data.length) }
  }

  async listTree(ref: RepoRef, query: { ref?: string; path: string; recursive: boolean }, call: Call) {
    const at = query.ref ?? (await this.repoInfo(ref, call)).defaultBranch
    const max = call.limits.maxTreeEntries
    // The Trees API reports its own truncation; the Contents API silently stops at 1,000 entries.
    const treeish = query.path === '' ? at : `${at}:${query.path}`
    const { data } = await this.octokit.rest.git.getTree({
      ...split(ref.path),
      tree_sha: treeish,
      ...query.recursive ? { recursive: 'true' } : {},
      request: { signal: call.signal },
    })
    const prefix = query.path === '' ? '' : `${query.path}/`
    const entries: TreeEntry[] = data.tree.map(entry => ({
      path: `${prefix}${entry.path ?? ''}`,
      type: entry.type === 'tree' ? 'dir' : entry.type === 'commit' ? 'submodule' : entry.mode === '120000' ? 'symlink' : 'file',
      ...entry.size === undefined ? {} : { size: entry.size },
    }))
    return { ref: at, entries: entries.slice(0, max), truncated: data.truncated || entries.length > max }
  }

  async readFile(ref: RepoRef, path: string, at: string | undefined, call: Call) {
    const target = at ?? (await this.repoInfo(ref, call)).defaultBranch
    const response = await this.octokit.rest.repos.getContent({
      ...split(ref.path),
      path,
      ref: target,
      mediaType: { format: 'raw' },
      request: { signal: call.signal },
    })
    const raw: unknown = response.data
    if (typeof raw !== 'string') throw new RepoError('invalid', `${path} 不是文件`)
    if (raw.includes('\0')) return { path, ref: target, text: '', binary: true, truncated: false }
    return { path, ref: target, binary: false, ...truncateBytes(raw, call.limits.maxFileBytes) }
  }

  async listIssues(ref: RepoRef, query: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; labels?: readonly string[]; assignee?: string; search?: string }, call: Call) {
    if (query.search !== undefined) {
      // The issues endpoint has no text filter; the search API does, with the same filters as qualifiers.
      const qualifiers = [
        `repo:${ref.path}`,
        'is:issue',
        ...query.state === 'all' ? [] : [`state:${query.state}`],
        ...(query.labels ?? []).map(label => `label:"${label.replace(/"/g, '')}"`),
        ...query.assignee === undefined ? [] : [`assignee:${query.assignee}`],
      ]
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({ q: `${query.search} ${qualifiers.join(' ')}`, page: query.page, per_page: query.perPage, request: { signal: call.signal } })
      return { items: data.items.filter(entry => entry.pull_request === undefined).map(entry => issue(entry as Parameters<typeof issue>[0])), ...nextPage(query, data.items.length) }
    }
    const { data } = await this.octokit.rest.issues.listForRepo({
      ...split(ref.path),
      state: query.state,
      page: query.page,
      per_page: query.perPage,
      ...query.labels === undefined || query.labels.length === 0 ? {} : { labels: query.labels.join(',') },
      ...query.assignee === undefined ? {} : { assignee: query.assignee },
      request: { signal: call.signal },
    })
    // The issues endpoint also lists pull requests; they are change requests here.
    return { items: data.filter(entry => entry.pull_request === undefined).map(issue), ...nextPage(query, data.length) }
  }

  async getIssue(ref: RepoRef, number: number, call: Call) {
    const repo = split(ref.path)
    const [{ data }, comments] = await Promise.all([
      this.octokit.rest.issues.get({ ...repo, issue_number: number, request: { signal: call.signal } }),
      this.comments(ref, number, call),
    ])
    if (data.pull_request !== undefined) throw new RepoError('not-found', `#${number} 是 PR，不是 issue；请用 PR/MR 相关接口`)
    return { ...issue(data), comments }
  }

  async createIssue(ref: RepoRef, fields: { title: string; body?: string; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const { data } = await this.octokit.rest.issues.create({
      ...split(ref.path),
      title: fields.title,
      ...fields.body === undefined ? {} : { body: fields.body },
      ...fields.labels === undefined ? {} : { labels: [...fields.labels] },
      ...fields.assignees === undefined ? {} : { assignees: [...fields.assignees] },
      request: { signal: call.signal },
    })
    return issue(data)
  }

  async updateIssue(ref: RepoRef, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const { data } = await this.octokit.rest.issues.update({
      ...split(ref.path),
      issue_number: number,
      ...update.title === undefined ? {} : { title: update.title },
      ...update.body === undefined ? {} : { body: update.body },
      ...update.state === undefined ? {} : { state: update.state },
      ...update.labels === undefined ? {} : { labels: [...update.labels] },
      ...update.assignees === undefined ? {} : { assignees: [...update.assignees] },
      request: { signal: call.signal },
    })
    return issue(data)
  }

  async commentIssue(ref: RepoRef, number: number, body: string, call: Call) {
    const { data } = await this.octokit.rest.issues.createComment({ ...split(ref.path), issue_number: number, body, request: { signal: call.signal } })
    return comment(data)
  }

  async listChanges(ref: RepoRef, query: { page: number; perPage: number; state: MrState | 'all'; sourceBranch?: string; targetBranch?: string }, call: Call) {
    const repo = split(ref.path)
    const { data } = await this.octokit.rest.pulls.list({
      ...repo,
      state: query.state === 'merged' ? 'closed' : query.state,
      page: query.page,
      per_page: query.perPage,
      ...query.sourceBranch === undefined ? {} : { head: `${repo.owner}:${query.sourceBranch}` },
      ...query.targetBranch === undefined ? {} : { base: query.targetBranch },
      request: { signal: call.signal },
    })
    const items = data.map(pull).filter(change => query.state === 'all' || change.state === query.state)
    return { items, ...nextPage(query, data.length) }
  }

  async getChange(ref: RepoRef, number: number, call: Call) {
    const [{ data }, comments] = await Promise.all([
      this.octokit.rest.pulls.get({ ...split(ref.path), pull_number: number, request: { signal: call.signal } }),
      this.comments(ref, number, call),
    ])
    return { ...pull(data), comments }
  }

  async changeDiff(ref: RepoRef, number: number, call: Call) {
    const response = await this.octokit.rest.pulls.get({ ...split(ref.path), pull_number: number, mediaType: { format: 'diff' }, request: { signal: call.signal } })
    const raw: unknown = response.data
    const { text, truncated } = truncateBytes(typeof raw === 'string' ? raw : '', call.limits.maxDiffBytes)
    return { diff: text, truncated }
  }

  async changeStatus(ref: RepoRef, number: number, call: Call) {
    const repo = split(ref.path)
    const { data: change } = await this.octokit.rest.pulls.get({ ...repo, pull_number: number, request: { signal: call.signal } })
    return await this.statusOf(repo, change, call.signal)
  }

  /** Pull request comments and reviews are read only when its `updated_at` moved; check runs never move it, so CI is read as asked. */
  async changeActivity(ref: RepoRef, number: number, request: ActivityRequest, call: Call): Promise<ChangeActivity> {
    const repo = split(ref.path)
    const { data } = await this.octokit.rest.pulls.get({ ...repo, pull_number: number, request: { signal: call.signal } })
    const change = pull(data)
    const [status, items] = await Promise.all([
      request.withStatus ? this.statusOf(repo, data, call.signal) : undefined,
      request.updatedAt === change.updatedAt ? undefined : this.activitySince(repo, number, request.since, call.signal),
    ])
    return { change, conflict: data.mergeable_state === 'dirty', ...status === undefined ? {} : { status }, ...items === undefined ? {} : { items } }
  }

  private async activitySince(repo: { owner: string; repo: string }, number: number, since: string, signal: AbortSignal): Promise<ActivityItem[]> {
    const [comments, lineComments, reviews] = await Promise.all([
      this.allPages(page => this.octokit.rest.issues.listComments({ ...repo, issue_number: number, since, per_page: PAGE, page, request: { signal } }).then(response => response.data), '新评论'),
      this.allPages(page => this.octokit.rest.pulls.listReviewComments({ ...repo, pull_number: number, since, sort: 'created', direction: 'asc', per_page: PAGE, page, request: { signal } }).then(response => response.data), '新行内评论'),
      this.allPages(page => this.octokit.rest.pulls.listReviews({ ...repo, pull_number: number, per_page: PAGE, page, request: { signal } }).then(response => response.data), '评审'),
    ])
    const items: ActivityItem[] = [
      ...comments.map(value => ({ ...comment(value), kind: 'comment' as const })),
      ...lineComments.map(value => ({ id: `line-${value.id}`, kind: 'comment' as const, author: user(value.user), body: value.body, createdAt: value.created_at, webUrl: value.html_url, path: value.path })),
      ...reviews.flatMap((review): ActivityItem[] => {
        const kind = review.state === 'APPROVED' ? 'approved' as const : review.state === 'CHANGES_REQUESTED' ? 'changes-requested' as const : review.state === 'COMMENTED' && review.body !== '' ? 'comment' as const : undefined
        if (kind === undefined || review.submitted_at === undefined) return []
        return [{ id: `review-${review.id}`, kind, author: user(review.user), body: review.body, createdAt: review.submitted_at, webUrl: review.html_url }]
      }),
    ]
    return items.filter(item => item.createdAt >= since).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private async statusOf(repo: { owner: string; repo: string }, change: { readonly head: { readonly sha: string }; readonly mergeable?: boolean | null }, signal: AbortSignal): Promise<MrStatus> {
    const sha = change.head.sha
    const [runs, statuses] = await Promise.all([
      this.allPages(page => this.octokit.rest.checks.listForRef({ ...repo, ref: sha, per_page: PAGE, page, request: { signal } }).then(response => response.data.check_runs), 'CI 检查'),
      this.allPages(page => this.octokit.rest.repos.getCombinedStatusForRef({ ...repo, ref: sha, per_page: PAGE, page, request: { signal } }).then(response => response.data.statuses), 'CI 检查'),
    ])
    const checks: CheckInfo[] = [
      ...runs.map(run => ({ name: run.name, state: checkRunState(run.status, run.conclusion), ...run.html_url === null ? {} : { webUrl: run.html_url }, ...actionsIds(run.html_url) })),
      ...statuses.map(status => ({
        name: status.context,
        state: status.state === 'success' ? 'success' as const : status.state === 'pending' ? 'pending' as const : 'failure' as const,
        ...status.target_url === null ? {} : { webUrl: status.target_url },
      })),
    ]
    return { headSha: sha, checks, overall: overall(checks), ...change.mergeable === null || change.mergeable === undefined ? {} : { mergeable: change.mergeable } }
  }

  /** GitHub has no per-request "delete source branch" option, so `deleteSourceBranch` is not sent. */
  async createChange(ref: RepoRef, fields: { title: string; body?: string; sourceBranch: string; targetBranch: string; draft: boolean; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const repo = split(ref.path)
    const { data } = await this.octokit.rest.pulls.create({
      ...repo,
      title: fields.title,
      head: fields.sourceBranch,
      base: fields.targetBranch,
      draft: fields.draft,
      ...fields.body === undefined ? {} : { body: fields.body },
      request: { signal: call.signal },
    })
    if ((fields.labels?.length ?? 0) === 0 && (fields.assignees?.length ?? 0) === 0) return pull(data)
    // Labels and assignees live on the pull request's issue.
    await this.octokit.rest.issues.update({
      ...repo,
      issue_number: data.number,
      ...fields.labels === undefined ? {} : { labels: [...fields.labels] },
      ...fields.assignees === undefined ? {} : { assignees: [...fields.assignees] },
      request: { signal: call.signal },
    })
    return pull((await this.octokit.rest.pulls.get({ ...repo, pull_number: data.number, request: { signal: call.signal } })).data)
  }

  async updateChange(ref: RepoRef, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; targetBranch?: string; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const repo = split(ref.path)
    const signal = call.signal
    if (update.labels !== undefined || update.assignees !== undefined) {
      await this.octokit.rest.issues.update({
        ...repo,
        issue_number: number,
        ...update.labels === undefined ? {} : { labels: [...update.labels] },
        ...update.assignees === undefined ? {} : { assignees: [...update.assignees] },
        request: { signal },
      })
    }
    const { data } = await this.octokit.rest.pulls.update({
      ...repo,
      pull_number: number,
      ...update.title === undefined ? {} : { title: update.title },
      ...update.body === undefined ? {} : { body: update.body },
      ...update.state === undefined ? {} : { state: update.state },
      ...update.targetBranch === undefined ? {} : { base: update.targetBranch },
      request: { signal },
    })
    return pull(data)
  }

  async commentChange(ref: RepoRef, number: number, body: string, call: Call) {
    return await this.commentIssue(ref, number, body, call)
  }

  async mergeChange(ref: RepoRef, number: number, request: { headSha: string; method?: 'merge' | 'squash' | 'rebase'; deleteSourceBranch: boolean }, call: Call) {
    const { data } = await this.octokit.rest.pulls.merge({
      ...split(ref.path),
      pull_number: number,
      sha: request.headSha,
      ...request.method === undefined ? {} : { merge_method: request.method },
      request: { signal: call.signal },
    })
    if (!request.deleteSourceBranch) return { sha: data.sha }
    return { sha: data.sha, sourceBranch: await this.deleteMergedHead(ref, number, call) }
  }

  /** Delete the head branch of a just-merged pull request when it lives in the same repository; never throws. */
  private async deleteMergedHead(ref: RepoRef, number: number, call: Call): Promise<SourceBranchDeletion> {
    let name = ''
    try {
      const { data } = await this.octokit.rest.pulls.get({ ...split(ref.path), pull_number: number, request: { signal: call.signal } })
      name = data.head.ref
      if (data.head.repo?.id !== data.base.repo.id) return { name, deleted: false, reason: '源分支在 fork 仓库里，不删除' }
      if (name === data.base.repo.default_branch) return { name, deleted: false, reason: '源分支是默认分支，不删除' }
      // A protection rule may allow deletion, so protection is checked here rather than left to the host.
      const branch = await this.getBranch(ref, name, call)
      if (branch === undefined) return { name, deleted: true }
      if (branch.protected) return { name, deleted: false, reason: '源分支是受保护分支，不删除' }
      if (branch.commit !== data.head.sha) return { name, deleted: false, reason: '源分支在合并后有了新提交，不删除' }
      await this.deleteBranch(ref, name, call)
      return { name, deleted: true }
    } catch (error) {
      // The repository's "automatically delete head branches" setting may already have removed it.
      if ((error as { status?: number }).status === 422 && /Reference does not exist/i.test(errorText(error))) return { name, deleted: true }
      return { name, deleted: false, reason: `删除源分支失败：${errorText(error)}` }
    }
  }

  /** A change request selects the runs of its current head commit. */
  async listRuns(ref: RepoRef, query: Paging & CiRunQuery, call: Call) {
    const repo = split(ref.path)
    const sha = query.change === undefined
      ? query.sha
      : (await this.octokit.rest.pulls.get({ ...repo, pull_number: query.change, request: { signal: call.signal } })).data.head.sha
    const { data } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
      ...repo,
      per_page: query.perPage,
      page: query.page,
      ...query.ref === undefined ? {} : { branch: query.ref },
      ...sha === undefined ? {} : { head_sha: sha },
      ...query.state === undefined ? {} : { status: RUN_STATUS[query.state] },
      request: { signal: call.signal },
    })
    return { items: data.workflow_runs.map(workflowRun), ...nextPage(query, data.workflow_runs.length) }
  }

  /** Failure annotations are read only for a failed run, one request per failed job. */
  async getRun(ref: RepoRef, id: number, call: Call): Promise<CiRunDetail> {
    const repo = split(ref.path)
    const [{ data }, jobs] = await Promise.all([
      this.octokit.rest.actions.getWorkflowRun({ ...repo, run_id: id, request: { signal: call.signal } }),
      this.runJobs(repo, id, call.signal),
    ])
    const run = workflowRun(data)
    const mapped = jobs.items.map(actionsJob)
    let failures: CiFailure[] = []
    let unread = false
    let failuresError: string | undefined
    if (run.state === 'failure') {
      try {
        const failed = mapped.filter(entry => entry.state === 'failure')
        // One more than the limit, so a cut list is reported as truncated.
        const found = await Promise.all(failed.map(entry => this.failureAnnotations(repo, entry, call.limits.maxCiFailures + 1, call.signal)))
        failures = found.flatMap(entry => entry.failures)
        unread = found.some(entry => entry.unread)
      } catch (error) {
        if (call.signal.aborted) throw error
        failuresError = `读取错误注解失败：${errorText(error)}`
      }
    }
    const capped = capFailures(failures, call.limits)
    const started = data.run_started_at
    const finished = run.state === 'running' || run.state === 'pending' ? undefined : data.updated_at
    const duration = seconds(started, finished)
    return {
      ...run,
      ...started === undefined ? {} : { startedAt: started },
      ...finished === undefined ? {} : { finishedAt: finished },
      ...duration === undefined ? {} : { durationSeconds: duration },
      jobs: mapped,
      jobsTruncated: jobs.truncated,
      ...capped,
      failuresTruncated: capped.failuresTruncated || unread,
      ...failuresError === undefined ? {} : { failuresError },
    }
  }

  async failedJobs(ref: RepoRef, runId: number, call: Call) {
    const jobs = await this.runJobs(split(ref.path), runId, call.signal)
    return jobs.items.map(actionsJob).filter(entry => entry.state === 'failure')
  }

  /**
   * The log endpoint redirects to a short-lived storage URL; the redirect is
   * followed by hand so the token is sent only to the API host.
   */
  async jobLog(ref: RepoRef, jobId: number, call: Call) {
    const repo = split(ref.path)
    const { data } = await this.octokit.rest.actions.getJobForWorkflowRun({ ...repo, job_id: jobId, request: { signal: call.signal } })
    const response = await fetch(`${this.baseUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/jobs/${jobId}/logs`, {
      headers: { authorization: `token ${await this.token()}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-repo' },
      redirect: 'manual',
      signal: call.signal,
    })
    const location = response.headers.get('location')
    const body = response.status >= 300 && response.status < 400 && location !== null
      ? await okBody(await fetch(location, { signal: call.signal }))
      : await okBody(response)
    return { job: actionsJob(data), body }
  }

  /** Reruns the failed jobs (and the jobs depending on them) as a new attempt of the same run. */
  async retryRun(ref: RepoRef, runId: number, call: Call): Promise<CiActionResult> {
    await this.octokit.rest.actions.reRunWorkflowFailedJobs({ ...split(ref.path), run_id: runId, request: { signal: call.signal } })
    return { runId }
  }

  async retryJob(ref: RepoRef, jobId: number, call: Call): Promise<CiActionResult> {
    await this.octokit.rest.actions.reRunJobForWorkflowRun({ ...split(ref.path), job_id: jobId, request: { signal: call.signal } })
    return { jobId }
  }

  async cancelRun(ref: RepoRef, runId: number, call: Call): Promise<CiActionResult> {
    await this.octokit.rest.actions.cancelWorkflowRun({ ...split(ref.path), run_id: runId, request: { signal: call.signal } })
    return { runId }
  }

  async cancelJob(_ref: RepoRef, _jobId: number, _call: Call): Promise<CiActionResult> {
    throw new RepoError('invalid', 'GitHub Actions 不能单独取消一个作业，只能取消整个运行（传 runId）')
  }

  /**
   * Failure-level annotations of a job, page by page until `want` are found
   * or the annotations end; warnings and notices can fill whole pages first.
   * `unread` is true when {@link MAX_STATUS_PAGES} pages did not reach the end.
   */
  private async failureAnnotations(repo: { owner: string; repo: string }, job: CiJob, want: number, signal: AbortSignal): Promise<{ failures: CiFailure[]; unread: boolean }> {
    const failures: CiFailure[] = []
    for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
      const { data } = await this.octokit.rest.checks.listAnnotations({ ...repo, check_run_id: job.id, per_page: PAGE, page, request: { signal } })
      for (const note of data) {
        if (note.annotation_level !== 'failure') continue
        failures.push({
          job: job.name,
          name: note.title === null || note.title === undefined || note.title === '' ? job.name : note.title,
          ...note.message === null ? {} : { message: note.message },
          // Annotations about the run itself ("Process completed with exit code 1") point at `.github`.
          ...note.path === '' || note.path === '.github' ? {} : { path: note.path, line: note.start_line },
        })
      }
      if (failures.length >= want || data.length < PAGE) return { failures, unread: false }
    }
    return { failures, unread: true }
  }

  /** Jobs of a run's latest attempt, at most {@link MAX_STATUS_PAGES} pages. */
  private async runJobs(repo: { owner: string; repo: string }, runId: number, signal: AbortSignal): Promise<{ items: GithubJob[]; truncated: boolean }> {
    const items: GithubJob[] = []
    for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
      const { data } = await this.octokit.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: runId, filter: 'latest', per_page: PAGE, page, request: { signal } })
      items.push(...data.jobs)
      if (data.jobs.length < PAGE) return { items, truncated: false }
    }
    return { items, truncated: true }
  }

  /** Every page of a list endpoint, so an aggregate never rests on a partial list. */
  private async allPages<T>(read: (page: number) => Promise<readonly T[]>, what: string): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
      const batch = await read(page)
      items.push(...batch)
      if (batch.length < PAGE) return items
    }
    throw new RepoError('too-large', `${what}超过 ${MAX_STATUS_PAGES * PAGE} 条，无法给出完整状态`)
  }

  private async comments(ref: RepoRef, number: number, call: Call): Promise<CommentInfo[]> {
    const { data } = await this.octokit.rest.issues.listComments({ ...split(ref.path), issue_number: number, per_page: call.limits.maxComments, request: { signal: call.signal } })
    return data.map(comment)
  }
}
