import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DshRepoService } from '../src/contract.ts'
import type { HostApproval, ToolDefinition, WorkingDirectoryService } from '../src/host.ts'
import { RepoError } from '../src/errors.ts'
import { createTools, toolOffered } from '../src/tools.ts'
import type { ToolDeps } from '../src/tools.ts'
import { testSettings } from './helpers.ts'

const agent = { id: 'agent-1' }
const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }

/** A service whose unlisted methods reject; listed ones are test doubles with loose return values. */
function fakeService(overrides: Record<string, unknown> = {}): DshRepoService {
  const notUsed = async () => { throw new Error('not used') }
  return new Proxy({} as DshRepoService, { get: (_target, key) => overrides[String(key)] ?? notUsed })
}

/** The tools the settings offer, by name. */
function tools(
  settings = testSettings(), service = fakeService(), approval?: HostApproval, workingDirectory?: WorkingDirectoryService,
  commitTrailers?: ToolDeps['commitTrailers'],
): Map<string, ToolDefinition> {
  return new Map(createTools({
    service, settings: () => settings.tools, approval: () => approval, workingDirectory: () => workingDirectory, ...commitTrailers === undefined ? {} : { commitTrailers },
  }).filter(tool => toolOffered(tool.access, settings.tools)).map(tool => [tool.definition.name, tool.definition]))
}

/** A Session rooted at a fresh directory whose effective directory starts at `sub`. */
function session(sub = '') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-tools-'))
  let current = join(root, sub)
  mkdirSync(current, { recursive: true })
  const set = vi.fn(async (_agent: unknown, path: string) => { current = path; return path })
  const workingDirectory: WorkingDirectoryService = { ensure: async () => current, set }
  const agent = { id: 'agent-1', session: { header: { id: 'session-1', cwd: root } } }
  return { root, set, workingDirectory, exec: { signal: new AbortController().signal, agent, callId: 'call-1' } }
}

/** A directory with a `.git` file, as a workspace checkout has. */
function checkout(dir: string): string {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, '.git'), 'gitdir: /mirrors/x/.git/worktrees/x\n')
  return dir
}

