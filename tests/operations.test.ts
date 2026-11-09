/**
 * The operation registry through both entry points: model tools
 * (`createTools`) and the `dshRepos` methods (`DshReposApi`), over an engine
 * double whose unlisted methods reject.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DshReposApi } from '../src/api.ts'
import type { CommitTrailersEvent, RepoAccess } from '../src/contract.ts'
import type { RepoSettings } from '../src/config.ts'
import { RepoError } from '../src/errors.ts'
import type { HostApproval, ToolDefinition, WorkingDirectoryService } from '../src/host.ts'
import { DeclinedError, OPERATIONS } from '../src/operations.ts'
import type { OperationDeps, WatchHooks } from '../src/operations.ts'
import type { RepoService } from '../src/service.ts'
import type { WatchInfo } from '../src/settings/contract.ts'
import { createTools, toolOffered } from '../src/tools.ts'
import type { WorkspaceManager } from '../src/workspace/manager.ts'
import type { WorkspaceRecord } from '../src/workspace/registry.ts'
import { testSettings } from './helpers.ts'

const plainAgent = { id: 'agent-1' }
const exec = { signal: new AbortController().signal, agent: plainAgent, callId: 'call-1' }

/** Catalog check of the double: `level` above `granted` is refused. */
function catalog(granted: RepoAccess = 'merge') {
  const order: RepoAccess[] = ['read', 'write', 'merge']
  return {
    require: vi.fn((target: string, level: RepoAccess) => {
      if (target.includes('unlisted')) throw new RepoError('not-allowed', `${target} 不在 dsh-repo 的仓库清单中`)
      if (order.indexOf(level) > order.indexOf(granted)) throw new RepoError('not-allowed', `${target} 在仓库清单中的权限是「${granted}」`)
      return { id: 'a'.repeat(12), url: target.startsWith('https://') ? target : `https://${target}`, access: granted, features: [] }
    }),
  }
}

/** An engine whose unlisted members reject; `settings` is read on every access. */
function fakeService(overrides: Record<string, unknown> = {}, settings: () => RepoSettings = () => testSettings(), granted: RepoAccess = 'merge'): RepoService {
  const notUsed = async () => { throw new Error('not used') }
  const base: Record<string, unknown> = { catalog: catalog(granted), gitHost: () => true, ...overrides }
  return new Proxy({} as RepoService, { get: (_target, key) => key === 'settings' ? settings() : base[String(key)] ?? notUsed })
}

function fakeWorkspaces(overrides: Record<string, unknown> = {}): WorkspaceManager {
  const notUsed = async () => { throw new Error('not used') }
  return new Proxy({} as WorkspaceManager, { get: (_target, key) => overrides[String(key)] ?? notUsed })
}

interface Options {
  readonly approval?: HostApproval
  readonly workingDirectory?: WorkingDirectoryService
  readonly parallel?: OperationDeps['parallel']
  readonly watch?: WatchHooks
  readonly workspaces?: WorkspaceManager
}

function deps(service: RepoService, options: Options = {}): OperationDeps {
  return {
    service,
    workspaces: options.workspaces ?? fakeWorkspaces(),
    approval: () => options.approval,
    workingDirectory: () => options.workingDirectory,
    ...options.parallel === undefined ? {} : { parallel: options.parallel },
    ...options.watch === undefined ? {} : { watch: options.watch },
  }
}

/** Every tool by name (offered or not). */
function tools(service: RepoService, options: Options = {}): Map<string, ToolDefinition> {
  return new Map(createTools(deps(service, options)).map(tool => [tool.definition.name, tool.definition]))
}

function api(service: RepoService, options: Options = {}): DshReposApi {
  return new DshReposApi({ ...deps(service, options), proxyPort: () => 1 })
}

