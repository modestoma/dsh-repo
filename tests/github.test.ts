import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepoService } from '../src/service.ts'
import { credentials, fakeHttp, testConfig, TOKENS } from './helpers.ts'

const REPO = 'https://github.com/modestoma/dsh-repo'
const API = '/repos/modestoma/dsh-repo'
const SHA = 'a'.repeat(40)

const repoBody = { html_url: REPO, default_branch: 'main', description: 'plugin', visibility: 'public', private: false, archived: false, clone_url: `${REPO}.git` }
const author = { login: 'modestoma', html_url: 'https://github.com/modestoma' }

afterEach(() => { vi.unstubAllGlobals() })

describe('GitHub provider', () => {
  it('reads repository metadata through the REST API with the host token', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: API, reply: { body: repoBody } }])
    const info = await new RepoService(testConfig(), credentials(TOKENS)).repoInfo(REPO)
    expect(info).toMatchObject({ kind: 'github', path: 'modestoma/dsh-repo', defaultBranch: 'main', visibility: 'public', cloneUrl: `${REPO}.git` })
    expect(requests[0]?.url.origin).toBe('https://api.github.com')
    expect(requests[0]?.headers.get('authorization')).toBe('token gh-token')
  })

  it('sends GitHub Enterprise Server requests to <url>/api/v3 with that host\'s token', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: '/api/v3/repos/platform/api', reply: { body: { ...repoBody, html_url: 'https://ghe.example.com/platform/api' } } }])
    await new RepoService(testConfig(), credentials(TOKENS)).repoInfo('ghe.example.com/platform/api')
    expect(requests[0]?.url.href).toBe('https://ghe.example.com/api/v3/repos/platform/api')
    expect(requests[0]?.headers.get('authorization')).toBe('token ghe-token')
  })

  it('reads raw file text, cuts it at the byte limit, and reports binary files', async () => {
    fakeHttp([
      { method: 'GET', path: API, reply: { body: repoBody } },
      { method: 'GET', path: `${API}/contents/README.md`, reply: { body: '你好世界' } },
      { method: 'GET', path: `${API}/contents/logo.png`, reply: { body: 'PNG\0data' } },
    ])
    const service = new RepoService(testConfig({ limits: { maxFileBytes: 7 } }), credentials(TOKENS))
    expect(await service.readFile(REPO, 'README.md')).toEqual({ path: 'README.md', ref: 'main', text: '你好', binary: false, truncated: true })
    expect(await service.readFile(REPO, 'logo.png', { ref: 'dev' })).toMatchObject({ ref: 'dev', binary: true, text: '' })
  })

  it('lists issues without pull requests', async () => {
    const issue = (number: number, pr: boolean) => ({
      number, title: `t${number}`, body: null, state: 'open', user: author, labels: [{ name: 'bug' }], assignees: [], created_at: 'c', updated_at: 'u',
      html_url: `${REPO}/issues/${number}`, ...pr ? { pull_request: {} } : {},
    })
    const { requests } = fakeHttp([{ method: 'GET', path: `${API}/issues`, reply: { body: [issue(1, false), issue(2, true)] } }])
    const page = await new RepoService(testConfig(), credentials(TOKENS)).listIssues(REPO, { labels: ['bug'], perPage: 2 })
    expect(page.items.map(item => item.number)).toEqual([1])
    expect(page.items[0]).toMatchObject({ body: '', labels: ['bug'], author: { username: 'modestoma' } })
    expect(page.nextPage).toBe(2)
    expect(requests[0]?.url.searchParams.get('labels')).toBe('bug')
  })

  it('commits files to a new branch: tree on the base commit, commit, then a new ref', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: API, reply: { body: repoBody } },
      { method: 'GET', path: `${API}/branches/feature`, reply: { status: 404, body: { message: 'Branch not found' } } },
      { method: 'GET', path: `${API}/branches/main`, reply: { body: { name: 'main', protected: true, commit: { sha: SHA } } } },
      { method: 'GET', path: `${API}/git/commits/${SHA}`, reply: { body: { sha: SHA, tree: { sha: 'tree0' } } } },
      { method: 'GET', path: new RegExp(`${API}/git/trees/${SHA}(:|%3A)docs$`), reply: { body: { tree: [{ path: 'a.md', mode: '100755', type: 'blob' }] } } },
      { method: 'POST', path: `${API}/git/trees`, reply: { status: 201, body: { sha: 'tree1' } } },
      { method: 'POST', path: `${API}/git/commits`, reply: { status: 201, body: { sha: 'c1', html_url: `${REPO}/commit/c1` } } },
      { method: 'POST', path: `${API}/git/refs`, reply: { status: 201, body: {} } },
    ])
    const result = await new RepoService(testConfig(), credentials(TOKENS)).commitFiles(REPO, {
      branch: 'feature', message: 'docs: add', files: [{ action: 'write', path: 'docs/a.md', content: 'A' }, { action: 'delete', path: 'old.md' }],
    })
    expect(result).toEqual({ sha: 'c1', branch: 'feature', createdBranch: true, webUrl: `${REPO}/commit/c1` })
    const tree = requests.find(request => request.url.pathname.endsWith('/git/trees'))
    expect(tree?.body).toEqual({ base_tree: 'tree0', tree: [
      { path: 'docs/a.md', mode: '100755', type: 'blob', content: 'A' },
      { path: 'old.md', mode: '100644', type: 'blob', sha: null },
    ] })
    expect(requests.find(request => request.url.pathname.endsWith('/git/commits') && request.method === 'POST')?.body).toEqual({ message: 'docs: add', tree: 'tree1', parents: [SHA] })
    expect(requests.at(-1)?.body).toEqual({ ref: 'refs/heads/feature', sha: 'c1' })
  })

  it('refuses commits to the default branch and to protected branches', async () => {
    fakeHttp([
      { method: 'GET', path: API, reply: { body: repoBody } },
      { method: 'GET', path: `${API}/branches/release`, reply: { body: { name: 'release', protected: true, commit: { sha: SHA } } } },
    ])
    const service = new RepoService(testConfig(), credentials(TOKENS))
    const files = [{ action: 'write' as const, path: 'a', content: '' }]
    await expect(service.commitFiles(REPO, { branch: 'main', message: 'm', files })).rejects.toMatchObject({ name: 'RepoError', code: 'forbidden' })
    await expect(service.commitFiles(REPO, { branch: 'release', message: 'm', files })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('maps merged pull requests, labels added after creation, and a moved head on merge', async () => {
    const pr = { number: 5, title: 'T', body: 'B', state: 'closed', draft: false, merged_at: '2026-10-30', head: { ref: 'f', sha: SHA }, base: { ref: 'main' }, user: author, labels: [{ name: 'x' }], assignees: [author], created_at: 'c', updated_at: 'u', html_url: `${REPO}/pull/5` }
    const { requests } = fakeHttp([
      { method: 'POST', path: `${API}/pulls`, reply: { status: 201, body: { ...pr, state: 'open', merged_at: null, labels: [] } } },
      { method: 'PATCH', path: `${API}/issues/5`, reply: { body: {} } },
      { method: 'GET', path: `${API}/pulls/5`, reply: { body: pr } },
      { method: 'PUT', path: `${API}/pulls/5/merge`, reply: { status: 409, body: { message: 'Head branch was modified' } } },
    ])
    const service = new RepoService(testConfig(), credentials(TOKENS))
    const created = await service.createChange(REPO, { title: 'T', sourceBranch: 'f', targetBranch: 'main', labels: ['x'] })
    expect(created).toMatchObject({ number: 5, state: 'merged', labels: ['x'], assignees: [{ username: 'modestoma' }] })
    expect(requests.find(request => request.method === 'PATCH')?.body).toEqual({ labels: ['x'] })
    await expect(service.mergeChange(REPO, 5, { headSha: SHA, method: 'squash' })).rejects.toMatchObject({ code: 'conflict' })
    expect(requests.at(-1)?.body).toEqual({ sha: SHA, merge_method: 'squash' })
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
    const status = await new RepoService(testConfig(), credentials(TOKENS)).changeStatus(REPO, 5)
    expect(status.checks).toHaveLength(102)
    expect(status.overall).toBe('failure')
  })

  it('lists one directory through the Trees API and passes on its truncation flag', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: new RegExp(`${API}/git/trees/dev(:|%3A)src$`), reply: { body: { truncated: true, tree: [{ path: 'a.ts', type: 'blob', mode: '100644', size: 3 }, { path: 'lib', type: 'tree', mode: '040000' }] } } },
    ])
    expect(await new RepoService(testConfig(), credentials(TOKENS)).listTree(REPO, { ref: 'dev', path: 'src/' })).toEqual({
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
    expect(await new RepoService(testConfig(), credentials(TOKENS)).changeStatus(REPO, 5)).toEqual({
      headSha: SHA,
      checks: [{ name: 'test', state: 'success', webUrl: 'u' }, { name: 'ci/lint', state: 'pending' }],
      overall: 'pending',
      mergeable: true,
    })
  })

  it('reports a missing token and host failures as RepoError codes', async () => {
    fakeHttp([{ method: 'GET', path: API, reply: { status: 404, body: { message: 'Not Found' } } }])
    await expect(new RepoService(testConfig(), credentials({})).repoInfo(REPO)).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('GITHUB_TOKEN') })
    await expect(new RepoService(testConfig(), credentials(TOKENS)).repoInfo(REPO)).rejects.toMatchObject({ code: 'not-found' })
  })
})
