import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { DshReposApi } from '../src/api.ts'
import type { AuthorizeEvent } from '../src/contract.ts'
import { ACCESS_AUTHORIZE_EVENT } from '../src/events.ts'
import type { HostContext, ToolDefinition } from '../src/host.ts'
import { Forge } from '../src/forge/forge.ts'
import type { RepoService } from '../src/service.ts'
import { credentials } from './helpers.ts'

/** Disposers of every effect a test context ran; the tests stop them so the proxy and timers end. */
const disposers: Array<() => void> = []

function context() {
  const registered: { definition: ToolDefinition; when?: () => boolean | Promise<boolean> }[] = []
  const provided = new Map<string, unknown>()
  const info = vi.fn()
  const ctx: HostContext = {
    tools: { register: (definition, options) => { registered.push({ definition: definition as ToolDefinition, ...options?.when === undefined ? {} : { when: options.when as () => boolean } }); return () => {} } },
    credentials: credentials({}),
    logger: { info },
    provide: (name, value) => { provided.set(name, value) },
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  const env = { DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-repo-plugin-')) }
  return { ctx, registered, provided, info, env }
}

/** The service the plugin provided and the engine behind it. */
function provided(map: Map<string, unknown>): { api: DshReposApi; engine: RepoService } {
  const api = map.get('dshRepos') as DshReposApi
  return { api, engine: Reflect.get(api, 'service') as RepoService }
}

/** Run the plugin's issue tool for Session `s1` with the given `access/authorize` listeners, the engine's call mocked. */
async function createIssueWithListeners(listeners: Array<(event: AuthorizeEvent) => void | Promise<void>>) {
  const { ctx, registered, provided: map, env } = context()
  const create = vi.spyOn(Forge.prototype, 'createIssue').mockResolvedValue({ number: 1, title: 'Bug', body: '', state: 'open', author: { username: 'bot' }, labels: [], assignees: [], webUrl: 'u', createdAt: 'c', updatedAt: 'u' })
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
  await provided(map).api.repoAdd({ repo: 'https://github.com/a/b', access: 'write' })
  const tool = registered.find(entry => entry.definition.name === 'repo_issue_create')!.definition
  const agent = { id: 'a1', session: { header: { id: 's1' } } }
  const outcome = tool.execute({ repo: 'github.com/a/b', title: 'Bug' }, { signal: new AbortController().signal, agent })
  return { outcome, create, events, approvals }
}

describe('plugin', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('asks access/authorize for the calling Session before the user, then runs the write', async () => {
    const seen: AuthorizeEvent[] = []
    const { outcome, create, events, approvals } = await createIssueWithListeners([event => { seen.push(event) }])
    expect(await outcome).toMatchObject({ number: 1 })
    expect(events).toEqual([ACCESS_AUTHORIZE_EVENT])
    expect(seen).toEqual([{ session: 's1', level: 'code-write', action: 'issueCreate', summary: '在 github.com/a/b 创建 issue：Bug' }])
    expect(approvals).toEqual(['repo_issue_create'])
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses the write before asking the user when a listener rejects the Session', async () => {
    const { outcome, create, approvals } = await createIssueWithListeners([() => {}, () => { throw new Error('发起人没有改代码权限') }])
    await expect(outcome).rejects.toThrow(/\[forbidden\] issueCreate 未获授权，没有执行：发起人没有改代码权限/)
    expect(approvals).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })

  it('declares its Cordis surface', () => {
    expect(plugin.name).toBe('dsh-repo')
    expect([...plugin.inject]).toEqual(['tools', 'credentials'])
  })

  it('provides dshRepos v6, starts the local git proxy, and offers tools once the catalog holds a repository', async () => {
    const { ctx, registered, provided: map, env } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const { api } = provided(map)
    expect(api).toBeInstanceOf(DshReposApi)
    expect(api.version).toBe(6)
    await vi.waitFor(() => { expect(api.settingsGet().proxyListening).toBeGreaterThan(0) })
    expect(api.settingsGet()).toMatchObject({ mirrorDir: undefined, proxyPort: 0, commitName: '', commitEmail: '', workspaceDir: undefined })
    expect(registered.map(entry => entry.definition.name)).toHaveLength(34)
    const offered = async (name: string) => await registered.find(entry => entry.definition.name === name)!.when!()
    expect([await offered('repo_list'), await offered('repo_add')]).toEqual([false, true])
    await api.repoAdd({ repo: 'https://github.com/a/b' })
    expect(await offered('repo_list')).toBe(true)
  })

  it('moves the local git proxy to a port saved in the settings', async () => {
    const { ctx, provided: map, env } = context()
    plugin.apply(ctx, undefined, { env })
    const { api } = provided(map)
    await vi.waitFor(() => { expect(api.settingsGet().proxyListening).toBeGreaterThan(0) })
    const free = createServer()
    await new Promise<void>((resolve) => { free.listen(0, '127.0.0.1', resolve) })
    const port = (free.address() as AddressInfo).port
    await new Promise<void>((resolve) => { free.close(() => { resolve() }) })
    expect(await api.settingsUpdate({ proxyPort: port, commitName: 'Bot', commitEmail: 'bot@example.com' })).toMatchObject({ proxyPort: port, proxyListening: port, commitName: 'Bot', commitEmail: 'bot@example.com' })
    const blocker = createServer()
    await new Promise<void>((resolve) => { blocker.listen(0, '127.0.0.1', resolve) })
    const taken = (blocker.address() as AddressInfo).port
    await expect(api.settingsUpdate({ proxyPort: taken })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('设置已保存') })
    expect(api.settingsGet()).toMatchObject({ proxyPort: taken, proxyListening: port })
    // Once the port is free, saving the same settings again starts the proxy there.
    await new Promise<void>((resolve) => { blocker.close(() => { resolve() }) })
    expect(await api.settingsUpdate({ proxyPort: taken })).toMatchObject({ proxyPort: taken, proxyListening: taken })
  })

  it('offers no tools before a host and a repository are added, and fails loudly on bad config', async () => {
    const { ctx, registered, provided: map, info, env } = context()
    plugin.apply(ctx, undefined, { env })
    const { api } = provided(map)
    expect(registered.length).toBe(34)
    expect(await registered[0]?.when?.()).toBe(false)
    expect(info).toHaveBeenCalled()
    await expect(api.repoAdd({ repo: 'https://code.example.com/team/app' })).rejects.toMatchObject({ code: 'not-allowed' })
    await api.hostAdd({ url: 'https://code.example.com' })
    await api.repoAdd({ repo: 'https://code.example.com/team/app' })
    expect(await registered[0]?.when?.()).toBe(true)
    expect(() => plugin.apply(context().ctx, { hosts: 'github.com' })).toThrow(/配置不合法/)
  })

  it('offers tools as the saved tool settings and the catalog access allow', async () => {
    const { ctx, registered, provided: map, env } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const { engine: service } = provided(map)
    const offered = async (name: string) => await registered.find(entry => entry.definition.name === name)!.when!()
    const entry = await service.catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    expect([await offered('repo_get'), await offered('repo_workspace_create'), await offered('repo_workspace_push'), await offered('repo_mr_merge')]).toEqual([true, true, false, false])
    await service.catalog.update(entry.id, { url: entry.url, access: 'write', features: [] })
    expect([await offered('repo_get'), await offered('repo_workspace_push'), await offered('repo_mr_merge')]).toEqual([true, true, false])
    await service.catalog.update(entry.id, { url: entry.url, access: 'merge', features: [] })
    expect(await offered('repo_mr_merge')).toBe(true)
    await service.settings.update({ tools: { writes: 'off' } })
    expect([await offered('repo_get'), await offered('repo_workspace_push'), await offered('repo_mr_merge'), await offered('repo_add')]).toEqual([true, false, false, false])
    await service.settings.update({ tools: { enabled: false } })
    expect(await offered('repo_get')).toBe(false)
  })

  it('offers repo_mr_watch only while watching is on and a session controller can wake Sessions', async () => {
    const services: Record<string, unknown> = {}
    const { ctx, registered, provided: map, env } = context()
    plugin.apply({ ...ctx, get: name => services[name] }, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const { api, engine } = provided(map)
    await api.repoAdd({ repo: 'https://github.com/a/b' })
    const offered = async () => await registered.find(entry => entry.definition.name === 'repo_mr_watch')!.when!()
    expect(await offered()).toBe(false)
    services.sessionController = { resolveAgent: async () => ({ error: new Error('unused') }) }
    expect(await offered()).toBe(true)
    await engine.settings.update({ watch: { enabled: false } })
    expect(await offered()).toBe(false)
  })

  it('reads added hosts at load and refuses an invalid hosts file', async () => {
    const first = context()
    plugin.apply(first.ctx, undefined, { env: first.env })
    await provided(first.provided).api.hostAdd({ url: 'https://code.example.com', alias: '公司 GitLab' })
    const second = context()
    plugin.apply(second.ctx, undefined, { env: first.env })
    const hosts = await provided(second.provided).api.hostList()
    expect(hosts).toMatchObject([{ kind: 'gitlab', url: 'https://code.example.com', alias: '公司 GitLab', origin: 'added' }])
    expect(() => plugin.apply(context().ctx, { hostsFile: join(first.env.DSH_HOME, 'dsh-repo') })).toThrow(/设置文件 .* 无法读取/)
  })
})
