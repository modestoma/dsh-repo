import { afterEach, describe, expect, it, vi } from 'vitest'
import { createService, fakeHttp, testConfig, TOKENS } from './helpers.ts'

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
    const info = await createService(testConfig(), TOKENS).repoInfo(REPO)
    expect(info).toMatchObject({ kind: 'gitlab', path: 'team/backend/orders', defaultBranch: 'main', visibility: 'internal' })
    expect(info.description).toBeUndefined()
    expect(requests[0]?.url.origin).toBe('https://code.example.com')
    expect(requests[0]?.headers.get('private-token')).toBe('gl-token')
  })

  it('asks for exactly one page', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: `${API}/repository/branches`, reply: { body: [{ name: 'main', commit: { id: SHA }, protected: true, default: true }] } }])
    const page = await createService(testConfig(), TOKENS).listBranches(REPO, { page: 2, perPage: 10 })
    expect(page).toEqual({ items: [{ name: 'main', commit: SHA, protected: true, default: true }] })
    expect(requests).toHaveLength(1)
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({ page: '2', per_page: '10' })
  })

  it('reads one branch and reports a missing one as absent', async () => {
    fakeHttp([
      { method: 'GET', path: `${API}/repository/branches/feature`, reply: { body: { name: 'feature', protected: false, default: false, commit: { id: SHA } } } },
      { method: 'GET', path: `${API}/repository/branches/gone`, reply: { status: 404, body: { message: '404 Branch Not Found' } } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.getBranch(REPO, 'feature')).toEqual({ name: 'feature', commit: SHA, protected: false, default: false })
    expect(await service.getBranch(REPO, 'gone')).toBeUndefined()
  })

  it('maps issue states and closes through state events', async () => {
    const issue = { iid: 3, title: 'Bug', description: 'd', state: 'closed', author, labels: ['bug'], assignees: [author], created_at: 'c', updated_at: 'u', web_url: `${REPO}/-/issues/3` }
    const { requests } = fakeHttp([
      { method: 'GET', path: '/gitlab/api/v4/users', reply: { body: [{ id: 42, username: 'dev' }] } },
      { method: 'PUT', path: `${API}/issues/3`, reply: { body: issue } },
      { method: 'GET', path: `${API}/issues`, reply: { body: [issue] } },
    ])
    const service = createService(testConfig(), TOKENS)
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
    const service = createService(testConfig(), TOKENS)
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
    const service = createService(testConfig({ tools: { merge: true } }), TOKENS)
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
    const { diff, truncated } = await createService(testConfig(), TOKENS).changeDiff(REPO, 7)
    expect(truncated).toBe(false)
    expect(diff).toBe('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/n.txt b/n.txt\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n')
  })

  it('marks the diff incomplete when GitLab omits a file', async () => {
    fakeHttp([{ method: 'GET', path: `${API}/merge_requests/7/diffs`, reply: { body: [
      { old_path: 'big.json', new_path: 'big.json', new_file: false, deleted_file: false, too_large: true, collapsed: false, diff: '' },
    ] } }])
    const { diff, truncated } = await createService(testConfig(), TOKENS).changeDiff(REPO, 7)
    expect(truncated).toBe(true)
    expect(diff).toContain('GitLab 未返回这个文件的 diff')
  })

  it('classifies GitLab errors', async () => {
    fakeHttp([{ method: 'GET', path: API, reply: { status: 401, body: { message: '401 Unauthorized' } } }])
    await expect(createService(testConfig(), TOKENS).repoInfo(REPO)).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('401 Unauthorized') })
  })
})
