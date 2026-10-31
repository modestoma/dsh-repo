import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DshRepoService } from '../src/contract.ts'
import type { HostApproval, ToolDefinition, WorkingDirectoryService } from '../src/host.ts'
import { RepoError } from '../src/errors.ts'
import { createTools } from '../src/tools.ts'
import { testConfig } from './helpers.ts'

const agent = { id: 'agent-1' }
const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }

/** A service whose unlisted methods reject; listed ones are test doubles with loose return values. */
function fakeService(overrides: Record<string, unknown> = {}): DshRepoService {
  const notUsed = async () => { throw new Error('not used') }
  return new Proxy({} as DshRepoService, { get: (_target, key) => overrides[String(key)] ?? notUsed })
}

function tools(config = testConfig(), service = fakeService(), approval?: HostApproval, workingDirectory?: WorkingDirectoryService): Map<string, ToolDefinition> {
  return new Map(createTools({ service, config, approval: () => approval, workingDirectory: () => workingDirectory }).map(tool => [tool.name, tool]))
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
  it('registers reads, writes, and merge according to the configuration', () => {
    expect([...tools().keys()]).toEqual([
      'repo_info', 'repo_list_branches', 'repo_list_commits', 'repo_list_tree', 'repo_read_file',
      'repo_issue_list', 'repo_issue_get', 'repo_mr_list', 'repo_mr_get', 'repo_mr_diff', 'repo_mr_status',
      'repo_workspace_open', 'repo_workspace_changes',
      'repo_workspace_push', 'repo_issue_create', 'repo_issue_update', 'repo_issue_comment', 'repo_mr_create', 'repo_mr_update', 'repo_mr_comment',
    ])
    expect(tools(testConfig({ tools: { writes: 'off', merge: true } })).has('repo_issue_create')).toBe(false)
    expect(tools(testConfig({ tools: { writes: 'off' } })).has('repo_workspace_push')).toBe(false)
    expect(tools(testConfig({ tools: { merge: true } })).has('repo_mr_merge')).toBe(true)
  })

  it('exposes JSON Schema parameters', () => {
    const parameters = tools().get('repo_mr_create')!.parameters
    expect(parameters).toMatchObject({ type: 'object', required: ['repo', 'title', 'sourceBranch'], additionalProperties: false })
    expect(parameters.$schema).toBeUndefined()
  })

  it('runs reads without approval and renders the value as JSON text', async () => {
    const repoInfo = vi.fn(async () => ({ defaultBranch: 'main' }))
    const tool = tools(testConfig(), fakeService({ repoInfo })).get('repo_info')!
    const value = await tool.execute({ repo: 'github.com/a/b' }, exec)
    expect(repoInfo).toHaveBeenCalledWith('github.com/a/b', { signal: exec.signal })
    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: '{\n  "defaultBranch": "main"\n}' }])
  })

  it('asks once before a write and returns declined without calling the host', async () => {
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const request = vi.fn(async () => 'rejected' as const)
    const tool = tools(testConfig(), fakeService({ createIssue }), { request }).get('repo_issue_create')!
    expect(await tool.execute({ repo: 'github.com/a/b', title: 'Bug' }, exec)).toEqual({ status: 'declined', outcome: 'rejected' })
    expect(createIssue).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ agent, toolName: 'repo_issue_create', callId: 'call-1', reason: '在 github.com/a/b 创建 issue：Bug' }))
  })

  it('runs an approved write and appends the configured signature to bodies', async () => {
    const commentChange = vi.fn(async () => ({ id: '1' }))
    const tool = tools(testConfig({ tools: { signature: '_via DSH_' } }), fakeService({ commentChange }), { request: async () => 'allowed-once' }).get('repo_mr_comment')!
    expect(await tool.execute({ repo: 'github.com/a/b', number: 3, body: 'LGTM' }, exec)).toEqual({ id: '1' })
    expect(commentChange).toHaveBeenCalledWith('github.com/a/b', 3, 'LGTM\n\n_via DSH_', { signal: exec.signal })
  })

  it('skips approval in allow mode and refuses writes without an approval service in ask mode', async () => {
    const createIssue = vi.fn(async () => ({ number: 1 }))
    const service = fakeService({ createIssue })
    await tools(testConfig({ tools: { writes: 'allow' } }), service).get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'x' }, exec)
    expect(createIssue).toHaveBeenCalledTimes(1)
    await expect(tools(testConfig(), service).get('repo_issue_create')!.execute({ repo: 'github.com/a/b', title: 'x' }, exec)).rejects.toThrow(/\[forbidden\].*审批服务/)
  })

  it('rejects invalid arguments and surfaces RepoError codes', async () => {
    const getIssue = vi.fn(async () => { throw new RepoError('not-found', '读取 issue #9 失败') })
    const tool = tools(testConfig(), fakeService({ getIssue })).get('repo_issue_get')!
    await expect(tool.execute({ repo: 'github.com/a/b', number: 0 }, exec)).rejects.toThrow(/^\[invalid\]/)
    await expect(tool.execute({ repo: 'github.com/a/b', number: 9 }, exec)).rejects.toThrow('[not-found] 读取 issue #9 失败')
  })

  it('opens a workspace under the current directory inside the Session root and moves the working directory there', async () => {
    const { root, set, workingDirectory, exec: run } = session('topics/t1')
    mkdirSync(join(root, 'topics/t1/app'))
    const openWorkspace = vi.fn(async (url: string, options: { dir: string }) => ({ url, dir: options.dir, baseBranch: 'main', baseCommit: 'c'.repeat(40) }))
    const service = fakeService({ resolve: () => ({ kind: 'gitlab', host: 'code.example.com', path: 'team/app', webUrl: 'https://code.example.com/gitlab/team/app' }), openWorkspace })
    const value = await tools(testConfig(), service, undefined, workingDirectory).get('repo_workspace_open')!.execute({ repo: 'git@code.example.com:team/app.git', commit: 'c'.repeat(40) }, run)
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
    await tools(testConfig(), service, undefined, workingDirectory).get('repo_workspace_open')!.execute({ repo: 'github.com/a/lib' }, run)
    expect(openWorkspace.mock.calls[0]?.[1].dir).toBe(join(root, 'topics/t1/lib'))

    const outside: WorkingDirectoryService = { ensure: async () => tmpdir(), set: async (_agent, path) => path }
    await tools(testConfig(), service, undefined, outside).get('repo_workspace_open')!.execute({ repo: 'github.com/a/lib' }, run)
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
    const pushWorkspace = vi.fn(async () => ({ branch: 'fix/a' }))
    const request = vi.fn(async (_request: { readonly reason?: string }) => 'allowed-once' as const)
    const service = fakeService({ workspaceChanges, pushWorkspace })
    const all = tools(testConfig(), service, { request }, workingDirectory)
    expect(await all.get('repo_workspace_changes')!.execute({}, run)).toBe(changes)
    expect(workspaceChanges).toHaveBeenCalledWith(join(root, 'ws'), { signal: run.signal })
    expect(await all.get('repo_workspace_push')!.execute({ branch: 'fix/a', message: 'fix: a\n\nbody' }, run)).toEqual({ branch: 'fix/a' })
    const reason = request.mock.calls[0]?.[0].reason ?? ''
    expect(reason).toContain('推送到分支 fix/a（起点 main')
    expect(reason).toContain('2 个文件，+3 −1')
    expect(reason).toContain('提交说明：fix: a')
    expect(reason).toContain('src/a.ts +3 −1')
    expect(reason).toContain('logo.png（二进制）')
    expect(pushWorkspace).toHaveBeenCalledWith(join(root, 'ws'), { branch: 'fix/a', message: 'fix: a\n\nbody', session: 'session-1', signal: run.signal })
    await expect(all.get('repo_workspace_changes')!.execute({ dir: tmpdir() }, run)).rejects.toThrow(/^\[not-found\]/)
  })
})
