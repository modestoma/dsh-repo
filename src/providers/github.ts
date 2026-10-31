/**
 * GitHub provider on the official `@octokit/rest` SDK: github.com and GitHub
 * Enterprise Server (`<url>/api/v3`). Pull requests are this module's change
 * requests.
 *
 * @module dsh-repo/providers/github
 */

import { Octokit } from '@octokit/rest'
import type {
  BranchInfo, ChangeInfo, ChangeState, CheckInfo, CheckState, CommentInfo, CommitAuthor, CommitInfo, IssueInfo, RepoInfo, RepoRef, RepoUser, TreeEntry,
} from '../contract.ts'
import { RepoError } from '../errors.ts'
import { nextPage, titleOf, truncateBytes } from './types.ts'
import type { Call, Provider, TokenSource } from './types.ts'

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

function pull(value: GithubPull): ChangeInfo {
  const state: ChangeState = value.merged_at !== null ? 'merged' : value.state === 'closed' ? 'closed' : 'open'
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

/** GitHub provider bound to one host. */
export class GithubProvider implements Provider {
  private readonly octokit: Octokit

  /**
   * @param baseUrl - REST base URL (`https://api.github.com` or `<url>/api/v3`).
   * @param token - resolves the host's token for every request.
   */
  constructor(private readonly baseUrl: string, token: TokenSource) {
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

  async listIssues(ref: RepoRef, query: { page: number; perPage: number; state: 'open' | 'closed' | 'all'; labels?: readonly string[]; assignee?: string }, call: Call) {
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

  async listChanges(ref: RepoRef, query: { page: number; perPage: number; state: ChangeState | 'all'; sourceBranch?: string; targetBranch?: string }, call: Call) {
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
    const signal = call.signal
    const { data: change } = await this.octokit.rest.pulls.get({ ...repo, pull_number: number, request: { signal } })
    const sha = change.head.sha
    const [runs, statuses] = await Promise.all([
      this.allPages(page => this.octokit.rest.checks.listForRef({ ...repo, ref: sha, per_page: PAGE, page, request: { signal } }).then(response => response.data.check_runs)),
      this.allPages(page => this.octokit.rest.repos.getCombinedStatusForRef({ ...repo, ref: sha, per_page: PAGE, page, request: { signal } }).then(response => response.data.statuses)),
    ])
    const checks: CheckInfo[] = [
      ...runs.map(run => ({ name: run.name, state: checkRunState(run.status, run.conclusion), ...run.html_url === null ? {} : { webUrl: run.html_url } })),
      ...statuses.map(status => ({
        name: status.context,
        state: status.state === 'success' ? 'success' as const : status.state === 'pending' ? 'pending' as const : 'failure' as const,
        ...status.target_url === null ? {} : { webUrl: status.target_url },
      })),
    ]
    return { headSha: sha, checks, overall: overall(checks), ...change.mergeable === null ? {} : { mergeable: change.mergeable } }
  }

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

  async mergeChange(ref: RepoRef, number: number, request: { headSha: string; method?: 'merge' | 'squash' | 'rebase' }, call: Call) {
    const { data } = await this.octokit.rest.pulls.merge({
      ...split(ref.path),
      pull_number: number,
      sha: request.headSha,
      ...request.method === undefined ? {} : { merge_method: request.method },
      request: { signal: call.signal },
    })
    return { sha: data.sha }
  }

  /** Every page of a list endpoint, so an aggregate never rests on a partial list. */
  private async allPages<T>(read: (page: number) => Promise<readonly T[]>): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
      const batch = await read(page)
      items.push(...batch)
      if (batch.length < PAGE) return items
    }
    throw new RepoError('too-large', `CI 检查超过 ${MAX_STATUS_PAGES * PAGE} 条，无法给出完整状态`)
  }

  private async comments(ref: RepoRef, number: number, call: Call): Promise<CommentInfo[]> {
    const { data } = await this.octokit.rest.issues.listComments({ ...split(ref.path), issue_number: number, per_page: call.limits.maxComments, request: { signal: call.signal } })
    return data.map(comment)
  }
}
