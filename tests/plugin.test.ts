import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import type { AuthorizeEvent } from '../src/contract.ts'
import type { HostContext, ToolDefinition } from '../src/host.ts'
import { RepoService } from '../src/service.ts'
import { credentials } from './helpers.ts'

function context() {
  const registered: { definition: ToolDefinition; when?: () => boolean | Promise<boolean> }[] = []
  const provided = new Map<string, unknown>()
  const info = vi.fn()
  const ctx: HostContext = {
    tools: { register: (definition, options) => { registered.push({ definition: definition as ToolDefinition, ...options?.when === undefined ? {} : { when: options.when as () => boolean } }); return () => {} } },
    credentials: credentials({}),
    logger: { info },
    provide: (name, value) => { provided.set(name, value) },
    effect: (callback) => { callback(); return () => {} },
  }
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-repo-plugin-')) }
  return { ctx, registered, provided, info, env }
}

/** Run the plugin's push tool for Session `s1` with the given `access/authorize` listeners, the service's push mocked. */
async function pushWithListeners(listeners: Array<(event: AuthorizeEvent) => void | Promise<void>>) {
  const { ctx, registered, provided, env } = context()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-'))
  writeFileSync(join(dir, '.git'), 'gitdir: /mirrors/x\n')
  const changes = { workspace: { url: 'https://github.com/a/b.git', dir, baseBranch: 'main', baseCommit: 'c'.repeat(40) }, commits: [], uncommitted: true, files: [], diff: '', truncated: false }
  vi.spyOn(RepoService.prototype, 'workspaceChanges').mockResolvedValue(changes)
  const push = vi.spyOn(RepoService.prototype, 'pushWorkspace').mockResolvedValue({ url: '', branch: 'fix/a', baseBranch: 'main', commit: 'd', committed: true, created: true })
  const events: unknown[] = []
  const approvals: string[] = []
  const withEvents: HostContext = {
    ...ctx,
    get: name => (name === 'approval' ? { request: async ({ toolName }: { toolName: string }) => { approvals.push(toolName); return 'allowed-once' } } : undefined),
    parallel: async (name, ...args) => {
      events.push(name)
      const results = await Promise.allSettled(listeners.map(async listener => await listener(args[0] as AuthorizeEvent)))
      const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)
      if (errors.length > 0) throw new AggregateError(errors)
    },
  }
  plugin.apply(withEvents, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
  await (provided.get('dshRepos') as RepoService).catalog.add({ url: 'https://github.com/a/b', access: 'write', features: [] })
  const tool = registered.find(entry => entry.definition.name === 'repo_workspace_push')!.definition
  const agent = { id: 'a1', session: { header: { id: 's1' } } }
  const outcome = tool.execute({ dir, branch: 'fix/a', message: 'fix: a' }, { signal: new AbortController().signal, agent })
  return { outcome, push, events, approvals, dir }
}

