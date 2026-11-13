import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { GitlabProvider } from '../src/providers/gitlab.ts'
import { createService, fakeHttp, testConfig, testSettings, TOKENS } from './helpers.ts'

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
    const info = await createService(testConfig(), TOKENS).forge.repoInfo(REPO)
    expect(info).toMatchObject({ kind: 'gitlab', path: 'team/backend/orders', defaultBranch: 'main', visibility: 'internal' })
    expect(info.description).toBeUndefined()
    expect(requests[0]?.url.origin).toBe('https://code.example.com')
    expect(requests[0]?.headers.get('private-token')).toBe('gl-token')
  })

  it('asks for exactly one page', async () => {
    const { requests } = fakeHttp([{ method: 'GET', path: `${API}/repository/branches`, reply: { body: [{ name: 'main', commit: { id: SHA }, protected: true, default: true }] } }])
    const page = await createService(testConfig(), TOKENS).forge.listBranches(REPO, { page: 2, perPage: 10 })
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
    expect(await service.forge.getBranch(REPO, 'feature')).toEqual({ name: 'feature', commit: SHA, protected: false, default: false })
    expect(await service.forge.getBranch(REPO, 'gone')).toBeUndefined()
  })

  it('maps issue states and closes through state events', async () => {
    const issue = { iid: 3, title: 'Bug', description: 'd', state: 'closed', author, labels: ['bug'], assignees: [author], created_at: 'c', updated_at: 'u', web_url: `${REPO}/-/issues/3` }
    const { requests } = fakeHttp([
      { method: 'GET', path: '/gitlab/api/v4/users', reply: { body: [{ id: 42, username: 'dev' }] } },
      { method: 'PUT', path: `${API}/issues/3`, reply: { body: issue } },
      { method: 'GET', path: `${API}/issues`, reply: { body: [issue] } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.forge.updateIssue(REPO, 3, { state: 'closed', assignees: ['dev'], labels: ['bug', 'p1'] })).toMatchObject({ number: 3, state: 'closed', assignees: [{ username: 'dev' }] })
    expect(requests.find(request => request.method === 'PUT')?.body).toEqual({ state_event: 'close', assignee_ids: [42], labels: 'bug,p1' })
    await service.forge.listIssues(REPO, { state: 'open', assignee: 'dev' })
    expect(requests.at(-1)?.url.searchParams.get('state')).toBe('opened')
  })

  it('opens draft merge requests with the Draft: title prefix and maps merged state', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: API, reply: { body: project } },
      { method: 'POST', path: `${API}/merge_requests`, reply: { status: 201, body: mr({ title: 'Draft: T', draft: true }) } },
      { method: 'GET', path: `${API}/merge_requests`, reply: { body: [mr({ state: 'merged' })] } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.forge.createMr(REPO, { title: 'T', sourceBranch: 'f', draft: true })).toMatchObject({ number: 7, draft: true, targetBranch: 'main', body: '' })
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ source_branch: 'f', target_branch: 'main', title: 'Draft: T' })
    expect((await service.forge.listMrs(REPO, { state: 'merged' })).items[0]?.state).toBe('merged')
    expect(requests.at(-1)?.url.searchParams.get('state')).toBe('merged')
  })

  it('opens a merge request into the catalog baseline branch when no target is given', async () => {
    const { requests } = fakeHttp([
      { method: 'POST', path: `${API}/merge_requests`, reply: { status: 201, body: mr({ target_branch: 'dev' }) } },
    ])
    const service = createService(testConfig(), TOKENS, DEFAULT_SETTINGS, [{ id: '000000000000', url: REPO, base: 'dev', access: 'merge', features: [], addedAt: '2026-11-09T00:00:00.000Z' }])
    await service.forge.createMr(REPO, { title: 'T', sourceBranch: 'f' })
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ source_branch: 'f', target_branch: 'dev' })
    expect(requests.some(request => request.url.pathname === API)).toBe(false)
  })

  it('lists merge requests from a source branch of this project only, leaving out forks with the same branch name', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/merge_requests`, reply: { body: [mr({ iid: 7, source_project_id: 1, target_project_id: 1 }), mr({ iid: 8, source_project_id: 2, target_project_id: 1 })] } },
    ])
    const page = await createService(testConfig(), TOKENS).forge.listMrs(REPO, { state: 'open', sourceBranch: 'f' })
    expect(page.items.map(item => item.number)).toEqual([7])
    expect(requests[0]?.url.searchParams.get('source_branch')).toBe('f')
  })

  it('reads the head pipeline and mergeability, and merges at the expected SHA', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/merge_requests/7`, reply: { body: mr({ head_pipeline: { id: 9, status: 'failed', web_url: 'p' }, detailed_merge_status: 'mergeable' }) } },
      { method: 'PUT', path: `${API}/merge_requests/7/merge`, reply: { body: mr({ state: 'merged', merge_commit_sha: 'm1' }) } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.forge.mrStatus(REPO, 7)).toEqual({ headSha: SHA, checks: [{ name: 'pipeline #9', state: 'failure', webUrl: 'p', runId: 9 }], overall: 'failure', mergeable: true })
    expect(await service.forge.mergeMr(REPO, 7, { headSha: SHA, method: 'squash' })).toEqual({ sha: 'm1' })
    expect(requests.at(-1)?.body).toEqual({ sha: SHA, squash: true })
    await expect(service.forge.mergeMr(REPO, 7, { headSha: SHA, method: 'rebase' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('ticks "delete source branch" on new merge requests and asks GitLab to delete it on merge, except for forks', async () => {
    let shown = mr({ source_project_id: 1, target_project_id: 1 })
    const { requests } = fakeHttp([
      { method: 'POST', path: `${API}/merge_requests`, reply: { status: 201, body: mr({ force_remove_source_branch: true }) } },
      { method: 'GET', path: `${API}/merge_requests/7`, reply: () => ({ body: shown }) },
      { method: 'PUT', path: `${API}/merge_requests/7/merge`, reply: request => ({ body: mr({ state: 'merged', merge_commit_sha: 'm1', should_remove_source_branch: (request.body as { should_remove_source_branch?: boolean }).should_remove_source_branch ?? null, force_remove_source_branch: false }) }) },
    ])
    const service = createService(testConfig(), TOKENS)
    await service.forge.createMr(REPO, { title: 'T', sourceBranch: 'f', targetBranch: 'main', deleteSourceBranch: true })
    expect(requests.at(-1)?.body).toMatchObject({ remove_source_branch: true })
    await service.forge.createMr(REPO, { title: 'T', sourceBranch: 'f', targetBranch: 'main' })
    expect(requests.at(-1)?.body).not.toHaveProperty('remove_source_branch')

    expect(await service.forge.mergeMr(REPO, 7, { headSha: SHA, deleteSourceBranch: true })).toEqual({ sha: 'm1', sourceBranch: { name: 'f', deleted: true } })
    expect(requests.at(-1)?.body).toEqual({ sha: SHA, should_remove_source_branch: true })
    shown = mr({ source_project_id: 2, target_project_id: 1 })
    expect(await service.forge.mergeMr(REPO, 7, { headSha: SHA, deleteSourceBranch: true })).toEqual({ sha: 'm1', sourceBranch: { name: 'f', deleted: false, reason: expect.stringContaining('fork') } })
    expect(requests.at(-1)?.body).toEqual({ sha: SHA })
  })

  it('deletes a merged branch through the Branches API', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/repository/branches/f`, reply: { body: { name: 'f', protected: false, default: false, commit: { id: SHA } } } },
      { method: 'GET', path: `${API}/merge_requests`, reply: { body: [mr({ state: 'merged', source_project_id: 1, target_project_id: 1 })] } },
      { method: 'DELETE', path: `${API}/repository/branches/f`, reply: { status: 204 } },
    ])
    expect(await createService(testConfig(), TOKENS).forge.deleteMergedBranch(REPO, 'f')).toEqual({ branch: 'f', commit: SHA, mr: { number: 7, webUrl: `${REPO}/-/merge_requests/7` } })
    const list = requests.find(request => request.url.pathname === `${API}/merge_requests`)
    expect(list?.url.searchParams.get('source_branch')).toBe('f')
    expect(list?.url.searchParams.has('state')).toBe(false)
    expect(requests.at(-1)?.method).toBe('DELETE')
  })

  it('builds a unified diff from the per-file diffs', async () => {
    fakeHttp([{ method: 'GET', path: `${API}/merge_requests/7/diffs`, reply: { body: [
      { old_path: 'a.txt', new_path: 'a.txt', new_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { old_path: 'n.txt', new_path: 'n.txt', new_file: true, deleted_file: false, diff: '@@ -0,0 +1 @@\n+n\n' },
    ] } }])
    const { diff, truncated } = await createService(testConfig(), TOKENS).forge.mrDiff(REPO, 7)
    expect(truncated).toBe(false)
    expect(diff).toBe('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/n.txt b/n.txt\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n')
  })

  it('marks the diff incomplete when GitLab omits a file', async () => {
    fakeHttp([{ method: 'GET', path: `${API}/merge_requests/7/diffs`, reply: { body: [
      { old_path: 'big.json', new_path: 'big.json', new_file: false, deleted_file: false, too_large: true, collapsed: false, diff: '' },
    ] } }])
    const { diff, truncated } = await createService(testConfig(), TOKENS).forge.mrDiff(REPO, 7)
    expect(truncated).toBe(true)
    expect(diff).toContain('GitLab 未返回这个文件的 diff')
  })

  it('classifies GitLab errors', async () => {
    fakeHttp([{ method: 'GET', path: API, reply: { status: 401, body: { message: '401 Unauthorized' } } }])
    await expect(createService(testConfig(), TOKENS).forge.repoInfo(REPO)).rejects.toMatchObject({ code: 'unauthenticated', message: expect.stringContaining('401 Unauthorized') })
  })
})

describe('GitLab token account', () => {
  const call = () => ({ signal: AbortSignal.timeout(5_000), limits: testSettings().limits })
  const provider = () => new GitlabProvider('https://code.example.com/gitlab', async () => 't', 5_000)
  const account = { id: 9, username: 'bot', name: 'Shared Bot', public_email: '' }

  it('commits as the token account with its commit email, then its email, then a noreply address', async () => {
    fakeHttp([{ method: 'GET', path: '/gitlab/api/v4/user', reply: { body: { ...account, email: 'bot@example.com', commit_email: 'commits@example.com' } } }])
    expect(await provider().currentUser(call())).toEqual({ name: 'Shared Bot', email: 'commits@example.com' })
    fakeHttp([{ method: 'GET', path: '/gitlab/api/v4/user', reply: { body: { ...account, email: 'bot@example.com' } } }])
    expect(await provider().currentUser(call())).toEqual({ name: 'Shared Bot', email: 'bot@example.com' })
    fakeHttp([{ method: 'GET', path: '/gitlab/api/v4/user', reply: { body: account } }])
    expect(await provider().currentUser(call())).toEqual({ name: 'Shared Bot', email: '9-bot@users.noreply.code.example.com' })
  })
  it('polls a merge request for a watch: pipeline every time, notes after an update, approvals and change requests from system notes', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/merge_requests/7`, reply: { body: mr({ updated_at: '2026-11-01T01:00:00.000Z', has_conflicts: true, head_pipeline: { id: 40, status: 'running', web_url: 'p' } }) } },
      { method: 'GET', path: `${API}/merge_requests/7/notes`, reply: { body: [
        { id: 14, body: 'requested changes', author: { username: 'erin' }, created_at: '2026-11-01T00:55:00.000Z', system: true },
        { id: 13, body: 'added 1 commit', author, created_at: '2026-11-01T00:52:00.000Z', system: true },
        { id: 12, body: 'approved this merge request', author: { username: 'carol' }, created_at: '2026-11-01T00:50:00.000Z', system: true },
        { id: 11, body: 'why?', author: { username: 'alice' }, created_at: '2026-11-01T00:40:00.000Z', position: { new_path: 'src/b.ts' } },
        { id: 10, body: 'old', author, created_at: '2026-11-01T00:10:00.000Z' },
      ] } },
    ])
    const service = createService(testConfig(), TOKENS)
    const polled = await service.forge.mrActivity(REPO, 7, { withStatus: false, since: '2026-11-01T00:30:00.000Z' })
    expect(polled.conflict).toBe(true)
    expect(polled.status).toMatchObject({ overall: 'pending', checks: [{ name: 'pipeline #40' }] })
    expect(polled.items?.map(item => [item.id, item.kind, item.author.username, item.path])).toEqual([
      ['11', 'comment', 'alice', 'src/b.ts'], ['12', 'approved', 'carol', undefined], ['14', 'changes-requested', 'erin', undefined],
    ])
    expect(polled.items?.[0]?.webUrl).toBe(`${REPO}/-/merge_requests/7#note_11`)
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toMatchObject({ sort: 'desc', order_by: 'created_at', per_page: '100' })
    requests.length = 0
    expect((await service.forge.mrActivity(REPO, 7, { updatedAt: '2026-11-01T01:00:00.000Z', withStatus: false, since: '2026-11-01T00:55:00.000Z' })).items).toBeUndefined()
    expect(requests).toHaveLength(1)
  })
  it('reads older pages of notes until one predates the cursor', async () => {
    const notes = (start: number, count: number, createdAt: string) => Array.from({ length: count }, (_, index) => ({
      id: start - index, body: `n${start - index}`, author: { username: 'alice' }, created_at: createdAt,
    }))
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/merge_requests/7`, reply: { body: mr({ updated_at: '2026-11-01T01:00:00.000Z' }) } },
      { method: 'GET', path: `${API}/merge_requests/7/notes`, reply: request => ({ body: request.url.searchParams.get('page') === '2'
        ? [...notes(400, 10, '2026-11-01T00:40:00.000Z'), ...notes(300, 5, '2026-11-01T00:10:00.000Z')]
        : notes(500, 100, '2026-11-01T00:50:00.000Z') }) },
    ])
    const polled = await createService(testConfig(), TOKENS).forge.mrActivity(REPO, 7, { withStatus: false, since: '2026-11-01T00:30:00.000Z' })
    expect(polled.items).toHaveLength(110)
    expect(polled.items?.[0]?.id).toBe('391')
    expect(requests.filter(request => request.url.pathname.endsWith('/notes'))).toHaveLength(2)
  })
})

describe('GitLab CI', () => {
  const pipelineBody = (overrides: Record<string, unknown> = {}) => ({
    id: 42, iid: 3, project_id: 11, sha: SHA, ref: 'main', status: 'failed', source: 'push', created_at: 'c', updated_at: 'u', web_url: `${REPO}/-/pipelines/42`, ...overrides,
  })
  const jobBody = (id: number, overrides: Record<string, unknown> = {}) => ({
    id, name: `job-${id}`, stage: 'test', status: 'success', allow_failure: false, started_at: 's', finished_at: 'f', duration: 12.4, web_url: `${REPO}/-/jobs/${id}`, pipeline: { id: 42 }, ...overrides,
  })

  it('lists pipelines newest first with filters, and an MR\'s pipelines filtered by state', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/pipelines`, reply: { body: [pipelineBody()] } },
      { method: 'GET', path: `${API}/merge_requests/7/pipelines`, reply: { body: [pipelineBody({ id: 43, status: 'running' }), pipelineBody()] } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.forge.listCiRuns(REPO, { ref: 'main', state: 'failure', perPage: 1 })).toEqual({
      items: [{ id: 42, state: 'failure', status: 'failed', ref: 'main', sha: SHA, event: 'push', createdAt: 'c', updatedAt: 'u', webUrl: `${REPO}/-/pipelines/42` }],
      nextPage: 2,
    })
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({ ref: 'main', status: 'failed', order_by: 'id', sort: 'desc', per_page: '1', page: '1' })
    expect((await service.forge.listCiRuns(REPO, { mr: 7, state: 'running' })).items.map(run => run.id)).toEqual([43])
    await expect(service.forge.listCiRuns(REPO, { mr: 7, ref: 'main' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.forge.listCiRuns(REPO, { sha: 'abc' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('reads a failed pipeline with its jobs, trigger jobs, and failed tests cut to the limits', async () => {
    const report = {
      total_count: 3, success_count: 1, failed_count: 1, skipped_count: 0, error_count: 1,
      test_suites: [{ name: 'unit', test_cases: [
        { status: 'success', name: 'ok', classname: 'A' },
        { status: 'failed', name: 'adds', classname: 'Math', file: 'src/math.ts', system_output: 'x'.repeat(100) },
        { status: 'error', name: 'boots', classname: '', stack_trace: ['line 1', 'line 2'] },
      ] }],
    }
    fakeHttp([
      { method: 'GET', path: `${API}/pipelines/42`, reply: { body: pipelineBody({ started_at: 's', finished_at: 'f', duration: 61, yaml_errors: null }) } },
      { method: 'GET', path: `${API}/pipelines/42/jobs`, reply: { body: [jobBody(1), jobBody(2, { status: 'failed', failure_reason: 'script_failure' })] } },
      { method: 'GET', path: `${API}/pipelines/42/bridges`, reply: { body: [jobBody(3, { name: 'deploy', stage: 'deploy', status: 'failed', downstream_pipeline: { id: 50, project_id: 11, status: 'failed', web_url: `${REPO}/-/pipelines/50` } })] } },
      { method: 'GET', path: `${API}/pipelines/42/test_report`, reply: { body: report } },
    ])
    const service = createService(testConfig(), TOKENS, testSettings({ limits: { maxLogBytes: 1024, maxCiFailures: 2 } }))
    const run = await service.forge.getCiRun(REPO, 42)
    expect(run).toMatchObject({ id: 42, state: 'failure', startedAt: 's', finishedAt: 'f', durationSeconds: 61, jobsTruncated: false, tests: { total: 3, failed: 1, error: 1 }, failuresTruncated: false })
    expect(run.yamlErrors).toBeUndefined()
    expect(run.jobs.map(job => [job.id, job.state, job.failureReason])).toEqual([[1, 'success', undefined], [2, 'failure', 'script_failure'], [3, 'failure', undefined]])
    expect(run.jobs[0]).toMatchObject({ stage: 'test', durationSeconds: 12, allowFailure: false })
    expect(run.jobs[2]?.downstream).toEqual({ id: 50, state: 'failure', status: 'failed', webUrl: `${REPO}/-/pipelines/50`, sameRepo: true })
    expect(run.failures).toEqual([
      { suite: 'unit', name: 'Math adds', path: 'src/math.ts', message: 'x'.repeat(100) },
      { suite: 'unit', name: 'boots', message: 'line 1\nline 2' },
    ])
    expect((await createService(testConfig(), TOKENS, testSettings({ limits: { maxLogBytes: 1024, maxCiFailures: 1 } })).forge.getCiRun(REPO, 42, { onlyFailed: true })).failuresTruncated).toBe(true)
    const only = await service.forge.getCiRun(REPO, 42, { onlyFailed: true })
    expect(only.jobs.map(job => job.id)).toEqual([2, 3])
  })

  it('still returns the jobs when the test report cannot be read', async () => {
    fakeHttp([
      { method: 'GET', path: `${API}/pipelines/42`, reply: { body: pipelineBody() } },
      { method: 'GET', path: `${API}/pipelines/42/jobs`, reply: { body: [jobBody(2, { status: 'failed' })] } },
      { method: 'GET', path: `${API}/pipelines/42/bridges`, reply: { body: [] } },
      { method: 'GET', path: `${API}/pipelines/42/test_report`, reply: { status: 403, body: { message: '403 Forbidden' } } },
    ])
    const run = await createService(testConfig(), TOKENS).forge.getCiRun(REPO, 42)
    expect(run.jobs).toHaveLength(1)
    expect(run.failures).toEqual([])
    expect(run.failuresError).toMatch(/读取测试报告失败/)
  })

  it('streams a job trace with the host token and cleans it', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/jobs/2`, reply: { body: jobBody(2, { status: 'failed' }) } },
      { method: 'GET', path: `${API}/jobs/2/trace`, reply: { body: 'section_start:1:step_script\r\x1b[0K$ make\n\x1b[31merror: boom\x1b[0m\nsection_end:2:step_script\r\x1b[0K\n' } },
    ])
    const log = await createService(testConfig(), TOKENS).forge.ciJobLog(REPO, 2, { search: ['ERROR'] })
    expect(log).toMatchObject({ job: { id: 2, state: 'failure' }, totalLines: 2, matches: 1, text: '1: ▶ step_script: $ make\n2: error: boom', sections: ['step_script'] })
    expect(requests.at(-1)?.url.href).toBe('https://code.example.com/gitlab/api/v4/projects/team%2Fbackend%2Forders/jobs/2/trace')
    expect(requests.at(-1)?.headers.get('private-token')).toBe('gl-token')
  })

  it('classifies a refused trace and rejects bad log options before calling the host', async () => {
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/jobs/2`, reply: { body: jobBody(2) } },
      { method: 'GET', path: `${API}/jobs/2/trace`, reply: { status: 403, body: 'forbidden' } },
    ])
    const service = createService(testConfig(), TOKENS)
    await expect(service.forge.ciJobLog(REPO, 2)).rejects.toMatchObject({ code: 'forbidden' })
    const sent = requests.length
    await expect(service.forge.ciJobLog(REPO, 2, { search: ['x'], beforeLine: 3 })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.forge.ciJobLog(REPO, 2, { context: 51 })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.forge.ciJobLog(REPO, 0)).rejects.toMatchObject({ code: 'invalid' })
    expect(requests).toHaveLength(sent)
  })

  it('retries and cancels pipelines and jobs', async () => {
    const { requests } = fakeHttp([
      { method: 'POST', path: `${API}/pipelines/42/retry`, reply: { status: 201, body: pipelineBody({ status: 'running' }) } },
      { method: 'POST', path: `${API}/pipelines/42/cancel`, reply: { body: pipelineBody({ status: 'canceled' }) } },
      { method: 'POST', path: `${API}/jobs/2/retry`, reply: { status: 201, body: jobBody(9, { status: 'pending' }) } },
      { method: 'POST', path: `${API}/jobs/2/cancel`, reply: { body: jobBody(2, { status: 'canceled' }) } },
    ])
    const service = createService(testConfig(), TOKENS)
    expect(await service.forge.retryCi(REPO, { runId: 42 })).toEqual({ runId: 42, state: 'running', webUrl: `${REPO}/-/pipelines/42` })
    expect(await service.forge.cancelCi(REPO, { runId: 42 })).toMatchObject({ runId: 42, state: 'canceled' })
    expect(await service.forge.retryCi(REPO, { jobId: 2 })).toEqual({ runId: 42, jobId: 9, state: 'pending', webUrl: `${REPO}/-/jobs/9` })
    expect(await service.forge.cancelCi(REPO, { jobId: 2 })).toMatchObject({ jobId: 2, state: 'canceled' })
    expect(requests.map(request => request.url.pathname.split('/').slice(-3).join('/'))).toEqual(['pipelines/42/retry', 'pipelines/42/cancel', 'jobs/2/retry', 'jobs/2/cancel'])
  })

  it('sorts merge requests by updated_at and cuts pagination early when updatedAfter is reached', async () => {
    let rows = [
      mr({ iid: 9, updated_at: '2026-11-13T12:00:00Z' }),
      mr({ iid: 8, updated_at: '2026-11-13T10:00:00Z' }),
    ]
    const { requests } = fakeHttp([
      { method: 'GET', path: `${API}/merge_requests`, reply: () => ({ body: rows }) },
    ])
    const service = createService(testConfig(), TOKENS)

    const cut = await service.forge.listMrs(REPO, { updatedAfter: '2026-11-13T10:00:00Z', perPage: 2 })
    expect(cut.items.map(item => item.number)).toEqual([9])
    expect(cut.nextPage).toBeUndefined()
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({ order_by: 'updated_at', sort: 'desc', per_page: '2' })

    rows = [
      mr({ iid: 10, updated_at: '2026-11-13T14:00:00Z' }),
      mr({ iid: 9, updated_at: '2026-11-13T12:00:00Z' }),
    ]
    const more = await service.forge.listMrs(REPO, { sort: 'created', updatedAfter: '2026-11-13T10:00:00Z', perPage: 2 })
    expect(more.items.map(item => item.number)).toEqual([10, 9])
    expect(more.nextPage).toBe(2)
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toMatchObject({ order_by: 'created_at', sort: 'desc' })
  })

  it('compares commits and respects maxDiffBytes and compare_timeout truncation', async () => {
    const base = '1'.repeat(40)
    const head = '2'.repeat(40)
    let timeout = false
    const { requests } = fakeHttp([
      {
        method: 'GET',
        path: `${API}/repository/compare`,
        reply: () => ({
          body: {
            diffs: [{ old_path: 'src/a.ts', new_path: 'src/a.ts', new_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-old\n+new\n' }],
            compare_timeout: timeout,
          },
        }),
      },
    ])
    const service = createService(testConfig(), TOKENS)
    const full = await service.forge.mrCompare(REPO, base, head)
    expect(full.truncated).toBe(false)
    expect(full.diff).toContain('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new')
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toMatchObject({ from: base, to: head })

    timeout = true
    expect((await service.forge.mrCompare(REPO, base, head)).truncated).toBe(true)

    const capped = createService(testConfig(), TOKENS, testSettings({ limits: { maxDiffBytes: 12 } }))
    expect(await capped.forge.mrCompare(REPO, base, head)).toEqual({ diff: 'diff --git a', truncated: true })
  })

  it('lists MR discussions without system notes, maps positions and resolvedBy, and filters onlyUnresolved', async () => {
    fakeHttp([
      {
        method: 'GET',
        path: `${API}/merge_requests/7/discussions`,
        reply: {
          body: [
            {
              id: 'sys-only',
              individual_note: true,
              notes: [{ id: 1, body: 'assigned to @dev', author, created_at: '2026-11-13T09:00:00Z', system: true }],
            },
            {
              id: 'disc-inline-open',
              individual_note: false,
              notes: [
                {
                  id: 11,
                  body: 'Guard empty slice',
                  author,
                  created_at: '2026-11-13T10:00:00Z',
                  updated_at: '2026-11-13T10:01:00Z',
                  system: false,
                  resolvable: true,
                  resolved: false,
                  position: { position_type: 'text', new_path: 'src/order.ts', old_path: 'src/order.ts', new_line: 42, old_line: null },
                },
                {
                  id: 12,
                  body: 'resolved all threads',
                  author,
                  created_at: '2026-11-13T10:02:00Z',
                  system: true,
                },
              ],
            },
            {
              id: 'disc-inline-resolved',
              individual_note: false,
              notes: [
                {
                  id: 21,
                  body: 'Nit: typo',
                  author,
                  created_at: '2026-11-13T08:00:00Z',
                  system: false,
                  resolvable: true,
                  resolved: true,
                  resolved_by: { username: 'maintainer', web_url: 'https://code.example.com/gitlab/maintainer' },
                  position: { position_type: 'text', new_path: 'src/old.ts', old_path: 'src/old.ts', new_line: null, old_line: 9 },
                },
              ],
            },
          ],
        },
      },
    ])
    const service = createService(testConfig(), TOKENS)

    const all = await service.forge.mrDiscussions(REPO, 7)
    expect(all.items).toEqual([
      {
        id: 'disc-inline-open',
        inline: true,
        position: { path: 'src/order.ts', newLine: 42 },
        resolvable: true,
        resolved: false,
        notes: [{
          id: '11',
          author: { username: 'dev', webUrl: 'https://code.example.com/gitlab/dev' },
          body: 'Guard empty slice',
          createdAt: '2026-11-13T10:00:00Z',
          updatedAt: '2026-11-13T10:01:00Z',
          webUrl: `${REPO}/-/merge_requests/7#note_11`,
        }],
      },
      {
        id: 'disc-inline-resolved',
        inline: true,
        position: { path: 'src/old.ts', oldLine: 9 },
        resolvable: true,
        resolved: true,
        resolvedBy: { username: 'maintainer', webUrl: 'https://code.example.com/gitlab/maintainer' },
        notes: [{
          id: '21',
          author: { username: 'dev', webUrl: 'https://code.example.com/gitlab/dev' },
          body: 'Nit: typo',
          createdAt: '2026-11-13T08:00:00Z',
          webUrl: `${REPO}/-/merge_requests/7#note_21`,
        }],
      },
    ])

    const unresolved = await service.forge.mrDiscussions(REPO, 7, { onlyUnresolved: true })
    expect(unresolved.items.map(item => item.id)).toEqual(['disc-inline-open'])
  })

  it('submits GitLab MR reviews with diff_refs positions, detects headSha drift, downgrades self-reviews, and folds out-of-hunk lines into summary note', async () => {
    const baseSha = '1'.repeat(40)
    const startSha = '2'.repeat(40)
    let mrAuthor = 'contributor'
    let approveStatus = 201
    let discussionCall = 0
    const { requests } = fakeHttp([
      {
        method: 'GET',
        path: '/gitlab/api/v4/user',
        reply: { body: { id: 99, username: 'gl-bot', name: 'Bot', web_url: 'https://code.example.com/gitlab/gl-bot' } },
      },
      {
        method: 'GET',
        path: `${API}/merge_requests/7`,
        reply: () => ({
          body: mr({
            author: { username: mrAuthor, web_url: `https://code.example.com/gitlab/${mrAuthor}` },
            diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: SHA },
          }),
        }),
      },
      {
        method: 'POST',
        path: `${API}/merge_requests/7/discussions`,
        reply: (req) => {
          discussionCall += 1
          if (String(req.body).includes('999')) {
            return { status: 400, body: { message: '400 Bad request - Note {:line_code=>["can\'t be blank"]}' } }
          }
          return { status: 201, body: { id: `d-${discussionCall}`, notes: [{ id: 300 + discussionCall, body: 'inline', author, created_at: 'c' }] } }
        },
      },
      {
        method: 'POST',
        path: `${API}/merge_requests/7/approve`,
        reply: () => approveStatus === 201
          ? { status: 201, body: { id: 7 } }
          : { status: approveStatus, body: { message: 'Author cannot approve merge request' } },
      },
      {
        method: 'POST',
        path: `${API}/merge_requests/7/notes`,
        reply: { status: 201, body: { id: 501, body: 'summary', author, created_at: 'c' } },
      },
    ])
    const service = createService(testConfig(), TOKENS)

    // 1. Head SHA drift -> conflict.
    await expect(service.forge.reviewMr(REPO, 7, {
      headSha: 'c'.repeat(40),
      verdict: 'approve',
      body: 'LGTM',
    })).rejects.toMatchObject({ code: 'conflict' })

    // 2. Partial out-of-hunk fallback: 1 anchored inline comment + 1 out-of-hunk comment folded into summary note + approve.
    const partial = await service.forge.reviewMr(REPO, 7, {
      headSha: SHA,
      verdict: 'approve',
      body: 'Looks good overall',
      comments: [
        { path: 'src/order.ts', newLine: 18, body: 'Nice cleanup' },
        { path: 'src/order.ts', newLine: 999, body: 'Outside hunk remark' },
      ],
      signature: '_— gl-bot_',
    })
    expect(partial).toEqual({
      verdict: 'approve',
      postedComments: 1,
      fallbackInlineCount: 1,
      webUrl: `${REPO}/-/merge_requests/7#note_501`,
      ownCommentIds: ['301', '501'],
    })
    const multipart = String(requests.find(req => req.url.pathname.endsWith('/discussions'))?.body)
    expect(multipart).toContain('position[position_type]')
    expect(multipart).toContain(baseSha)
    expect(multipart).toContain(startSha)
    expect(multipart).toContain(SHA)
    expect(multipart).toContain('src/order.ts')
    const noteCall = requests.find(req => req.url.pathname.endsWith('/merge_requests/7/notes'))
    expect(noteCall?.body).toEqual({
      body: 'Looks good overall\n\n> **`src/order.ts:999`**\n> Outside hunk remark\n\n_— gl-bot_',
    })

    // 3. Proactive self-review downgrade when MR author matches gl-bot.
    mrAuthor = 'gl-bot'
    const selfProactive = await service.forge.reviewMr(REPO, 7, {
      headSha: SHA,
      verdict: 'request-changes',
      body: 'Self review findings',
    })
    expect(selfProactive).toMatchObject({ verdict: 'comment', downgradedVerdict: true, postedComments: 0, fallbackInlineCount: 0 })

    // 4. Reactive self-review downgrade when GitLab /approve returns 422.
    mrAuthor = 'alias-account'
    approveStatus = 422
    const selfReactive = await service.forge.reviewMr(REPO, 7, {
      headSha: SHA,
      verdict: 'approve',
      signature: '_— gl-bot_',
    })
    expect(selfReactive).toMatchObject({ verdict: 'comment', downgradedVerdict: true })
  })

  it('replies to and resolves/reopens GitLab discussion threads, and reads currentBotUser', async () => {
    const { requests } = fakeHttp([
      {
        method: 'GET',
        path: '/gitlab/api/v4/user',
        reply: { body: { id: 99, username: 'gl-bot', name: 'Bot', web_url: 'https://code.example.com/gitlab/gl-bot' } },
      },
      {
        method: 'POST',
        path: `${API}/merge_requests/7/discussions/disc-1/notes`,
        reply: { status: 201, body: { id: 88, body: 'Fixed!', author: { username: 'gl-bot', web_url: 'https://code.example.com/gitlab/gl-bot' }, created_at: '2026-11-13T12:00:00Z' } },
      },
      {
        method: 'PUT',
        path: `${API}/merge_requests/7/discussions/disc-1`,
        reply: req => ({
          body: {
            id: 'disc-1',
            notes: [{ id: 88, body: 'Fixed!', author, created_at: 'c', resolvable: true, resolved: req.url.searchParams.get('resolved') === 'true' }],
          },
        }),
      },
    ])
    const service = createService(testConfig(), TOKENS)

    expect(await service.forge.currentBotUser(REPO)).toEqual({ username: 'gl-bot', webUrl: 'https://code.example.com/gitlab/gl-bot' })

    const reply = await service.forge.replyMrDiscussion(REPO, 7, 'disc-1', 'Fixed!')
    expect(reply).toEqual({
      note: {
        id: '88',
        author: { username: 'gl-bot', webUrl: 'https://code.example.com/gitlab/gl-bot' },
        body: 'Fixed!',
        createdAt: '2026-11-13T12:00:00Z',
        webUrl: `${REPO}/-/merge_requests/7#note_88`,
      },
      ownCommentIds: ['88'],
    })
    expect(requests.find(req => req.method === 'POST')?.body).toEqual({ body: 'Fixed!' })

    expect(await service.forge.resolveMrDiscussion(REPO, 7, 'disc-1', true)).toEqual({ discussionId: 'disc-1', resolved: true })
    expect(await service.forge.resolveMrDiscussion(REPO, 7, 'disc-1', false)).toEqual({ discussionId: 'disc-1', resolved: false })
  })
})
