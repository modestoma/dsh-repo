/**
 * GitHub provider on the official `@octokit/rest` SDK: github.com and GitHub
 * Enterprise Server (`<url>/api/v3`). Pull requests are this module's PRs/MRs.
 * {@link githubForge} is the family's adapter.
 *
 * @module dsh-repo/providers/github
 */

import { Octokit } from '@octokit/rest'
import type {
  BranchInfo, MrDiff, MrDiscussion, MrDiscussionResolveResult, MrInfo, MrState, MrStatus, CheckInfo, CheckState, CiActionResult, CiFailure, CiJob, CiRun, CiRunDetail, CiState,
  CommentInfo, CommitAuthor, CommitInfo, DiffPosition, DiscussionNote, DraftInlineComment, IssueInfo, Page, RepoInfo, RepoRef, RepoUser, ReviewVerdict, SourceBranchDeletion, TreeEntry,
} from '../contract.ts'
import { RepoError } from '../errors.ts'
import { forgeKindInfo } from '../settings/contract.ts'
import { capFailures, composeReviewBody, errorText, joinRepoPath, nextPage, okBody, pathSegments, titleOf, truncateBytes } from './types.ts'
import type { ActivityItem, ActivityRequest, Call, ForgeAdapter, MrActivity, MrReplyOutcome, MrReviewOutcome, MrReviewRequest, CiRunQuery, Paging, Provider, TokenSource } from './types.ts'

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

interface GithubGraphqlActor {
  readonly login: string
  readonly url?: string | null
}

interface GithubGraphqlComment {
  readonly id: string
  readonly databaseId?: number | null
  readonly body?: string | null
  readonly createdAt: string
  readonly updatedAt?: string | null
  readonly url?: string | null
  readonly author?: GithubGraphqlActor | null
}

interface GithubReviewThread {
  readonly id: string
  readonly isResolved: boolean
  readonly isOutdated?: boolean
  readonly path: string
  readonly diffSide?: 'LEFT' | 'RIGHT' | null
  readonly line?: number | null
  readonly originalLine?: number | null
  readonly startLine?: number | null
  readonly resolvedBy?: GithubGraphqlActor | null
  readonly comments?: {
    readonly pageInfo?: { readonly hasNextPage: boolean; readonly endCursor?: string | null } | null
    readonly nodes?: ReadonlyArray<GithubGraphqlComment | null> | null
  } | null
}

function graphqlUser(actor: GithubGraphqlActor | null | undefined): RepoUser {
  if (actor === null || actor === undefined) return { username: 'ghost' }
  return { username: actor.login, ...actor.url === undefined || actor.url === null || actor.url === '' ? {} : { webUrl: actor.url } }
}

function graphqlNote(entry: GithubGraphqlComment): DiscussionNote {
  return {
    id: String(entry.id),
    author: graphqlUser(entry.author),
    body: entry.body ?? '',
    createdAt: entry.createdAt,
    ...entry.updatedAt === undefined || entry.updatedAt === null ? {} : { updatedAt: entry.updatedAt },
    ...entry.url === undefined || entry.url === null || entry.url === '' ? {} : { webUrl: entry.url },
  }
}

function reviewThread(node: GithubReviewThread): MrDiscussion {
  const lineNo = node.line ?? node.originalLine ?? undefined
  const side = node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT'
  const position: DiffPosition = {
    path: node.path,
    ...typeof lineNo === 'number' ? (side === 'LEFT' ? { oldLine: lineNo } : { newLine: lineNo }) : {},
  }
  const notes = (node.comments?.nodes ?? [])
    .filter((entry): entry is GithubGraphqlComment => entry !== null && entry !== undefined)
    .map(graphqlNote)
  return {
    id: node.id,
    inline: true,
    position,
    resolvable: true,
    resolved: node.isResolved,
    ...node.resolvedBy === null || node.resolvedBy === undefined ? {} : { resolvedBy: graphqlUser(node.resolvedBy) },
    notes,
  }
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repoName: String!, $pullNumber: Int!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repoName) {
      pullRequest(number: $pullNumber) {
        reviewThreads(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            diffSide
            line
            originalLine
            startLine
            resolvedBy {
              login
              url
            }
            comments(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                databaseId
                body
                createdAt
                updatedAt
                url
                author {
                  login
                  url
                }
              }
            }
          }
        }
      }
    }
  }
