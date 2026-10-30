import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoService } from '../src/service.ts'
import { credentials, fakeHttp, testConfig, TOKENS } from './helpers.ts'

const REPO = 'https://code.example.com/gitlab/team/backend/orders'
const API = '/gitlab/api/v4/projects/team%2Fbackend%2Forders'
const SHA = 'b'.repeat(40)

const project = { web_url: REPO, default_branch: 'main', description: '', visibility: 'internal', archived: false, http_url_to_repo: `${REPO}.git` }
const author = { username: 'dev', web_url: 'https://code.example.com/gitlab/dev' }
const mr = (overrides: Record<string, unknown> = {}) => ({
  iid: 7, title: 'T', description: null, state: 'opened', draft: false, source_branch: 'f', target_branch: 'main', sha: SHA,
  author, labels: ['x'], assignees: [], created_at: 'c', updated_at: 'u', web_url: `${REPO}/-/merge_requests/7`, ...overrides,
})

afterEach(() => { vi.unstubAllGlobals() })

/** GitBeaker URL-encodes the project path into one segment. */
function path(request: { url: URL }): string {
  return request.url.pathname
}

describe('GitLab provider', () => {
  it('calls a self-managed instance under its path prefix with the encoded project path and PRIVATE-TOKEN', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: API, reply: { body: project } }])
    const info = await new RepoService(testConfig(), credentials(TOKENS)).repoInfo(REPO)
    expect(info).toMatchObject({ kind: 'gitlab', path: 'team/backend/orders', defaultBranch: 'main', visibility: 'internal' })
    expect(info.description).toBeUndefined()
    expect(requests[0]?.url.origin).toBe('https://code.example.com')
    expect(requests[0]?.headers.get('private-token')).toBe('gl-token')
  })

  it('asks for exactly one page', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: `${API}/repository/branches`, reply: { body: [{ name: 'main', commit: { id: SHA }, protected: true, default: true }] } }])
    const page = await new RepoService(testConfig(), credentials(TOKENS)).listBranches(REPO, { page: 2, perPage: 10 })
    expect(page).toEqual({ items: [{ name: 'main', commit: SHA, protected: true, default: true }] })
    expect(requests).toHaveLength(1)
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({ page: '2', per_page: '10' })
  })

  it('commits with create or update per file, starting a new branch from the base', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: API, reply: { body: project } },
      { method: 'GET', path: `${API}/repository/branches/feature`, reply: { status: 404, body: { message: '404 Branch Not Found' } } },
      { method: 'GET', path: `${API}/repository/tree`, reply: request => request.url.searchParams.get('path') === 'docs'
        ? { body: [{ path: 'docs/old.md', type: 'blob', mode: '100644' }] }
        : { status: 404, body: { message: '404 Tree Not Found' } } },
      { method: 'POST', path: `${API}/repository/commits`, reply: { status: 201, body: { id: 'c1', web_url: `${REPO}/-/commit/c1` } } },
    ])
    const result = await new RepoService(testConfig(), credentials(TOKENS)).commitFiles(REPO, {
      branch: 'feature',
      base: 'dev',
      message: 'docs: update',
      files: [
        { action: 'write', path: 'docs/old.md', content: 'new' },
        { action: 'write', path: 'new/dir/file.md', content: 'x' },
        { action: 'delete', path: 'gone.md' },
      ],
    })
    expect(result).toEqual({ sha: 'c1', branch: 'feature', createdBranch: true, webUrl: `${REPO}/-/commit/c1` })
    expect(requests.filter(request => path(request).endsWith('/repository/tree')).every(request => request.url.searchParams.get('ref') === 'dev')).toBe(true)
    expect(requests.at(-1)?.body).toMatchObject({
      branch: 'feature',
      commit_message: 'docs: update',
      start_branch: 'dev',
      actions: [
        { action: 'update', file_path: 'docs/old.md', content: 'new' },
        { action: 'create', file_path: 'new/dir/file.md', content: 'x' },
        { action: 'delete', file_path: 'gone.md' },
      ],
    })
  })

  it('maps issue states and closes through state events', async () => {
    const issue = { iid: 3, title: 'Bug', description: 'd', state: 'closed', author, labels: ['bug'], assignees: [author], created_at: 'c', updated_at: 'u', web_url: `${REPO}/-/issues/3` }
    const { requests } = fakeHttp([
      { method: 'GET', path: '/gitlab/api/v4/users', reply: { body: [{ id: 42, username: 'dev' }] } },
      { method: 'PUT', path: `${API}/issues/3`, reply: { body: issue } },
      { method: 'GET', path: `${API}/issues`, reply: { body: [issue] } },
    ])
    const service = new RepoService(testConfig(), credentials(TOKENS))
    expect(await service.updateIssue(REPO, 3, { state: 'closed', assignees: ['dev'], labels: ['bug', 'p1'] })).toMatchObject({ number: 3, state: 'closed', assignees: [{ username: 'dev' }] })
    expect(requests.find(request => request.method === 'PUT')?.body).toEqual({ state_event: 'close', assignee_ids: [42], labels: 'bug,p1' })
    await service.listIssues(REPO, { state: 'open', assignee: 'dev' })
    expect(requests.at(-1)?.url.searchParams.get('state')).toBe('opened')
  })

  it('opens draft merge requests with the Draft: title prefix and maps merged state', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: API, reply: { body: project } },
      { method: 'POST', path: `${API}/merge_requests`, reply: { status: 201, body: mr({ title: 'Draft: T', draft: true }) } },
      { method: 'GET', path: `${API}/merge_requests`, reply: { body: [mr({ state: 'merged' })] } },
    ])
    const service = new RepoService(testConfig(), credentials(TOKENS))
    expect(await service.createChange(REPO, { title: 'T', sourceBranch: 'f', draft: true })).toMatchObject({ number: 7, draft: true, targetBranch: 'main', body: '' })
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ source_branch: 'f', target_branch: 'main', title: 'Draft: T' })
    expect((await service.listChanges(REPO, { state: 'merged' })).items[0]?.state).toBe('merged')
    expect(requests.at(-1)?.url.searchParams.get('state')).toBe('merged')
  })

  it('reads the head pipeline and mergeability, and merges at the expected SHA', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/merge_requests/7`, reply: { body: mr({ head_pipeline: { id: 9, status: 'failed', web_url: 'p' }, detailed_merge_status: 'mergeable' }) } },
      { method: 'PUT', path: `${API}/merge_requests/7/merge`, reply: { body: mr({ state: 'merged', merge_commit_sha: 'm1' }) } },
    ])
    const service = new RepoService(testConfig({ tools: { merge: true } }), credentials(TOKENS))
    expect(await service.changeStatus(REPO, 7)).toEqual({ headSha: SHA, checks: [{ name: 'pipeline #9', state: 'failure', webUrl: 'p' }], overall: 'failure', mergeable: true })
    expect(await service.mergeChange(REPO, 7, { headSha: SHA, method: 'squash' })).toEqual({ sha: 'm1' })
    expect(requests.at(-1)?.body).toEqual({ sha: SHA, squash: true })
    await expect(service.mergeChange(REPO, 7, { headSha: SHA, method: 'rebase' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('builds a unified diff from the per-file diffs', async () => {
    fakeHttp([{ method: 'GET', path: `${API}/merge_requests/7/diffs`, reply: { body: [
      { old_path: 'a.txt', new_path: 'a.txt', new_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { old_path: 'n.txt', new_path: 'n.txt', new_file: true, deleted_file: false, diff: '@@ -0,0 +1 @@\n+n\n' },
    ] } }])
    const { diff, truncated } = await new RepoService(testConfig(), credentials(TOKENS)).changeDiff(REPO, 7)
    expect(truncated).toBe(false)
    expect(diff).toBe('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/n.txt b/n.txt\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n')
  })

  it('classifies GitLab errors', async () => {
    fakeHttp([{ method: 'GET', path: API, reply: { status: 401, body: { message: '401 Unauthorized' } } }])
    await expect(new RepoService(testConfig(), credentials(TOKENS)).repoInfo(REPO)).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('401 Unauthorized') })
  })
})