describe('createTools', () => {
  it('offers reads, writes, and merge according to the settings', () => {
    expect([...tools().keys()]).toEqual([
      'repo_info', 'repo_list_branches', 'repo_list_commits', 'repo_list_tree', 'repo_read_file',
      'repo_issue_list', 'repo_issue_get', 'repo_mr_list', 'repo_mr_get', 'repo_mr_diff', 'repo_mr_status',
      'repo_workspace_open', 'repo_workspace_changes',
      'repo_workspace_push', 'repo_issue_create', 'repo_issue_update', 'repo_issue_comment', 'repo_mr_create', 'repo_mr_update', 'repo_mr_comment',
    ])
    expect(tools(testSettings({ tools: { writes: 'off', merge: true } })).has('repo_issue_create')).toBe(false)
    expect(tools(testSettings({ tools: { writes: 'off' } })).has('repo_workspace_push')).toBe(false)
    expect(tools(testSettings({ tools: { merge: true } })).has('repo_mr_merge')).toBe(true)
    expect(tools(testSettings({ tools: { enabled: false } })).size).toBe(0)
  })

  it('follows settings saved after the tools were built', async () => {
    let settings = testSettings({ tools: { writes: 'allow', merge: true } })
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const mergeChange = vi.fn(async () => ({ merged: true }))
    const built = new Map(createTools({ service: fakeService({ createIssue, mergeChange }), settings: () => settings.tools, approval: () => undefined, workingDirectory: () => undefined })
      .map(tool => [tool.definition.name, tool.definition]))
    expect(await built.get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).toEqual({ number: 1 })
    settings = testSettings({ tools: { writes: 'allow' } })
    await expect(built.get('repo_mr_merge')!.execute({ repo: 'github.com/a/b', number: 1, headSha: 'a'.repeat(40) }, exec)).rejects.toThrow(/\[forbidden\].*合并/)
    settings = testSettings({ tools: { writes: 'off' } })
    await expect(built.get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).rejects.toThrow(/\[forbidden\].*关闭写操作/)
    expect(createIssue).toHaveBeenCalledTimes(1)
    expect(mergeChange).not.toHaveBeenCalled()
  })

  it('exposes JSON Schema parameters', () => {
    const parameters = tools().get('repo_mr_create')!.parameters
    expect(parameters).toMatchObject({ type: 'object', required: ['repo', 'title', 'sourceBranch'], additionalProperties: false })
    expect(parameters.$schema).toBeUndefined()
  })

  it('runs reads without approval and renders the value as JSON text', async () => {
    const repoInfo = vi.fn(async () => ({ defaultBranch: 'main' }))
    const tool = tools(testSettings(), fakeService({ repoInfo })).get('repo_info')!
    const value = await tool.execute({ repo: 'github.com/a/b' }, exec)
    expect(repoInfo).toHaveBeenCalledWith('github.com/a/b', { signal: exec.signal })
    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: '{\n  "defaultBranch": "main"\n}' }])
  })

  it('asks once before a write and returns declined without calling the host', async () => {
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const request = vi.fn(async () => 'rejected' as const)
    const tool = tools(testSettings(), fakeService({ createIssue }), { request }).get('repo_issue_create')!
    expect(await tool.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).toEqual({ status: 'declined', outcome: 'rejected' })
    expect(createIssue).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ agent, toolName: 'repo_issue_create', callId: 'call-1', reason: '在 github.com/a/b 创建 issue：Bug' }))
  })

  it('runs an approved write and appends the configured signature to bodies', async () => {
    const commentChange = vi.fn(async () => ({ id: '1' }))
    const tool = tools(testSettings({ tools: { signature: '_via DSH_' } }), fakeService({ commentChange }), { request: async () => 'allowed-once' }).get('repo_mr_comment')!
    expect(await tool.execute({ repo: 'github.com/a/b', number: 3, body: 'LGTM' }, exec)).toEqual({ id: '1' })
    expect(commentChange).toHaveBeenCalledWith('github.com/a/b', 3, 'LGTM\n\n_via DSH_', { signal: exec.signal })
  })

  it('skips approval in allow mode and refuses writes without an approval service in ask mode', async () => {
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const service = fakeService({ createIssue })
    await tools(testSettings({ tools: { writes: 'allow' } }), service).get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'x' }, exec)
    expect(createIssue).toHaveBeenCalledTimes(1)
    await expect(tools(testSettings(), service).get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'x' }, exec)).rejects.toThrow(/\[forbidden\].*审批服务/)
  })

  it('rejects invalid arguments and surfaces RepoError codes', async () => {
    const getIssue = vi.fn(async () => { throw new RepoError('not-found', '读取 issue #9 失败') })
    const tool = tools(testSettings(), fakeService({ getIssue })).get('repo_issue_get')!
    await expect(tool.execute({ repo: 'github.com/a/b', number: 0 }, exec)).rejects.toThrow(/^\[invalid\]/)
    await expect(tool.execute({ repo: 'github.com/a/b', number: 9 }, exec)).rejects.toThrow('[not-found] 读取 issue #9 失败')
  })

  it('opens a workspace under the current directory inside the Session root and moves the working directory there', async () => {
    const { root, set, workingDirectory, exec: run } = session('topics/t1')
    mkdirSync(join(root, 'topics/t1/app'))
    const openWorkspace = vi.fn(async (url: string, options: { dir: string }) => ({ url, dir: options.dir, baseBranch: 'main', baseCommit: 'c'.repeat(40) }))
    const service = fakeService({ resolve: () => ({ kind: 'gitlab', host: 'code.example.com', path: 'team/app', webUrl: 'https://code.example.com/gitlab/team/app' }), openWorkspace })
    const value = await tools(testSettings(), service, undefined, workingDirectory).get('repo_workspace_open')!.execute({ repo: 'git@code.example.com:team/app.git', commit: 'c'.repeat(40) }, run)
    const dir = join(root, 'topics/t1/app-2')
    expect(openWorkspace).toHaveBeenCalledWith('https://code.example.com/gitlab/team/app.git', { dir, commit: 'c'.repeat(40), signal: run.signal })
    expect(set).toHaveBeenCalledWith(run.agent, dir, run.signal)
    expect(value).toMatchObject({ dir, workingDirectory: dir })
  })

  it('opens beside a workspace instead of inside it, and at the Session root when the working directory is outside it', async () => {
    const { root, workingDirectory, exec: run } = session('topics/t1/app/src')
    const ws = checkout(join(root, 'topics/t1/app'))
    const gitDir = mkdtempSync(join(tmpdir(), 'dsh-repo-tools-gitdir-'))
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/dsh-repo/ws-0123456789abcdef\n')
    writeFileSync(join(ws, '.git'), `gitdir: ${gitDir}\n`)
    const openWorkspace = vi.fn(async (url: string, options: { dir: string }) => ({ url, dir: options.dir, baseBranch: 'main', baseCommit: 'c'.repeat(40) }))
    const service = fakeService({ resolve: () => ({ kind: 'github', host: 'github.com', path: 'a/lib', webUrl: 'https://github.com/a/lib' }), openWorkspace })
    await tools(testSettings(), service, undefined, workingDirectory).get('repo_workspace_open')!.execute({ repo: 'github.com/a/lib' }, run)
    expect(openWorkspace.mock.calls[0]?.[1].dir).toBe(join(root, 'topics/t1/lib'))

    const outside: WorkingDirectoryService = { ensure: async () => tmpdir(), set: async (_agent, path) => path }
    await tools(testSettings(), service, undefined, outside).get('repo_workspace_open')!.execute({ repo: 'github.com/a/lib' }, run)
    expect(openWorkspace.mock.calls[1]?.[1].dir).toBe(join(root, 'lib'))
  })

  it('finds the workspace from a directory inside it and asks before a push with the changed files', async () => {
    const { root, workingDirectory, exec: run } = session('ws/src')
    checkout(join(root, 'ws'))
    const changes = {
      workspace: { url: 'https://github.com/a/b.git', dir: join(root, 'ws'), baseBranch: 'main', baseCommit: 'c'.repeat(40) },
      commits: [], uncommitted: true, diff: '', truncated: false,
      files: [{ path: 'src/a.ts', status: 'modified', binary: false, additions: 3, deletions: 1 }, { path: 'logo.png', status: 'added', binary: true }],
    }
    const workspaceChanges = vi.fn(async () => changes)
    const pushWorkspace = vi.fn(async () => ({ url: 'https://github.com/a/b.git', branch: 'fix/a', baseBranch: 'main' }))
    const listChanges = vi.fn(async () => ({ items: [] }))
    const request = vi.fn(async (_request: { readonly reason?: string }) => 'allowed-once' as const)
    const service = fakeService({ workspaceChanges, pushWorkspace, listChanges })
    const all = tools(testSettings(), service, { request }, workingDirectory)
    expect(await all.get('repo_workspace_changes')!.execute({}, run)).toBe(changes)
    expect(workspaceChanges).toHaveBeenCalledWith(join(root, 'ws'), { signal: run.signal })
    expect(await all.get('repo_workspace_push')!.execute({ branch: 'fix/a', message: 'fix: a\n\nbody' }, run)).toEqual({
      url: 'https://github.com/a/b.git', branch: 'fix/a', baseBranch: 'main', openChanges: [],
      next: 'Open a PR/MR with repo_mr_create (sourceBranch fix/a, targetBranch main) if the work needs one.',
    })
    expect(listChanges).toHaveBeenCalledWith('https://github.com/a/b.git', { state: 'open', sourceBranch: 'fix/a', page: 1, perPage: 100, signal: run.signal })
    const reason = request.mock.calls[0]?.[0].reason ?? ''
    expect(reason.split('\n')).toEqual([
      '推送工作区改动到新分支 fix/a',
      '仓库：https://github.com/a/b.git',
      `起点：main @ ${'c'.repeat(12)}`,
      '提交说明：fix: a（另有 1 行正文）',
      '改动：2 个文件，+3 −1（相对起点）',
      '  修改 src/a.ts  +3 −1',
      '  新增 logo.png（二进制）',
    ])
    expect(pushWorkspace).toHaveBeenCalledWith(join(root, 'ws'), { branch: 'fix/a', message: 'fix: a\n\nbody', session: 'session-1', signal: run.signal })
    await expect(all.get('repo_workspace_changes')!.execute({ dir: tmpdir() }, run)).rejects.toThrow(/^\[not-found\]/)
  })

  it('lists the open PR/MR a later push updated, and reports a failed lookup without failing the push', async () => {
    const { root, workingDirectory, exec: run } = session('ws')
    checkout(join(root, 'ws'))
    const changes = {
      workspace: { url: 'https://github.com/a/b.git', dir: join(root, 'ws'), baseBranch: 'main', baseCommit: 'c'.repeat(40), branch: 'fix/a' },
      commits: [], uncommitted: true, diff: '', truncated: false, files: [],
    }
    const pushed = { url: 'https://github.com/a/b.git', branch: 'fix/a', baseBranch: 'main', commit: 'd'.repeat(40), committed: true, created: false }
    const change = { number: 7, title: 'Fix a', targetBranch: 'main', webUrl: 'https://github.com/a/b/pull/7', body: '', state: 'open' }
    const listChanges = vi.fn(async () => ({ items: [change] }))
    const service = fakeService({ workspaceChanges: async () => changes, pushWorkspace: async () => pushed, listChanges })
    const push = tools(testSettings(), service, { request: async () => 'allowed-once' }, workingDirectory).get('repo_workspace_push')!
    expect(await push.execute({ message: 'fix: more' }, run)).toEqual({
      ...pushed,
      openChanges: [{ number: 7, title: 'Fix a', targetBranch: 'main', webUrl: 'https://github.com/a/b/pull/7' }],
      next: 'PR/MR #7 from fix/a now includes this push; do not create another. Use repo_mr_update to change its title or description if needed.',
    })

    listChanges.mockRejectedValueOnce(new RepoError('forbidden', 'no access'))
    expect(await push.execute({ message: 'fix: more' }, run)).toEqual({
      ...pushed,
      next: 'Pushed. Could not list the PRs/MRs from fix/a (no access); check with repo_mr_list before creating one.',
    })
  })

  it('refuses to start new work from the source branch of an open PR/MR', async () => {
    const { workingDirectory, exec: run } = session()
    const openWorkspace = vi.fn()
    // The match is on the second page; the first came back empty after the host filtered it.
    const listChanges = vi.fn(async (_repo: string, options: { sourceBranch?: string; page?: number }) => options.page === 1
      ? { items: [], ...options.sourceBranch === 'fix/a' ? { nextPage: 2 } : {} }
      : { items: [{ number: 7 }] })
    const service = fakeService({ resolve: () => ({ kind: 'github', host: 'github.com', path: 'a/b', webUrl: 'https://github.com/a/b' }), openWorkspace, listChanges })
    const open = tools(testSettings(), service, undefined, workingDirectory).get('repo_workspace_open')!
    await expect(open.execute({ repo: 'github.com/a/b', baseBranch: 'fix/a' }, run)).rejects.toThrow(/^\[invalid\] fix\/a 是打开中的 PR\/MR #7 的源分支.*branch: fix\/a/)
    expect(listChanges).toHaveBeenCalledWith('github.com/a/b', { state: 'open', sourceBranch: 'fix/a', page: 2, perPage: 100, signal: run.signal })
    expect(openWorkspace).not.toHaveBeenCalled()

    openWorkspace.mockImplementation(async (url: string, options: { dir: string }) => ({ url, dir: options.dir, baseBranch: 'dev', baseCommit: 'c'.repeat(40) }))
    await open.execute({ repo: 'github.com/a/b', baseBranch: 'dev' }, run)
    expect(openWorkspace).toHaveBeenCalledTimes(1)
  })

  it('continues an existing branch, reusing the current workspace when it already pushes to that branch', async () => {
    const { root, set, workingDirectory, exec: run } = session('b/src')
    const ws = checkout(join(root, 'b'))
    const gitDir = mkdtempSync(join(tmpdir(), 'dsh-repo-tools-gitdir-'))
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/dsh-repo/ws-0123456789abcdef\n')
    writeFileSync(join(ws, '.git'), `gitdir: ${gitDir}\n`)
    const workspace = { url: 'https://github.com/a/b.git', dir: ws, baseBranch: 'main', baseCommit: 'c'.repeat(40), branch: 'fix/a' }
    const workspaceChanges = vi.fn(async () => ({ workspace }))
    const openWorkspace = vi.fn(async (url: string, options: { dir: string; branch?: string }) => ({ url, dir: options.dir, baseBranch: 'main', baseCommit: 'e'.repeat(40), branch: options.branch }))
    const listChanges = vi.fn()
    const service = fakeService({ resolve: () => ({ kind: 'github', host: 'github.com', path: 'a/b', webUrl: 'https://github.com/a/b' }), workspaceChanges, openWorkspace, listChanges })
    const open = tools(testSettings(), service, undefined, workingDirectory).get('repo_workspace_open')!

    const reused = await open.execute({ repo: 'github.com/a/b', branch: 'fix/a' }, run)
    expect(reused).toMatchObject({ ...workspace, reused: true, next: expect.stringContaining('repo_workspace_push without branch') })
    expect(workspaceChanges).toHaveBeenCalledWith(ws, { signal: run.signal })
    expect(openWorkspace).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()

    await expect(open.execute({ repo: 'github.com/a/b', branch: 'fix/a', commit: 'c'.repeat(40) }, run)).rejects.toThrow(/^\[invalid\].*commit/)
    expect(openWorkspace).not.toHaveBeenCalled()

    expect(await open.execute({ repo: 'github.com/a/b', branch: 'fix/a', baseBranch: 'main' }, run)).toMatchObject({ reused: true })
    expect(openWorkspace).not.toHaveBeenCalled()

    const fresh = await open.execute({ repo: 'github.com/a/b', branch: 'fix/b' }, run)
    const dir = join(root, 'b-2')
    expect(openWorkspace).toHaveBeenLastCalledWith('https://github.com/a/b.git', { dir, branch: 'fix/b', signal: run.signal })
    expect(fresh).toMatchObject({ dir, branch: 'fix/b', workingDirectory: dir, next: expect.stringContaining('added to fix/b') })
    expect(listChanges).not.toHaveBeenCalled()
  })

  it('opens a new workspace on a branch the current workspace pushes to when the merge target differs', async () => {
    const { root, workingDirectory, exec: run } = session('b')
    const ws = checkout(join(root, 'b'))
    const gitDir = mkdtempSync(join(tmpdir(), 'dsh-repo-tools-gitdir-'))
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/dsh-repo/ws-0123456789abcdef\n')
    writeFileSync(join(ws, '.git'), `gitdir: ${gitDir}\n`)
    const workspace = { url: 'https://github.com/a/b.git', dir: ws, baseBranch: 'main', baseCommit: 'c'.repeat(40), branch: 'fix/a' }
    const openWorkspace = vi.fn(async (url: string, options: { dir: string; branch?: string }) => ({ url, dir: options.dir, baseBranch: 'dev', baseCommit: 'e'.repeat(40), branch: options.branch }))
    const service = fakeService({ resolve: () => ({ kind: 'github', host: 'github.com', path: 'a/b', webUrl: 'https://github.com/a/b' }), workspaceChanges: async () => ({ workspace }), openWorkspace })
    const open = tools(testSettings(), service, undefined, workingDirectory).get('repo_workspace_open')!
    expect(await open.execute({ repo: 'github.com/a/b', branch: 'fix/a', baseBranch: 'dev' }, run)).toMatchObject({ baseBranch: 'dev', branch: 'fix/a' })
    expect(openWorkspace).toHaveBeenCalledWith('https://github.com/a/b.git', { dir: join(root, 'b-2'), baseBranch: 'dev', branch: 'fix/a', signal: run.signal })
  })

  it('adds the trailers other plugins contribute for the calling Session to the push', async () => {
    const { root, workingDirectory, exec: run } = session('ws')
    checkout(join(root, 'ws'))
    const changes = {
      workspace: { url: 'https://github.com/a/b.git', dir: join(root, 'ws'), baseBranch: 'main', baseCommit: 'c'.repeat(40) },
      commits: [], uncommitted: true, diff: '', truncated: false, files: [],
    }
    const pushWorkspace = vi.fn(async () => ({ url: 'https://github.com/a/b.git', branch: 'fix/a', baseBranch: 'main' }))
    const service = fakeService({ workspaceChanges: async () => changes, pushWorkspace, listChanges: async () => ({ items: [] }) })
    const request = async () => 'allowed-once' as const
    const commitTrailers = vi.fn(async () => [{ token: 'Feishu-User', value: '张三 <u_1>' }])
    const push = tools(testSettings(), service, { request }, workingDirectory, commitTrailers).get('repo_workspace_push')!
    await push.execute({ branch: 'fix/a', message: 'fix: a' }, run)
    expect(commitTrailers).toHaveBeenCalledWith({ session: 'session-1', dir: join(root, 'ws') })
    expect(pushWorkspace).toHaveBeenLastCalledWith(join(root, 'ws'), {
      branch: 'fix/a', message: 'fix: a', session: 'session-1', trailers: [{ token: 'Feishu-User', value: '张三 <u_1>' }], signal: run.signal,
    })

    // No Session, no event; no trailers, no option.
    await push.execute({ dir: join(root, 'ws'), branch: 'fix/a', message: 'fix: b' }, { ...run, agent: { id: 'agent-1' } })
    expect(commitTrailers).toHaveBeenCalledTimes(1)
    expect(pushWorkspace).toHaveBeenLastCalledWith(join(root, 'ws'), { branch: 'fix/a', message: 'fix: b', signal: run.signal })
    commitTrailers.mockResolvedValueOnce([])
    await push.execute({ branch: 'fix/a', message: 'fix: c' }, run)
    expect(pushWorkspace).toHaveBeenLastCalledWith(join(root, 'ws'), { branch: 'fix/a', message: 'fix: c', session: 'session-1', signal: run.signal })
  })
})
