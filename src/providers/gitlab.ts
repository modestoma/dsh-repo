/**
 * GitLab provider on `@gitbeaker/rest`, the TypeScript SDK GitLab's
 * documentation lists: gitlab.com and self-managed instances, including ones
 * served under a path prefix. Merge requests are this module's change
 * requests; issue and merge request numbers are project-scoped IIDs.
 *
 * @module dsh-repo/providers/gitlab
 */

import { Gitlab } from '@gitbeaker/rest'
import type {
  BranchInfo, ChangeInfo, ChangeState, CheckInfo, CommentInfo, CommitAuthor, CommitInfo, IssueInfo, RepoInfo, RepoRef, RepoUser, TreeEntry,
} from '../contract.ts'
import { RepoError } from '../errors.ts'
import { nextPage, titleOf, truncateBytes } from './types.ts'
import type { Call, Paging, Provider, TokenSource } from './types.ts'

/** GitLab's maximum page size. */
const MAX_PAGE = 100

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
}

function mergeRequest(value: GitlabMergeRequest): ChangeInfo {
  const state: ChangeState = value.state === 'merged' ? 'merged' : value.state === 'opened' ? 'open' : 'closed'
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
}

function note(value: GitlabNote): CommentInfo {
  return { id: String(value.id), author: user(value.author), body: value.body, createdAt: value.created_at }
}

function pipelineState(status: string): CheckInfo['state'] {
  if (status === 'success' || status === 'skipped') return 'success'
  if (status === 'failed' || status === 'canceled') return 'failure'
  return 'pending'
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
  constructor(private readonly host: string, token: TokenSource, timeoutMs: number) {
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

  async listIssues(ref: RepoRef, query: Paging & { state: 'open' | 'closed' | 'all'; labels?: readonly string[]; assignee?: string }, call: Call) {
    call.signal.throwIfAborted()
    const data = await this.api.Issues.all({
      projectId: ref.path,
      ...paging(query),
      ...query.state === 'all' ? {} : { state: query.state === 'open' ? 'opened' as const : 'closed' as const },
      ...query.labels === undefined || query.labels.length === 0 ? {} : { labels: query.labels.join(',') },
      ...query.assignee === undefined ? {} : { assigneeUsername: [query.assignee] },
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

  async listChanges(ref: RepoRef, query: Paging & { state: ChangeState | 'all'; sourceBranch?: string; targetBranch?: string }, call: Call) {
    call.signal.throwIfAborted()
    const state = query.state === 'all' ? undefined : query.state === 'open' ? 'opened' as const : query.state
    const data = await this.api.MergeRequests.all({
      projectId: ref.path,
      ...paging(query),
      ...state === undefined ? {} : { state },
      ...query.sourceBranch === undefined ? {} : { sourceBranch: query.sourceBranch },
      ...query.targetBranch === undefined ? {} : { targetBranch: query.targetBranch },
    })
    // A source branch names a branch of this project, as GitHub's `head=owner:branch` does; MRs from forks with the same branch name are left out.
    const items = query.sourceBranch === undefined ? data : data.filter(entry => entry.source_project_id === entry.target_project_id)
    return { items: items.map(entry => mergeRequest(entry)), ...nextPage(query, data.length) }
  }

  async getChange(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    const [data, notes] = await Promise.all([
      this.api.MergeRequests.show(ref.path, number),
      this.api.MergeRequestNotes.all(ref.path, number, { sort: 'asc', perPage: call.limits.maxComments, maxPages: 1 }),
    ])
    return { ...mergeRequest(data), comments: notes.filter(entry => entry.system !== true).map(note) }
  }

  async changeDiff(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    const files = await this.api.MergeRequests.allDiffs(ref.path, number, { perPage: MAX_PAGE })
    // GitLab leaves `diff` empty for collapsed or oversized files; say so instead of presenting a complete diff.
    let omitted = false
    const parts = files.map((file) => {
      const from = file.new_file ? '/dev/null' : `a/${file.old_path}`
      const to = file.deleted_file ? '/dev/null' : `b/${file.new_path}`
      const skipped = file.too_large === true || (file.collapsed === true && file.diff === '')
      if (skipped) omitted = true
      return `diff --git a/${file.old_path} b/${file.new_path}\n--- ${from}\n+++ ${to}\n${skipped ? '# GitLab 未返回这个文件的 diff（文件过大或已折叠）\n' : file.diff}`
    })
    const { text, truncated } = truncateBytes(parts.join(''), call.limits.maxDiffBytes)
    return { diff: text, truncated: truncated || omitted }
  }

  async changeStatus(ref: RepoRef, number: number, call: Call) {
    call.signal.throwIfAborted()
    const data = await this.api.MergeRequests.show(ref.path, number)
    const pipeline = data.head_pipeline
    const checks: CheckInfo[] = pipeline === undefined || pipeline === null
      ? []
      : [{ name: `pipeline #${pipeline.id}`, state: pipelineState(pipeline.status), ...pipeline.web_url === undefined ? {} : { webUrl: pipeline.web_url } }]
    const detailed = data.detailed_merge_status
    return {
      headSha: data.sha,
      checks,
      overall: checks[0]?.state ?? 'none' as const,
      ...typeof detailed !== 'string' || COMPUTING.has(detailed) ? {} : { mergeable: detailed === 'mergeable' },
    }
  }

  async createChange(ref: RepoRef, fields: { title: string; body?: string; sourceBranch: string; targetBranch: string; draft: boolean; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
    const assigneeIds = await this.userIds(fields.assignees, call)
    call.signal.throwIfAborted()
    const title = fields.draft && !fields.title.startsWith(DRAFT_PREFIX) ? `${DRAFT_PREFIX}${fields.title}` : fields.title
    const data = await this.api.MergeRequests.create(ref.path, fields.sourceBranch, fields.targetBranch, title, {
      ...fields.body === undefined ? {} : { description: fields.body },
      ...fields.labels === undefined ? {} : { labels: fields.labels.join(',') },
      ...assigneeIds === undefined ? {} : { assigneeIds },
    })
    return mergeRequest(data)
  }

  async updateChange(ref: RepoRef, number: number, update: { title?: string; body?: string; state?: 'open' | 'closed'; targetBranch?: string; labels?: readonly string[]; assignees?: readonly string[] }, call: Call) {
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

  async commentChange(ref: RepoRef, number: number, body: string, call: Call) {
    call.signal.throwIfAborted()
    return note(await this.api.MergeRequestNotes.create(ref.path, number, body))
  }

  async mergeChange(ref: RepoRef, number: number, request: { headSha: string; method?: 'merge' | 'squash' | 'rebase' }, call: Call) {
    if (request.method === 'rebase') throw new RepoError('invalid', 'GitLab 的合并接口不支持 rebase 方式；可用 merge 或 squash')
    call.signal.throwIfAborted()
    const data = await this.api.MergeRequests.merge(ref.path, number, {
      sha: request.headSha,
      ...request.method === undefined ? {} : { squash: request.method === 'squash' },
    })
    const sha = data.merge_commit_sha ?? data.squash_commit_sha
    return typeof sha === 'string' ? { sha } : {}
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