`

const REVIEW_THREAD_COMMENTS_QUERY = `
  query($threadId: ID!, $first: Int!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            databaseId
            body
            createdAt
            updatedAt
            url
            author {
              login
              url
            }
          }
        }
      }
    }
  }
`

const THREAD_OWNERSHIP_QUERY = `
  query($threadId: ID!) {
    node(id: $threadId) {
      __typename
      ... on PullRequestReviewThread {
        id
        pullRequest {
          number
          repository {
            owner {
              login
            }
            name
          }
        }
      }
    }
  }
`

const REPLY_THREAD_MUTATION = `
  mutation($threadId: ID!, $commentBody: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $commentBody }) {
      comment {
        id
        databaseId
        body
        createdAt
        updatedAt
        url
        author {
          login
          url
        }
      }
    }
  }
`

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`

const UNRESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`

function isSelfReviewFailure(error: unknown): boolean {
  const payload = (error as { response?: { data?: unknown } } | null | undefined)?.response?.data
  const detail = `${errorText(error)} ${payload === undefined ? '' : JSON.stringify(payload)}`
  return /own pull request|can\s*not\s+(?:approve|request\s+changes)/i.test(detail)
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
  private readonly graphql: Octokit['graphql']

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
    // GHES REST uses `<url>/api/v3`, whereas its GraphQL endpoint is `<url>/api/graphql`.
    const graphqlBase = baseUrl.replace(/\/api\/v3\/?$/, '/api').replace(/\/+$/, '')
    this.graphql = this.octokit.graphql.defaults({ baseUrl: graphqlBase })
  }

  async currentUser(call: Call): Promise<CommitAuthor> {
    const { data } = await this.octokit.rest.users.getAuthenticated({ request: { signal: call.signal } })
    const api = new URL(this.baseUrl)
    const web = api.hostname === 'api.github.com' ? 'github.com' : api.host
    return { name: data.name ?? data.login, email: data.email ?? `${data.id}+${data.login}@users.noreply.${web}` }
  }

  async botUser(call: Call): Promise<RepoUser> {
    const { data } = await this.octokit.rest.users.getAuthenticated({ request: { signal: call.signal } })
    return user(data)
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
      // Every search word is quoted, so qualifiers such as `repo:` in it stay text and cannot widen the scope.
      const words = query.search.split(/\s+/).map(word => word.replace(/"/g, '')).filter(word => word !== '').map(word => `"${word}"`)
      const qualifiers = [
        `repo:${ref.path}`,
        'is:issue',
        ...query.state === 'all' ? [] : [`state:${query.state}`],
        ...(query.labels ?? []).map(label => `label:"${label.replace(/"/g, '')}"`),
        ...query.assignee === undefined ? [] : [`assignee:"${query.assignee.replace(/"/g, '')}"`],
      ]
      const { data } = await this.octokit.rest.search.issuesAndPullRequests({ q: [...words, ...qualifiers].join(' '), page: query.page, per_page: query.perPage, request: { signal: call.signal } })
      const own = `/repos/${ref.path}`.toLowerCase()
      return { items: data.items.filter(entry => entry.pull_request === undefined && entry.repository_url.toLowerCase().endsWith(own)).map(entry => issue(entry as Parameters<typeof issue>[0])), ...nextPage(query, data.items.length) }
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
    // The issues endpoint also lists pull requests; they are PRs here.
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

  async listMrs(ref: RepoRef, query: { page: number; perPage: number; state: MrState | 'all'; sourceBranch?: string; targetBranch?: string; sort?: 'created' | 'updated'; updatedAfter?: string }, call: Call) {
    const repo = split(ref.path)
    const { data } = await this.octokit.rest.pulls.list({
      ...repo,
      state: query.state === 'merged' ? 'closed' : query.state,
      page: query.page,
      per_page: query.perPage,
      ...query.sourceBranch === undefined ? {} : { head: `${repo.owner}:${query.sourceBranch}` },
      ...query.targetBranch === undefined ? {} : { base: query.targetBranch },
      ...query.sort === undefined ? {} : { sort: query.sort, direction: 'desc' as const },
      request: { signal: call.signal },
    })
    const mapped = data.map(pull)
    const afterMs = query.updatedAfter === undefined ? undefined : Date.parse(query.updatedAfter)
    const reachedCutoff = query.sort === 'updated' && afterMs !== undefined && mapped.length > 0 && Date.parse(mapped.at(-1)!.updatedAt) <= afterMs
    const items = mapped.filter(change => (query.state === 'all' || change.state === query.state) && (afterMs === undefined || Date.parse(change.updatedAt) > afterMs))
    return { items, ...reachedCutoff ? {} : nextPage(query, data.length) }
  }

  async getMr(ref: RepoRef, number: number, call: Call) {
    const [{ data }, comments] = await Promise.all([
      this.octokit.rest.pulls.get({ ...split(ref.path), pull_number: number, request: { signal: call.signal } }),
      this.comments(ref, number, call),
    ])
    return { ...pull(data), comments }
  }

  async mrDiff(ref: RepoRef, number: number, call: Call) {
    const response = await this.octokit.rest.pulls.get({ ...split(ref.path), pull_number: number, mediaType: { format: 'diff' }, request: { signal: call.signal } })
    const raw: unknown = response.data
    const { text, truncated } = truncateBytes(typeof raw === 'string' ? raw : '', call.limits.maxDiffBytes)
    return { diff: text, truncated }
  }

  async mrCompare(ref: RepoRef, baseSha: string, headSha: string, call: Call): Promise<MrDiff> {
    const response = await this.octokit.rest.repos.compareCommitsWithBasehead({
      ...split(ref.path),
      basehead: `${baseSha}...${headSha}`,
      mediaType: { format: 'diff' },
      request: { signal: call.signal },
    })
    const raw: unknown = response.data
    const { text, truncated } = truncateBytes(typeof raw === 'string' ? raw : '', call.limits.maxDiffBytes)
    return { diff: text, truncated }
  }

  async mrDiscussions(ref: RepoRef, number: number, query: Paging & { readonly onlyUnresolved?: boolean }, call: Call): Promise<Page<MrDiscussion>> {
    const { owner, repo: repoName } = split(ref.path)
    const fetchThreads = async (first: number, after: string | null) => {
      const data = await this.graphql<{
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo: { hasNextPage: boolean; endCursor?: string | null }
              nodes?: ReadonlyArray<GithubReviewThread | null> | null
            } | null
          } | null
        } | null
      }>(REVIEW_THREADS_QUERY, { owner, repoName, pullNumber: number, first, after, request: { signal: call.signal } })
      const pr = data.repository?.pullRequest
      if (pr === null || pr === undefined) throw new RepoError('not-found', `PR #${number} 不存在或令牌无权查看`)
      const threads = pr.reviewThreads ?? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
      const rawNodes = (threads.nodes ?? []).filter((entry): entry is GithubReviewThread => entry !== null && entry !== undefined)
      return { rawNodes, pageInfo: threads.pageInfo }
    }

    const hydrateSelected = async (selected: readonly GithubReviewThread[]): Promise<MrDiscussion[]> =>
      await Promise.all(selected.map(entry => this.hydrateReviewThread(entry, number, call)))

    if (query.page === 1 && query.onlyUnresolved !== true) {
      const { rawNodes, pageInfo } = await fetchThreads(query.perPage, null)
      const items = await hydrateSelected(rawNodes)
      return { items, ...pageInfo.hasNextPage ? { nextPage: 2 } : {} }
    }

    const needed = query.page * query.perPage + 1
    const matched: GithubReviewThread[] = []
    let after: string | null = null
    for (let step = 1; step <= MAX_STATUS_PAGES; step += 1) {
      const { rawNodes, pageInfo }: Awaited<ReturnType<typeof fetchThreads>> = await fetchThreads(PAGE, after)
      for (const item of rawNodes) {
        if (query.onlyUnresolved !== true || !item.isResolved) matched.push(item)
      }
      if (matched.length >= needed || !pageInfo.hasNextPage) {
        const start = (query.page - 1) * query.perPage
        const items = await hydrateSelected(matched.slice(start, start + query.perPage))
        const hasMore = matched.length > start + query.perPage || pageInfo.hasNextPage
        return { items, ...hasMore ? { nextPage: query.page + 1 } : {} }
      }
      after = pageInfo.endCursor ?? null
    }
    throw new RepoError('too-large', `PR #${number} 的讨论线程超过 ${MAX_STATUS_PAGES * PAGE} 条，无法完成筛选或分页`)
  }

  private async hydrateReviewThread(node: GithubReviewThread, number: number, call: Call): Promise<MrDiscussion> {
    const base = reviewThread(node)
    if (node.comments?.pageInfo?.hasNextPage !== true) return base
    const extraNotes: DiscussionNote[] = []
    let after: string | null = node.comments.pageInfo.endCursor ?? null
    for (let step = 1; step <= MAX_STATUS_PAGES; step += 1) {
      const data = await this.graphql<{
        node?: {
          comments?: {
            pageInfo: { hasNextPage: boolean; endCursor?: string | null }
            nodes?: ReadonlyArray<GithubGraphqlComment | null> | null
          } | null
        } | null
      }>(REVIEW_THREAD_COMMENTS_QUERY, { threadId: node.id, first: PAGE, after, request: { signal: call.signal } })
      const comments = data.node?.comments
      if (comments === null || comments === undefined) break
      for (const entry of comments.nodes ?? []) {
        if (entry !== null && entry !== undefined) extraNotes.push(graphqlNote(entry))
      }
      if (!comments.pageInfo.hasNextPage) {
        return { ...base, notes: [...base.notes, ...extraNotes] }
      }
      after = comments.pageInfo.endCursor ?? null
    }
    throw new RepoError('too-large', `PR #${number} 讨论线程 ${node.id} 的回复超过 ${(MAX_STATUS_PAGES + 1) * PAGE} 条，无法完整读取`)
  }

  async mrStatus(ref: RepoRef, number: number, call: Call) {
    const repo = split(ref.path)
    const { data: change } = await this.octokit.rest.pulls.get({ ...repo, pull_number: number, request: { signal: call.signal } })
    return await this.statusOf(repo, change, call.signal)
  }

  /** Pull request comments and reviews are read only when its `updated_at` moved; check runs never move it, so CI is read as asked. */
  async mrActivity(ref: RepoRef, number: number, request: ActivityRequest, call: Call): Promise<MrActivity> {
    const repo = split(ref.path)
    const { data } = await this.octokit.rest.pulls.get({ ...repo, pull_number: number, request: { signal: call.signal } })
    const change = pull(data)
    const [status, items] = await Promise.all([
      request.withStatus ? this.statusOf(repo, data, call.signal) : undefined,
      request.updatedAt === change.updatedAt ? undefined : this.activitySince(repo, number, request.since, call.signal),
    ])
    return { mr: change, conflict: data.mergeable_state === 'dirty', ...status === undefined ? {} : { status }, ...items === undefined ? {} : { items } }
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
  async createMr(ref: RepoRef, fields: { title: string; body?: string; sourceBranch: string; targetBranch: string; draft: boolean; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
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

  async updateMr(ref: RepoRef, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; targetBranch?: string; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
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

  async commentMr(ref: RepoRef, number: number, body: string, call: Call) {
    return await this.commentIssue(ref, number, body, call)
  }

  async mrReview(ref: RepoRef, number: number, request: MrReviewRequest, call: Call): Promise<MrReviewOutcome> {
    const repo = split(ref.path)
    const { data: pr } = await this.octokit.rest.pulls.get({ ...repo, pull_number: number, request: { signal: call.signal } })
    if (pr.head.sha.toLowerCase() !== request.headSha.toLowerCase()) {
      throw new RepoError('conflict', `PR #${number} 的最新提交已变为 ${pr.head.sha.slice(0, 12)}（评审基于 ${request.headSha.slice(0, 12)}）`)
    }
    let verdict: ReviewVerdict = request.verdict
    let downgraded = false
    if (verdict !== 'comment' && request.botUsername !== undefined && pr.user?.login !== undefined && pr.user.login.toLowerCase() === request.botUsername.toLowerCase()) {
      verdict = 'comment'
      downgraded = true
    }

    const submit = async (currentVerdict: ReviewVerdict, inline: readonly DraftInlineComment[], fallbacks: readonly DraftInlineComment[], ensureBody: boolean) => {
      const event = currentVerdict === 'approve' ? 'APPROVE' as const : currentVerdict === 'request-changes' ? 'REQUEST_CHANGES' as const : 'COMMENT' as const
      let body = composeReviewBody(request.body, fallbacks, request.signature)
      if (body === undefined && (ensureBody || currentVerdict === 'request-changes')) {
        body = composeReviewBody(currentVerdict === 'request-changes' ? '请求修改' : '（自审自动降级为评论）', [], request.signature)
      }
      const comments = inline.map(item => item.newLine !== undefined
        ? { path: item.path, line: item.newLine, side: 'RIGHT' as const, body: item.body }
        : { path: item.path, line: item.oldLine!, side: 'LEFT' as const, body: item.body })
      return await this.octokit.rest.pulls.createReview({
        ...repo,
        pull_number: number,
        commit_id: request.headSha,
        event,
        ...body === undefined ? {} : { body },
        ...comments.length === 0 ? {} : { comments },
        request: { signal: call.signal },
      })
    }

    const buildOutcome = async (res: { readonly data: { readonly id: number; readonly html_url?: string } }, postedComments: number, fallbackInlineCount: number): Promise<MrReviewOutcome> => {
      const ownCommentIds = [`review-${res.data.id}`]
      if (postedComments > 0 && typeof this.octokit.rest.pulls.listCommentsForReview === 'function') {
        try {
          const { data: reviewComments } = await this.octokit.rest.pulls.listCommentsForReview({
            ...repo,
            pull_number: number,
            review_id: res.data.id,
            per_page: PAGE,
            request: { signal: call.signal },
          })
          for (const entry of reviewComments) {
            if (typeof entry.id === 'number') ownCommentIds.push(`line-${entry.id}`)
          }
        } catch {
          // Best-effort suppression hint for mrWatch; review submission itself already succeeded.
        }
      }
      return {
        verdict,
        ...downgraded ? { downgradedVerdict: true } : {},
        postedComments,
        fallbackInlineCount,
        ...res.data.html_url === undefined || res.data.html_url === '' ? {} : { webUrl: res.data.html_url },
        ownCommentIds,
      }
    }

    try {
      const res = await submit(verdict, request.comments, [], downgraded && request.comments.length === 0)
      return await buildOutcome(res, request.comments.length, 0)
    } catch (firstError) {
      let currentError: unknown = firstError
      const firstStatus = (currentError as { status?: unknown } | null | undefined)?.status
      if (verdict !== 'comment' && (firstStatus === 422 || firstStatus === 400) && isSelfReviewFailure(currentError)) {
        verdict = 'comment'
        downgraded = true
        try {
          const res = await submit('comment', request.comments, [], request.comments.length === 0)
          return await buildOutcome(res, request.comments.length, 0)
        } catch (secondError) {
          currentError = secondError
        }
      }
      const status = (currentError as { status?: unknown } | null | undefined)?.status
      if ((status === 422 || status === 400) && request.comments.length > 0) {
        const res = await submit(verdict, [], request.comments, false)
        return await buildOutcome(res, 0, request.comments.length)
      }
      throw currentError
    }
  }

  private async verifyReviewThreadTarget(ref: RepoRef, number: number, threadId: string, call: Call): Promise<void> {
    const { owner, repo: repoName } = split(ref.path)
    const data = await this.graphql<{
      node?: {
        __typename?: string
        id?: string
        pullRequest?: {
          number?: number
          repository?: {
            owner?: { login?: string | null } | null
            name?: string | null
          } | null
        } | null
      } | null
    }>(THREAD_OWNERSHIP_QUERY, { threadId, request: { signal: call.signal } })
    const node = data.node
    if (node === null || node === undefined || node.__typename !== 'PullRequestReviewThread' || node.pullRequest === null || node.pullRequest === undefined) {
      throw new RepoError('not-found', `PR #${number} 中不存在讨论线程 ${threadId}`)
    }
    const threadOwner = node.pullRequest.repository?.owner?.login ?? ''
    const threadRepo = node.pullRequest.repository?.name ?? ''
    const threadPrNumber = node.pullRequest.number
    if (
      threadOwner.toLowerCase() !== owner.toLowerCase()
      || threadRepo.toLowerCase() !== repoName.toLowerCase()
      || threadPrNumber !== number
    ) {
      throw new RepoError('forbidden', `讨论线程 ${threadId} 不属于已授权目标 ${ref.path}#${number}`)
    }
  }

  async mrDiscussionReply(ref: RepoRef, number: number, discussionId: string, body: string, call: Call): Promise<MrReplyOutcome> {
    await this.verifyReviewThreadTarget(ref, number, discussionId, call)
    const data = await this.graphql<{
      addPullRequestReviewThreadReply?: { comment?: GithubGraphqlComment | null } | null
    }>(REPLY_THREAD_MUTATION, { threadId: discussionId, commentBody: body, request: { signal: call.signal } })
    const created = data.addPullRequestReviewThreadReply?.comment
    if (created === null || created === undefined) throw new RepoError('unavailable', 'GitHub 未返回创建的线程回复')
    const mapped = graphqlNote(created)
    return {
      note: mapped,
      ownCommentIds: [mapped.id, ...typeof created.databaseId === 'number' ? [`line-${created.databaseId}`] : []],
    }
  }

  async mrDiscussionResolve(ref: RepoRef, number: number, discussionId: string, resolved: boolean, call: Call): Promise<MrDiscussionResolveResult> {
    await this.verifyReviewThreadTarget(ref, number, discussionId, call)
    if (resolved) {
      const data = await this.graphql<{ resolveReviewThread?: { thread?: { id: string; isResolved: boolean } | null } | null }>(
        RESOLVE_THREAD_MUTATION,
        { threadId: discussionId, request: { signal: call.signal } },
      )
      const thread = data.resolveReviewThread?.thread
      return { discussionId: thread?.id ?? discussionId, resolved: thread?.isResolved ?? true }
    }
    const data = await this.graphql<{ unresolveReviewThread?: { thread?: { id: string; isResolved: boolean } | null } | null }>(
      UNRESOLVE_THREAD_MUTATION,
      { threadId: discussionId, request: { signal: call.signal } },
    )
    const thread = data.unresolveReviewThread?.thread
    return { discussionId: thread?.id ?? discussionId, resolved: thread?.isResolved ?? false }
  }

  async mergeMr(ref: RepoRef, number: number, request: { headSha: string; method?: 'merge' | 'squash' | 'rebase'; deleteSourceBranch: boolean }, call: Call) {
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

  /** A PR selects the runs of its current head commit. */
  async listRuns(ref: RepoRef, query: Paging & CiRunQuery, call: Call) {
    const repo = split(ref.path)
    const sha = query.mr === undefined
      ? query.sha
      : (await this.octokit.rest.pulls.get({ ...repo, pull_number: query.mr, request: { signal: call.signal } })).data.head.sha
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

/** The GitHub family: repositories are `owner/name`, git authenticates as `x-access-token`. */
export const githubForge: ForgeAdapter = {
  kind: 'github',
  title: forgeKindInfo('github').label,
  gitUsername: 'x-access-token',
  pathHint: 'owner/name',
  apiBaseUrl: (host) => {
    if (host.apiUrl !== undefined) return host.apiUrl
    return new URL(host.url).host === 'github.com' ? 'https://api.github.com' : `${host.url}/api/v3`
  },
  repoPath: (rest) => {
    const segments = pathSegments(rest).slice(0, 2)
    return segments.length === 2 ? joinRepoPath(segments) : undefined
  },
  mrLabel: number => `PR #${number}`,
  createProvider: (spec, token) => new GithubProvider(githubForge.apiBaseUrl(spec), token),
}
