import { describe, expect, it, vi } from 'vitest'
import type { DshRepoService } from '../src/contract.ts'
import type { HostApproval, ToolDefinition } from '../src/host.ts'
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

function tools(config = testConfig(), service = fakeService(), approval?: HostApproval): Map<string, ToolDefinition> {
  return new Map(createTools({ service, config, approval: () => approval }).map(tool => [tool.name, tool]))
}

describe('createTools', () => {
  it('registers reads, writes, and merge according to the configuration', () => {
    expect([...tools().keys()]).toEqual([
      'repo_info', 'repo_list_branches', 'repo_list_commits', 'repo_list_tree', 'repo_read_file',
      'repo_issue_list', 'repo_issue_get', 'repo_mr_list', 'repo_mr_get', 'repo_mr_diff', 'repo_mr_status',
      'repo_commit_files', 'repo_issue_create', 'repo_issue_update', 'repo_issue_comment', 'repo_mr_create', 'repo_mr_update', 'repo_mr_comment',
    ])
    expect(tools(testConfig({ tools: { writes: 'off', merge: true } })).has('repo_issue_create')).toBe(false)
    expect(tools(testConfig({ tools: { merge: true } })).has('repo_mr_merge')).toBe(true)
  })

  it('exposes JSON Schema parameters', () => {
    const parameters = tools().get('repo_commit_files')!.parameters
    expect(parameters).toMatchObject({ type: 'object', required: ['repo', 'branch', 'message', 'files'], additionalProperties: false })
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
})