describe('plugin', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('asks access/authorize for the calling Session before the user, then pushes with the session', async () => {
    const seen: AuthorizeEvent[] = []
    const { outcome, push, events, approvals, dir } = await pushWithListeners([event => { seen.push(event) }])
    await outcome
    expect(events).toEqual([plugin.ACCESS_AUTHORIZE_EVENT])
    expect(seen).toEqual([{ session: 's1', level: 'code-write', action: 'repo_workspace_push', summary: expect.stringContaining('fix/a') }])
    expect(approvals).toEqual(['repo_workspace_push'])
    expect(push.mock.calls[0]).toEqual([dir, { branch: 'fix/a', message: 'fix: a', session: 's1', signal: expect.any(AbortSignal) }])
  })

  it('refuses the write before asking the user when a listener rejects the Session', async () => {
    const { outcome, push, approvals } = await pushWithListeners([() => {}, () => { throw new Error('发起人没有改代码权限') }])
    await expect(outcome).rejects.toThrow(/\[forbidden\] repo_workspace_push 未获授权，没有执行：发起人没有改代码权限/)
    expect(approvals).toEqual([])
    expect(push).not.toHaveBeenCalled()
  })

  it('declares its Cordis surface', () => {
    expect(plugin.name).toBe('dsh-repo')
    expect([...plugin.inject]).toEqual(['tools', 'credentials'])
  })

  it('provides dshRepos and offers tools once the catalog holds a repository', async () => {
    const { ctx, registered, provided, env } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const service = provided.get('dshRepos')
    expect(service).toBeInstanceOf(RepoService)
    expect((service as RepoService).version).toBe(5)
    expect((service as RepoService).mirrorSettings()).toEqual({ dir: undefined })
    expect(registered.length).toBeGreaterThan(10)
    expect(await registered[0]?.when?.()).toBe(false)
    await (service as RepoService).catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    expect(await registered[0]?.when?.()).toBe(true)
  })

  it('offers no tools before a host and a repository are added, and fails loudly on bad config', async () => {
    const { ctx, registered, provided, info, env } = context()
    plugin.apply(ctx, undefined, { env })
    const service = provided.get('dshRepos') as RepoService
    expect(registered.length).toBeGreaterThan(10)
    expect(await registered[0]?.when?.()).toBe(false)
    expect(info).toHaveBeenCalled()
    await expect(service.catalog.add({ url: 'https://code.example.com/team/app', access: 'read', features: [] })).rejects.toMatchObject({ code: 'not-allowed' })
    await service.addHost({ url: 'https://code.example.com' })
    await service.catalog.add({ url: 'https://code.example.com/team/app', access: 'read', features: [] })
    expect(await registered[0]?.when?.()).toBe(true)
    expect(() => plugin.apply(context().ctx, { hosts: 'github.com' })).toThrow(/配置不合法/)
  })

  it('offers tools as the saved tool settings and the catalog access allow', async () => {
    const { ctx, registered, provided, env } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const service = provided.get('dshRepos') as RepoService
    const offered = async (name: string) => await registered.find(entry => entry.definition.name === name)!.when!()
    const entry = await service.catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    expect([await offered('repo_info'), await offered('repo_issue_create'), await offered('repo_mr_merge')]).toEqual([true, false, false])
    await service.catalog.update(entry.id, { url: entry.url, access: 'write', features: [] })
    expect([await offered('repo_info'), await offered('repo_issue_create'), await offered('repo_mr_merge')]).toEqual([true, true, false])
    await service.catalog.update(entry.id, { url: entry.url, access: 'merge', features: [] })
    expect(await offered('repo_mr_merge')).toBe(true)
    await service.updateSettings({ tools: { writes: 'off' } })
    expect([await offered('repo_info'), await offered('repo_issue_create'), await offered('repo_mr_merge')]).toEqual([true, false, false])
    await service.updateSettings({ tools: { enabled: false } })
    expect(await offered('repo_info')).toBe(false)
  })

  it('offers repo_mr_watch only while watching is on and a session controller can wake Sessions', async () => {
    const services: Record<string, unknown> = {}
    const { ctx, registered, provided, env } = context()
    plugin.apply({ ...ctx, get: name => services[name] }, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    await (provided.get('dshRepos') as RepoService).catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    const offered = async () => await registered.find(entry => entry.definition.name === 'repo_mr_watch')!.when!()
    expect(await offered()).toBe(false)
    services.sessionController = { resolveAgent: async () => ({ error: new Error('unused') }) }
    expect(await offered()).toBe(true)
    await (provided.get('dshRepos') as RepoService).updateSettings({ watch: { enabled: false } })
    expect(await offered()).toBe(false)
  })

  it('reads added hosts at load and refuses an invalid hosts file', async () => {
    const first = context()
    plugin.apply(first.ctx, undefined, { env: first.env })
    await (first.provided.get('dshRepos') as RepoService).addHost({ url: 'https://code.example.com', alias: '公司 GitLab' })
    const second = context()
    plugin.apply(second.ctx, undefined, { env: first.env })
    const hosts = await (second.provided.get('dshRepos') as RepoService).listHosts()
    expect(hosts).toMatchObject([{ kind: 'gitlab', url: 'https://code.example.com', alias: '公司 GitLab', origin: 'added' }])
    expect(() => plugin.apply(context().ctx, { hostsFile: join(first.env.DSH_HOME, 'dsh-repo') })).toThrow(/无法读取设置文件/)
  })
})
