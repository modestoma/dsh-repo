import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubProvider } from '../src/providers/github.ts'
import { createService, fakeHttp, testConfig, testSettings, TOKENS } from './helpers.ts'

const REPO = 'https://github.com/modestoma/dsh-repo'
const API = '/repos/modestoma/dsh-repo'
const SHA = 'a'.repeat(40)

const repoBody = { html_url: REPO, default_branch: 'main', description: 'plugin', visibility: 'public', private: false, archived: false, clone_url: `${REPO}.git` }
const author = { login: 'modestoma', html_url: 'https://github.com/modestoma' }

afterEach(() => { vi.unstubAllGlobals() })

describe('GitHub provider', () => {
  it('reads repository metadata through the REST API with the host token', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: API, reply: { body: repoBody } }])
    const info = await createService(testConfig(), TOKENS).repoInfo(REPO)
    expect(info).toMatchObject({ kind: 'github', path: 'modestoma/dsh-repo', defaultBranch: 'main', visibility: 'public', cloneUrl: `${REPO}.git` })
    expect(requests[0]?.url.origin).toBe('https://api.github.com')
    expect(requests[0]?.headers.get('authorization')).toBe('token gh-token')
  })

  it('sends GitHub Enterprise Server requests to <url>/api/v3 with that host\'s token', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: '/api/v3/repos/platform/api', reply: { body: { ...repoBody, html_url: 'https://ghe.example.com/platform/api' } } }])
    await createService(testConfig(), TOKENS).repoInfo('ghe.example.com/platform/api')
    expect(requests[0]?.url.href).toBe('https://ghe.example.com/api/v3/repos/platform/api')
    expect(requests[0]?.headers.get('authorization')).toBe('token ghe-token')
  })

  it('reads raw file text, cuts it at the byte limit, and reports binary files', async () => {
    fakeHttp([
      { method: 'GET', path: API, reply: { body: repoBody } },
      { method: 'GET', path: `${API}/contents/README.md`, reply: { body: '你好世界' } },
      { method: 'GET', path: `${API}/contents/logo.png`, reply: { body: 'PNG\0data' } },
    ])
    const service = createService(testConfig(), TOKENS, testSettings({ limits: { maxFileBytes: 7 } }))
    expect(await service.readFile(REPO, 'README.md')).toEqual({ path: 'README.md', ref: 'main', text: '你好', binary: false, truncated: true })
    expect(await service.readFile(REPO, 'logo.png', { ref: 'dev' })).toMatchObject({ ref: 'dev', binary: true, text: '' })
  })

  it('lists issues without pull requests', async () => {
    const issue = (number: number, pr: boolean) => ({
      number, title: `t${number}`, body: null, state: 'open', user: author, labels: [{ name: 'bug' }], assignees: [], created_at: 'c', updated_at: 'u',
      html_url: `${REPO}/issues/${number}`, ...pr ? { pull_request: {} } : {},
    })
    const { requests } = fakeHttp([{ method: 'GET', path: `${API}/issues`, reply: { body: [issue(1, false), issue(2, true)] } }])
    const page = await createService(testConfig(), TOKENS).listIssues(REPO, { labels: ['bug'], perPage: 2 })
    expect(page.items.map(item => item.number)).toEqual([1])
    expect(page.items[0]).toMatchObject({ body: '', labels: ['bug'], author: { username: 'modestoma' } })
    expect(page.nextPage).toBe(2)
    expect(requests[0]?.url.searchParams.get('labels')).toBe('bug')
  })

  it('reads one branch, and reports a missing or renamed branch as absent', async () => {
    fakeHttp([
      { method: 'GET', path: API, reply: { body: repoBody } },
      { method: 'GET', path: `${API}/branches/main`, reply: { body: { name: 'main', protected: true, commit: { sha: SHA } } } },
      { method: 'GET', path: `${API}/branches/gone`, reply: { status: 404, body: { message: 'Branch not found' } } },
      { method: 'GET', path: `${API}/branches/old`, reply: { body: { name: 'new', protected: false, commit: { sha: SHA } } } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.getBranch(REPO, 'main')).toEqual({ name: 'main', commit: SHA, protected: true, default: true })
    expect(await service.getBranch(REPO, 'gone')).toBeUndefined()
    expect(await service.getBranch(REPO, 'old')).toBeUndefined()
  })

  it('maps merged pull requests, labels added after creation, and a moved head on merge', async () => {
    const pr = { number: 5, title: 'T', body: 'B', state: 'closed', draft: false, merged_at: '2026-10-30', head: { ref: 'f', sha: SHA }, base: { ref: 'main' }, user: author, labels: [{ name: 'x' }], assignees: [author], created_at: 'c', updated_at: 'u', html_url: `${REPO}/pull/5` }
    const { requests } = fakeHttp([
      { method: 'POST', path: `${API}/pulls`, reply: { status: 201, body: { ...pr, state: 'open', merged_at: null, labels: [] } } },
      { method: 'PATCH', path: `${API}/issues/5`, reply: { body: {} } },
      { method: 'GET', path: `${API}/pulls/5`, reply: { body: pr } },
      { method: 'PUT', path: `${API}/pulls/5/merge`, reply: { status: 409, body: { message: 'Head branch was modified' } } },
    ])
    const service = createService(testConfig(), TOKENS)
    const created = await service.createChange(REPO, { title: 'T', sourceBranch: 'f', targetBranch: 'main', labels: ['x'] })
    expect(created).toMatchObject({ number: 5, state: 'merged', labels: ['x'], assignees: [{ username: 'modestoma' }] })
    expect(requests.find(request => request.method === 'PATCH')?.body).toEqual({ labels: ['x'] })
    await expect(service.mergeChange(REPO, 5, { headSha: SHA, method: 'squash' })).rejects.toMatchObject({ code: 'conflict' })
    expect(requests.at(-1)?.body).toEqual({ sha: SHA, merge_method: 'squash' })
  })

  it('deletes the head branch after a merge, keeping a fork\'s branch and treating an auto-deleted branch as deleted', async () => {
    const merged = (headRepo: number | null, ref = 'f') => ({ number: 5, head: { ref, sha: SHA, repo: headRepo === null ? null : { id: headRepo } }, base: { ref: 'main', repo: { id: 1, default_branch: 'main' } } })
    let pull = merged(1)
    let deleteReply: { status: number; body: unknown } = { status: 204, body: undefined }
    const { requests } = fakeHttp([
      { method: 'PUT', path: `${API}/pulls/5/merge`, reply: { body: { sha: 'm1', merged: true } } },
      { method: 'GET', path: `${API}/pulls/5`, reply: () => ({ body: pull }) },
      { method: 'DELETE', path: new RegExp(`${API}/git/refs/heads(/|%2F)f$`), reply: () => deleteReply },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.mergeChange(REPO, 5, { headSha: SHA, deleteSourceBranch: true })).toEqual({ sha: 'm1', sourceBranch: { name: 'f', deleted: true } })
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1)
    deleteReply = { status: 422, body: { message: 'Reference does not exist' } }
    expect((await service.mergeChange(REPO, 5, { headSha: SHA, deleteSourceBranch: true })).sourceBranch).toEqual({ name: 'f', deleted: true })
    deleteReply = { status: 422, body: { message: 'Cannot delete protected branch' } }
    expect((await service.mergeChange(REPO, 5, { headSha: SHA, deleteSourceBranch: true })).sourceBranch).toMatchObject({ name: 'f', deleted: false, reason: expect.stringContaining('protected') })
    pull = merged(2)
    expect((await service.mergeChange(REPO, 5, { headSha: SHA, deleteSourceBranch: true })).sourceBranch).toMatchObject({ deleted: false, reason: expect.stringContaining('fork') })
    pull = merged(1, 'main')
    expect((await service.mergeChange(REPO, 5, { headSha: SHA, deleteSourceBranch: true })).sourceBranch).toMatchObject({ name: 'main', deleted: false })
    const deletes = requests.filter(request => request.method === 'DELETE').length
    expect(await service.mergeChange(REPO, 5, { headSha: SHA })).toEqual({ sha: 'm1' })
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(deletes)
  })

  it('deletes a branch only when its head was merged through a PR and no PR from it is open', async () => {
    const pr = (number: number, state: string, mergedAt: string | null, sha = SHA) => ({ number, title: 'T', body: null, state, draft: false, merged_at: mergedAt, head: { ref: 'f', sha }, base: { ref: 'main' }, user: author, labels: [], assignees: [], created_at: 'c', updated_at: 'u', html_url: `${REPO}/pull/${number}` })
    let pulls = [pr(4, 'closed', null, 'c'.repeat(40)), pr(5, 'closed', '2026-10-30')]
    let branch = { name: 'f', protected: false, commit: { sha: SHA } }
    const { requests } = fakeHttp([
      { method: 'GET', path: API, reply: { body: repoBody } },
      { method: 'GET', path: `${API}/branches/f`, reply: () => ({ body: branch }) },
      { method: 'GET', path: `${API}/branches/main`, reply: { body: { name: 'main', protected: false, commit: { sha: SHA } } } },
      { method: 'GET', path: `${API}/branches/none`, reply: { status: 404, body: { message: 'Branch not found' } } },
      { method: 'GET', path: `${API}/pulls`, reply: () => ({ body: pulls }) },
      { method: 'DELETE', path: new RegExp(`${API}/git/refs/heads(/|%2F)f$`), reply: { status: 204 } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.deleteMergedBranch(REPO, 'f')).toEqual({ branch: 'f', commit: SHA, change: { number: 5, webUrl: `${REPO}/pull/5` } })
    const list = requests.find(request => request.url.pathname === `${API}/pulls`)
    expect(list?.url.searchParams.get('head')).toBe('modestoma:f')
    expect(list?.url.searchParams.get('state')).toBe('all')
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1)

    pulls = [pr(5, 'closed', '2026-10-30'), pr(6, 'open', null)]
    await expect(service.deleteMergedBranch(REPO, 'f')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('#6') })
    pulls = [pr(5, 'closed', '2026-10-30', 'c'.repeat(40))]
    await expect(service.deleteMergedBranch(REPO, 'f')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('没有通过已合并') })
    pulls = [pr(5, 'closed', null)]
    await expect(service.deleteMergedBranch(REPO, 'f')).rejects.toMatchObject({ code: 'conflict' })
    branch = { ...branch, protected: true }
    await expect(service.deleteMergedBranch(REPO, 'f')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.deleteMergedBranch(REPO, 'main')).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('默认分支') })
    await expect(service.deleteMergedBranch(REPO, 'none')).rejects.toMatchObject({ code: 'not-found' })
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1)
  })

  it('aggregates every page of check runs with commit statuses', async () => {
    const passing = Array.from({ length: 100 }, (_, index) => ({ name: `ok${index}`, status: 'completed', conclusion: 'success', html_url: null }))
    fakeHttp([
      { method: 'GET', path: `${API}/pulls/5`, reply: { body: { head: { sha: SHA }, mergeable: true } } },
      { method: 'GET', path: `${API}/commits/${SHA}/check-runs`, reply: request => request.url.searchParams.get('page') === '1'
        ? { body: { check_runs: passing } }
        : { body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'u' }] } } },
      { method: 'GET', path: `${API}/commits/${SHA}/status`, reply: { body: { statuses: [{ context: 'ci/lint', state: 'pending', target_url: null }] } } },
    ])
    const status = await createService(testConfig(), TOKENS).changeStatus(REPO, 5)
    expect(status.checks).toHaveLength(102)
    expect(status.overall).toBe('failure')
  })

  it('lists one directory through the Trees API and passes on its truncation flag', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: new RegExp(`${API}/git/trees/dev(:|%3A)src$`), reply: { body: { truncated: true, tree: [{ path: 'a.ts', type: 'blob', mode: '100644', size: 3 }, { path: 'lib', type: 'tree', mode: '040000' }] } } },
    ])
    expect(await createService(testConfig(), TOKENS).listTree(REPO, { ref: 'dev', path: 'src/' })).toEqual({
      ref: 'dev', truncated: true, entries: [{ path: 'src/a.ts', type: 'file', size: 3 }, { path: 'src/lib', type: 'dir' }],
    })
    expect(requests[0]?.url.searchParams.has('recursive')).toBe(false)
  })

  it('aggregates check runs and commit statuses', async () => {
    fakeHttp([
      { method: 'GET', path: `${API}/pulls/5`, reply: { body: { head: { sha: SHA }, mergeable: true } } },
      { method: 'GET', path: `${API}/commits/${SHA}/check-runs`, reply: { body: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'u' }] } } },
      { method: 'GET', path: `${API}/commits/${SHA}/status`, reply: { body: { statuses: [{ context: 'ci/lint', state: 'pending', target_url: null }] } } },
    ])
    expect(await createService(testConfig(), TOKENS).changeStatus(REPO, 5)).toEqual({
      headSha: SHA,
      checks: [{ name: 'test', state: 'success', webUrl: 'u' }, { name: 'ci/lint', state: 'pending' }],
      overall: 'pending',
      mergeable: true,
    })
  })

  it('reports a missing token and host failures as RepoError codes', async () => {
    fakeHttp([{ method: 'GET', path: API, reply: { status: 404, body: { message: 'Not Found' } } }])
    await expect(createService(testConfig(), {}).repoInfo(REPO)).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('GITHUB_TOKEN') })
    await expect(createService(testConfig(), TOKENS).repoInfo(REPO)).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('GitHub token account', () => {
  const call = () => ({ signal: AbortSignal.timeout(5_000), limits: testSettings().limits })

  it('commits as the token account, with its noreply address when the email is private', async () => {
    fakeHttp([{ method: 'GET', path: '/api/v3/user', reply: { body: { login: 'bot', id: 7, name: null, email: null } } }])
    expect(await new GithubProvider('https://ghe.example.com/api/v3', async () => 't').currentUser(call())).toEqual({ name: 'bot', email: '7+bot@users.noreply.ghe.example.com' })
    fakeHttp([{ method: 'GET', path: '/user', reply: { body: { login: 'bot', id: 7, name: 'Shared Bot', email: 'bot@example.com' } } }])
    expect(await new GithubProvider('https://api.github.com', async () => 't').currentUser(call())).toEqual({ name: 'Shared Bot', email: 'bot@example.com' })
  })
})