/** A Session rooted at a fresh directory whose effective directory starts at `sub`. */
function session(sub = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-repo-ops-')))
  let current = join(root, sub)
  mkdirSync(current, { recursive: true })
  const set = vi.fn(async (_agent: unknown, path: string) => { current = path; return path })
  const workingDirectory: WorkingDirectoryService = { ensure: async () => current, set }
  const agent = { id: 'agent-1', session: { header: { id: 'session-1', cwd: root } } }
  return { root, set, workingDirectory, agent, exec: { signal: new AbortController().signal, agent, callId: 'call-1' } }
}

function record(path: string, fields: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return { id: '0123456789abcdef', path, repo: 'https://github.com/a/b', base: 'main', baseCommit: 'c'.repeat(40), branch: 'fix/a', secret: 'f'.repeat(48), createdAt: 't', ...fields }
}

describe('operation registry', () => {
  it('pairs every tool with a service method of the same name scheme', () => {
    expect(OPERATIONS).toHaveLength(34)
    for (const operation of OPERATIONS) {
      const words = operation.tool.replace(/^repo_/, '').split('_')
      const method = words.length === 1 ? `repo${words[0]![0]!.toUpperCase()}${words[0]!.slice(1)}` : words.map((word, index) => index === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`).join('')
      expect(operation.method).toBe(method)
      expect(typeof Reflect.get(DshReposApi.prototype, operation.method)).toBe('function')
    }
    expect(new Set(OPERATIONS.map(operation => operation.tool)).size).toBe(34)
  })

  it('offers tools by the settings and the highest catalog access', () => {
    const offered = (settings: RepoSettings, highest: RepoAccess | undefined) => OPERATIONS.filter(operation => toolOffered(operation.access, settings.tools, highest)).map(operation => operation.tool)
    expect(offered(testSettings(), 'merge')).toHaveLength(34)
    const read = offered(testSettings(), 'read')
    expect(read).toContain('repo_workspace_create')
    expect(read).toContain('repo_snapshot_acquire')
    expect(read).toContain('repo_add')
    expect(read).not.toContain('repo_workspace_push')
    expect(offered(testSettings(), 'write')).not.toContain('repo_mr_merge')
    expect(offered(testSettings({ tools: { writes: 'off' } }), 'merge').filter(tool => /push|create$|merge|delete|retry|cancel|update|comment|add$/.test(tool))).toEqual(['repo_workspace_create'])
    expect(offered(testSettings(), undefined)).toEqual(['repo_add'])
    expect(offered(testSettings({ tools: { enabled: false } }), 'merge')).toEqual([])
  })

  it('exposes JSON Schema parameters and renders values as JSON text', async () => {
    const all = tools(fakeService({ repoInfo: async () => ({ defaultBranch: 'main' }) }))
    const parameters = all.get('repo_mr_create')!.parameters
    expect(parameters).toMatchObject({ type: 'object', required: ['repo', 'title', 'sourceBranch'], additionalProperties: false })
    expect(parameters.$schema).toBeUndefined()
    const tool = all.get('repo_get')!
    const value = await tool.execute({ repo: 'github.com/a/b' }, exec)
    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: '{\n  "defaultBranch": "main"\n}' }])
    expect(all.get('repo_get')!.isConcurrencySafe?.({})).toBe(true)
    expect(all.get('repo_issue_create')!.isConcurrencySafe?.({})).toBe(false)
    expect(all.get('repo_workspace_create')!.isConcurrencySafe?.({})).toBe(false)
  })

  it('rejects invalid arguments and surfaces RepoError codes', async () => {
    const getIssue = vi.fn(async () => { throw new RepoError('not-found', '读取 issue #9 失败') })
    const tool = tools(fakeService({ getIssue })).get('repo_issue_get')!
    await expect(tool.execute({ repo: 'github.com/a/b', number: 0 }, exec)).rejects.toThrow(/^\[invalid\] repo_issue_get 参数不合法/)
    await expect(tool.execute({ repo: 'github.com/a/b', number: 1, extra: true }, exec)).rejects.toThrow(/^\[invalid\]/)
    await expect(tool.execute({ repo: 'github.com/a/b', number: 9 }, exec)).rejects.toThrow('[not-found] 读取 issue #9 失败')
  })
})

describe('write gate for tools', () => {
  it('checks catalog access, then asks access/authorize for the Session, then the user', async () => {
    const order: string[] = []
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const request = vi.fn(async () => { order.push('approve'); return 'allowed-once' as const })
    const parallel = vi.fn(async (name: string) => { order.push(name) })
    const { exec: run } = session()
    const all = tools(fakeService({ createIssue, mergeChange: vi.fn() }, () => testSettings(), 'write'), { approval: { request }, parallel })
    expect(await all.get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'T' }, run)).toEqual({ number: 1 })
    expect(parallel).toHaveBeenCalledWith('access/authorize', { session: 'session-1', level: 'code-write', action: 'issueCreate', summary: '在 github.com/a/b 创建 issue：T' })
    expect(order).toEqual(['access/authorize', 'approve'])
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ agent: run.agent, toolName: 'repo_issue_create', callId: 'call-1', reason: '在 github.com/a/b 创建 issue：T', displayReason: { zh: '在 github.com/a/b 创建 issue：T', en: 'Create an issue in github.com/a/b: T' } }))
    await expect(all.get('repo_mr_merge')!.execute({ repo: 'github.com/a/b', number: 1, headSha: 'a'.repeat(40) }, run)).rejects.toThrow(/\[not-allowed\].*write/)
    await expect(all.get('repo_issue_create')!.execute({ repo: 'github.com/unlisted/x', title: 'T' }, run)).rejects.toThrow(/\[not-allowed\]/)
    expect(request).toHaveBeenCalledTimes(1)

    parallel.mockRejectedValueOnce(new AggregateError([new Error('发起人没有改代码权限')]))
    await expect(all.get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'U' }, run)).rejects.toThrow('[forbidden] issueCreate 未获授权，没有执行：发起人没有改代码权限')
    expect(request).toHaveBeenCalledTimes(1)
    expect(createIssue).toHaveBeenCalledTimes(1)
  })

  it('returns declined without running, follows settings saved later, and needs an approval service in ask mode', async () => {
    let settings = testSettings()
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const request = vi.fn(async () => 'rejected' as const)
    const service = fakeService({ createIssue }, () => settings)
    const create = tools(service, { approval: { request } }).get('repo_issue_create')!
    expect(await create.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).toEqual({ status: 'declined', outcome: 'rejected' })
    expect(createIssue).not.toHaveBeenCalled()
    settings = testSettings({ tools: { writes: 'allow' } })
    expect(await create.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).toEqual({ number: 1 })
    expect(request).toHaveBeenCalledTimes(1)
    settings = testSettings({ tools: { writes: 'off' } })
    await expect(create.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).rejects.toThrow(/\[forbidden\].*关闭写操作/)
    settings = testSettings()
    await expect(tools(service).get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'x' }, exec)).rejects.toThrow(/\[forbidden\].*审批服务/)
    expect(createIssue).toHaveBeenCalledTimes(1)
  })

  it('applies the signature and the source-branch setting, and names CI runs and jobs in approvals', async () => {
    let settings = testSettings({ tools: { signature: '_via DSH_' } })
    const createChange = vi.fn(async () => ({ number: 1, state: 'open' }))
    const mergeChange = vi.fn(async () => ({ sha: 'm1' }))
    const commentChange = vi.fn(async () => ({ id: '1' }))
    const retryCi = vi.fn(async () => ({ runId: 42 }))
    const cancelCi = vi.fn(async () => ({ jobId: 2 }))
    const getCiRun = vi.fn(async () => ({ id: 42 }))
    const request = vi.fn(async (_request: { readonly reason?: string }) => 'allowed-once' as const)
    const all = tools(fakeService({ createChange, mergeChange, commentChange, retryCi, cancelCi, getCiRun }, () => settings), { approval: { request } })
    await all.get('repo_mr_comment')!.execute({ repo: 'github.com/a/b', number: 3, body: 'LGTM' }, exec)
    expect(commentChange).toHaveBeenCalledWith('github.com/a/b', 3, 'LGTM\n\n_via DSH_', { signal: exec.signal })
    await all.get('repo_mr_create')!.execute({ repo: 'github.com/a/b', title: 'T', sourceBranch: 'f', body: 'B' }, exec)
    expect(createChange).toHaveBeenLastCalledWith('github.com/a/b', expect.objectContaining({ body: 'B\n\n_via DSH_', deleteSourceBranch: true }))
    await all.get('repo_mr_merge')!.execute({ repo: 'github.com/a/b', number: 1, headSha: 'a'.repeat(40) }, exec)
    expect(request.mock.calls.at(-1)?.[0].reason).toContain('合并后删除源分支')
    settings = testSettings({ tools: { deleteSourceBranch: false } })
    await all.get('repo_mr_merge')!.execute({ repo: 'github.com/a/b', number: 1, headSha: 'a'.repeat(40), method: 'squash' }, exec)
    expect(mergeChange).toHaveBeenLastCalledWith('github.com/a/b', 1, { headSha: 'a'.repeat(40), method: 'squash', deleteSourceBranch: false, signal: exec.signal })

    request.mockClear()
    await all.get('repo_ci_get')!.execute({ repo: 'gitlab.example.com/g/p', runId: 42, onlyFailed: true }, exec)
    expect(getCiRun).toHaveBeenCalledWith('gitlab.example.com/g/p', 42, { onlyFailed: true, signal: exec.signal })
    expect(request).not.toHaveBeenCalled()
    await all.get('repo_ci_retry')!.execute({ repo: 'gitlab.example.com/g/p', runId: 42 }, exec)
    expect(retryCi).toHaveBeenCalledWith('gitlab.example.com/g/p', { runId: 42 }, { signal: exec.signal })
    expect(request.mock.calls.at(-1)?.[0].reason).toBe('重试 CI 流水线的失败作业\n仓库：gitlab.example.com/g/p\n流水线：42')
    await all.get('repo_ci_cancel')!.execute({ repo: 'gitlab.example.com/g/p', jobId: 2 }, exec)
    expect(cancelCi).toHaveBeenCalledWith('gitlab.example.com/g/p', { jobId: 2 }, { signal: exec.signal })
    expect(request.mock.calls.at(-1)?.[0].reason).toBe('取消 CI 作业\n仓库：gitlab.example.com/g/p\n作业：2')
    await expect(all.get('repo_ci_retry')!.execute({ repo: 'gitlab.example.com/g/p', runId: 42, jobId: 2 }, exec)).rejects.toThrow(/\[invalid\].*runId and jobId/)
  })

  it('adds a repository to the catalog through the gate with the catalog summary', async () => {
    const addRepo = vi.fn(async (_url: string, _options: unknown, confirm: (summary: string) => Promise<void>) => {
      await confirm('把 github.com/a/b 加入 dsh-repo 仓库清单（权限：只读）')
      return { status: 'added' }
    })
    const parallel = vi.fn(async () => {})
    const request = vi.fn(async () => 'allowed-once' as const)
    const { exec: run } = session()
    expect(await tools(fakeService({ addRepo }), { approval: { request }, parallel }).get('repo_add')!.execute({ repo: 'https://github.com/a/b' }, run)).toEqual({ status: 'added' })
    expect(parallel).toHaveBeenCalledWith('access/authorize', { session: 'session-1', level: 'admin', action: 'repoAdd', summary: '把 github.com/a/b 加入 dsh-repo 仓库清单（权限：只读）' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'repo_add', displayReason: { zh: '把 github.com/a/b 加入 dsh-repo 仓库清单（权限：只读）', en: 'Change the dsh-repo repository catalog: https://github.com/a/b' } }))
  })
})

describe('service calls', () => {
  it('run the same operation; without an agent only the catalog is checked', async () => {
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const request = vi.fn(async () => 'allowed-once' as const)
    const parallel = vi.fn(async () => {})
    const service = fakeService({ createIssue }, () => testSettings({ tools: { writes: 'off' } }), 'write')
    const repos = api(service, { approval: { request }, parallel })
    expect(await repos.issueCreate({ repo: 'github.com/a/b', title: 'T', signal: exec.signal })).toEqual({ number: 1 })
    expect(request).not.toHaveBeenCalled()
    expect(parallel).not.toHaveBeenCalled()
    await expect(repos.issueCreate({ repo: 'github.com/unlisted/x', title: 'T' })).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(repos.mrMerge({ repo: 'github.com/a/b', number: 1, headSha: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(repos.issueCreate({ repo: 'github.com/a/b' } as never)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('issueCreate 参数不合法') })
  })

  it('gate a write made for an agent like the tool, throwing declined', async () => {
    let settings = testSettings()
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const request = vi.fn(async () => 'rejected' as const)
    const parallel = vi.fn(async () => {})
    const { agent } = session()
    const repos = api(fakeService({ createIssue }, () => settings), { approval: { request }, parallel })
    const failure = await repos.issueCreate({ repo: 'github.com/a/b', title: 'T', agent, callId: 'c9' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DeclinedError)
    expect(failure).toMatchObject({ code: 'declined', outcome: 'rejected' })
    expect(parallel).toHaveBeenCalledWith('access/authorize', expect.objectContaining({ session: 'session-1', action: 'issueCreate' }))
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ agent, toolName: 'repo_issue_create', callId: 'c9' }))
    settings = testSettings({ tools: { writes: 'off' } })
    await expect(repos.issueCreate({ repo: 'github.com/a/b', title: 'T', agent })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('issueCreate') })
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('classify unexpected failures and hand snapshot leases back with their release', async () => {
    const release = vi.fn()
    const service = fakeService({
      repoInfo: async () => { throw new Error('boom') },
      syncMirror: async () => ({ commit: 'c'.repeat(40) }),
      mirrors: { acquire: async () => ({ commit: 'c'.repeat(40), dir: '/snap', release }), resolveRef: async () => 'd'.repeat(40) },
    })
    const repos = api(service)
    await expect(repos.repoGet({ repo: 'github.com/a/b' })).rejects.toMatchObject({ name: 'RepoError', code: 'unavailable' })
    const lease = await repos.snapshotAcquire({ repo: 'github.com/a/b' })
    expect(lease).toEqual({ repo: 'https://github.com/a/b', commit: 'c'.repeat(40), path: '/snap', release })
    const viaTool = await tools(service).get('repo_snapshot_acquire')!.execute({ repo: 'github.com/a/b', ref: 'v1' }, exec)
    expect(viaTool).toEqual({ repo: 'https://github.com/a/b', commit: 'c'.repeat(40), path: '/snap' })
    // The tool's lease for this Session and repository is replaced by the next one.
    await tools(service).get('repo_snapshot_acquire')!.execute({ repo: 'github.com/a/b' }, exec)
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('workspace operations', () => {
  it('create a workspace under the working directory inside the Session root and move the working directory there', async () => {
    const { root, set, workingDirectory, exec: run } = session('topics/t1')
    mkdirSync(join(root, 'topics/t1/b'))
    const create = vi.fn(async (request: { path: string; branch?: string }) => ({ id: '0123456789abcdef', repo: 'https://github.com/a/b', path: request.path, base: 'main', baseCommit: 'c'.repeat(40), branch: request.branch ?? 'dsh/session1', session: 'session-1', createdAt: 't' }))
    const workspaces = fakeWorkspaces({ create })
    const tool = tools(fakeService(), { workingDirectory, workspaces }).get('repo_workspace_create')!
    const value = await tool.execute({ repo: 'github.com/a/b', commit: 'c'.repeat(40) }, run)
    const path = join(root, 'topics/t1/b-2')
    expect(create).toHaveBeenCalledWith({ repo: 'https://github.com/a/b', path, commit: 'c'.repeat(40), session: 'session-1' }, run.signal)
    expect(set).toHaveBeenCalledWith(run.agent, path, run.signal)
    expect(value).toMatchObject({ path, workingDirectory: path, next: expect.stringContaining('repo_workspace_push') })
    await tool.execute({ repo: 'github.com/a/b', path: 'sub', branch: 'fix/x' }, run)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ path: join(path, 'sub'), branch: 'fix/x' }), run.signal)
    await expect(tool.execute({ repo: 'github.com/a/b', path: tmpdir() }, run)).rejects.toThrow(/^\[invalid\].*会话目录/)

    const outside: WorkingDirectoryService = { ensure: async () => tmpdir(), set: async (_agent, target) => target }
    await tools(fakeService(), { workingDirectory: outside, workspaces }).get('repo_workspace_create')!.execute({ repo: 'github.com/a/b' }, run)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ path: join(root, 'b') }), run.signal)

    const repos = api(fakeService(), { workspaces })
    expect(await repos.workspaceCreate({ repo: 'github.com/a/b', path: '/srv/ws/b' })).not.toHaveProperty('next')
  })

  it('list a Session\'s workspaces for a tool and every workspace for a service call, and refuse removing another Session\'s', async () => {
    const { root, exec: run } = session()
    const mine = record(join(root, 'ws'), { session: 'session-1' })
    const created = record('/elsewhere/ws', { id: '1123456789abcdef', session: 'session-1' })
    const other = record('/elsewhere/other', { id: '2123456789abcdef', session: 'session-2' })
    const remove = vi.fn(async () => ({ discardedCommits: 0, discardedChanges: false }))
    const workspaces = fakeWorkspaces({ list: async () => [mine, created, other], locate: async (path: string) => [mine, created, other].find(entry => entry.path === path), remove })
    const all = tools(fakeService(), { workspaces })
    const listed = await all.get('repo_workspace_list')!.execute({}, run) as { path: string }[]
    expect(listed.map(entry => entry.path)).toEqual([mine.path, created.path])
    expect(listed[0]).not.toHaveProperty('secret')
    expect(await api(fakeService(), { workspaces }).workspaceList()).toHaveLength(3)
    await expect(all.get('repo_workspace_remove')!.execute({ path: other.path }, run)).rejects.toThrow(/^\[forbidden\]/)
    expect(await all.get('repo_workspace_remove')!.execute({ path: created.path, force: true }, run)).toEqual({ path: created.path, discardedCommits: 0, discardedChanges: false })
    expect(remove).toHaveBeenCalledWith(created, true, run.signal, expect.any(Number))
  })

  it('push after an approval that lists the changes, then open a PR/MR and watch it for the Session', async () => {
    const { root, workingDirectory, exec: run } = session('ws/src')
    const ws = record(join(root, 'ws'), { session: 'session-1' })
    const status = {
      workspace: { ...ws, secret: undefined }, head: 'h', commits: [], unpushed: 0, uncommitted: true, diff: '', truncated: false,
      files: [{ path: 'src/a.ts', status: 'modified', binary: false, additions: 3, deletions: 1 }],
    }
    const push = vi.fn(async () => ({ commit: 'd'.repeat(40), committed: true, author: { name: 'bot', email: 'bot@example.com' }, created: true }))
    const workspaces = fakeWorkspaces({ locate: async (path: string) => { expect(path).toBe(join(root, 'ws/src')); return ws }, status: async () => status, push })
    const mr = { number: 7, title: 'Fix a', targetBranch: 'main', webUrl: 'https://github.com/a/b/pull/7', state: 'open' }
    const listChanges = vi.fn(async () => ({ items: [] }))
    const createChange = vi.fn(async () => mr)
    const service = fakeService({
      listChanges, createChange,
      tokenIdentity: async () => ({ name: 'bot', email: 'bot@example.com' }),
      mirrors: { resolveRef: async () => { throw new RepoError('not-found', 'no branch') } },
    })
    const request = vi.fn(async (_request: { readonly reason?: string }) => 'allowed-once' as const)
    const parallel = vi.fn(async (name: string, ...args: unknown[]) => {
      if (name === 'repo/commit-trailers') (args[0] as CommitTrailersEvent).add('Feishu-User', '张三 <u_1>')
    })
    const track = vi.fn(async () => ({}) as WatchInfo)
    const watch = { active: true, track, untrack: vi.fn(async () => true), ownComment: vi.fn(async () => {}) }
    const result = await tools(service, { approval: { request }, workingDirectory, workspaces, parallel, watch }).get('repo_workspace_push')!.execute({ message: 'fix: a\n\nbody', mr: { title: 'Fix a' } }, run)
    expect(request.mock.calls[0]?.[0].reason?.split('\n')).toEqual([
      '推送工作区到新分支 fix/a',
      '仓库：https://github.com/a/b',
      `起点：main @ ${'c'.repeat(12)}`,
      '提交说明：fix: a（另有 1 行正文）',
      '没有打开中的 PR/MR 时创建PR/MR：fix/a → main，标题：Fix a',
      '改动：1 个文件，+3 −1（相对起点）',
      '  修改 src/a.ts  +3 −1',
    ])
    expect(parallel).toHaveBeenCalledWith('access/authorize', expect.objectContaining({ session: 'session-1', action: 'workspacePush' }))
    expect(push).toHaveBeenCalledWith(ws, expect.objectContaining({ message: 'fix: a\n\nbody', session: 'session-1', committer: { name: 'bot', email: 'bot@example.com' }, trailers: [{ token: 'Feishu-User', value: '张三 <u_1>' }] }), expect.any(Number))
    expect(createChange).toHaveBeenCalledWith('https://github.com/a/b', expect.objectContaining({ title: 'Fix a', sourceBranch: 'fix/a', targetBranch: 'main', draft: false }))
    expect(result).toEqual({
      repo: 'https://github.com/a/b', path: ws.path, branch: 'fix/a', base: 'main',
      commit: 'd'.repeat(40), committed: true, author: { name: 'bot', email: 'bot@example.com' }, created: true,
      openMrs: [{ number: 7, title: 'Fix a', targetBranch: 'main', webUrl: mr.webUrl }],
      createdMr: { number: 7, title: 'Fix a', targetBranch: 'main', webUrl: mr.webUrl },
      watching: true,
    })
    expect(track).toHaveBeenCalledWith({ repo: 'https://github.com/a/b', change: mr, session: 'session-1', source: 'created', pushed: 'd'.repeat(40) })

    // A failed PR/MR lookup is reported; the push already happened.
    listChanges.mockRejectedValueOnce(new RepoError('forbidden', 'no access'))
    expect(await tools(service, { approval: { request }, workingDirectory, workspaces }).get('repo_workspace_push')!.execute({ message: 'fix: b' }, run)).toMatchObject({ openMrs: [], watching: false, mrError: 'no access' })
  })
})

describe('PR/MR watching', () => {
  it('watches requests opened or reopened for the calling Session, and remembers comments it posts', async () => {
    const { exec: run } = session()
    const mr = { number: 7, title: 'Fix a', targetBranch: 'main', webUrl: 'https://github.com/a/b/pull/7', state: 'open' }
    const service = fakeService({ createChange: async () => mr, updateChange: async () => mr, commentChange: async () => ({ id: '55' }), commentIssue: async () => ({ id: '56' }) }, () => testSettings({ tools: { writes: 'allow' } }))
    const track = vi.fn(async () => ({}) as WatchInfo)
    const ownComment = vi.fn(async () => {})
    const watch = { active: true, track, untrack: vi.fn(async () => true), ownComment }
    const all = tools(service, { watch })
    expect(await all.get('repo_mr_create')!.execute({ repo: 'github.com/a/b', title: 'Fix a', sourceBranch: 'fix/a' }, run)).toMatchObject({ number: 7, watching: true })
    expect(track).toHaveBeenLastCalledWith({ repo: 'github.com/a/b', change: mr, session: 'session-1', source: 'created' })
    expect(await all.get('repo_mr_update')!.execute({ repo: 'github.com/a/b', number: 7, state: 'open' }, run)).toMatchObject({ watching: true })
    expect(await all.get('repo_mr_update')!.execute({ repo: 'github.com/a/b', number: 7, title: 'T' }, run)).not.toHaveProperty('watching')
    await all.get('repo_mr_comment')!.execute({ repo: 'github.com/a/b', number: 7, body: 'done' }, run)
    await all.get('repo_issue_comment')!.execute({ repo: 'github.com/a/b', number: 7, body: 'done' }, run)
    expect(ownComment.mock.calls).toEqual([['github.com/a/b', 7, '55'], ['github.com/a/b', 7, '56']])
    track.mockRejectedValueOnce(new Error('disk full'))
    expect(await all.get('repo_mr_create')!.execute({ repo: 'github.com/a/b', title: 'Fix a', sourceBranch: 'fix/a' }, run)).toMatchObject({ watching: false, watchError: 'disk full' })
    watch.active = false
    expect(await all.get('repo_mr_create')!.execute({ repo: 'github.com/a/b', title: 'Fix a', sourceBranch: 'fix/a' }, run)).toMatchObject({ watching: false })
    expect(await all.get('repo_mr_create')!.execute({ repo: 'github.com/a/b', title: 'Fix a', sourceBranch: 'fix/a' }, exec)).toMatchObject({ watching: false })
  })

  it('starts and stops a watch on request, only for open requests while watching is active', async () => {
    const { exec: run } = session()
    const getChange = vi.fn(async () => ({ number: 7, title: 'Fix a', state: 'open', webUrl: 'https://github.com/a/b/pull/7', comments: [{ id: '1' }] }))
    const track = vi.fn(async () => ({ number: 7, title: 'Fix a', webUrl: 'https://github.com/a/b/pull/7' }) as WatchInfo)
    const watch = { active: true, track, untrack: vi.fn(async () => true), ownComment: vi.fn(async () => {}) }
    const tool = tools(fakeService({ getChange }), { watch }).get('repo_mr_watch')!
    expect(await tool.execute({ repo: 'github.com/a/b', number: 7 }, run)).toEqual({ watching: true, number: 7, title: 'Fix a', webUrl: 'https://github.com/a/b/pull/7' })
    expect(track).toHaveBeenCalledWith({ repo: 'github.com/a/b', change: { number: 7, title: 'Fix a', state: 'open', webUrl: 'https://github.com/a/b/pull/7' }, session: 'session-1', source: 'requested' })
    expect(await tool.execute({ repo: 'github.com/a/b', number: 7, watch: false }, run)).toEqual({ watching: false, stopped: true, number: 7 })
    expect(watch.untrack).toHaveBeenCalledWith('github.com/a/b', 7, 'session-1')
    getChange.mockResolvedValueOnce({ number: 7, title: 'Fix a', state: 'merged', webUrl: '', comments: [] })
    await expect(tool.execute({ repo: 'github.com/a/b', number: 7 }, run)).rejects.toThrow(/\[invalid\].*已合并/)
    await expect(tool.execute({ repo: 'github.com/a/b', number: 7 }, exec)).rejects.toThrow(/\[invalid\].*会话/)
    watch.active = false
    await expect(tool.execute({ repo: 'github.com/a/b', number: 7 }, run)).rejects.toThrow(/\[unavailable\]/)
  })
})
