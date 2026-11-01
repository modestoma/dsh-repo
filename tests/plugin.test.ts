import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import type { CommitTrailersEvent } from '../src/contract.ts'
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

/** Run the plugin's push tool for Session `s1` with the given `repo/commit-trailers` listeners. */
async function pushWithListeners(listeners: Array<(event: CommitTrailersEvent) => void | Promise<void>>) {
  const { ctx, registered, env } = context()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-'))
  writeFileSync(join(dir, '.git'), 'gitdir: /mirrors/x\n')
  const changes = { workspace: { url: 'https://github.com/a/b.git', dir, baseBranch: 'main', baseCommit: 'c'.repeat(40) }, commits: [], uncommitted: true, files: [], diff: '', truncated: false }
  vi.spyOn(RepoService.prototype, 'workspaceChanges').mockResolvedValue(changes)
  const push = vi.spyOn(RepoService.prototype, 'pushWorkspace').mockResolvedValue({ url: '', branch: 'fix/a', baseBranch: 'main', commit: 'd', committed: true, created: true })
  const events: unknown[] = []
  const withEvents: HostContext = {
    ...ctx,
    get: name => (name === 'approval' ? { request: async () => 'allowed-once' } : undefined),
    parallel: async (name, ...args) => {
      events.push(name)
      const results = await Promise.allSettled(listeners.map(async listener => await listener(args[0] as CommitTrailersEvent)))
      const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)
      if (errors.length > 0) throw new AggregateError(errors)
    },
  }
  plugin.apply(withEvents, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
  const tool = registered.find(entry => entry.definition.name === 'repo_workspace_push')!.definition
  const agent = { id: 'a1', session: { header: { id: 's1' } } }
  const outcome = tool.execute({ dir, branch: 'fix/a', message: 'fix: a' }, { signal: new AbortController().signal, agent })
  return { outcome, push, events, dir }
}

describe('plugin', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('collects repo/commit-trailers from every listener, in order, and ignores late additions', async () => {
    let late: CommitTrailersEvent | undefined
    const { outcome, push, events, dir } = await pushWithListeners([
      event => { expect(event).toMatchObject({ session: 's1', dir }); event.add('Feishu-User', '张三 <u_1>') },
      async event => { late = event; event.add('Reviewed-By', 'bot') },
    ])
    await outcome
    late?.add('Late', 'x')
    expect(events).toEqual([plugin.COMMIT_TRAILERS_EVENT])
    expect(push.mock.calls[0]?.[1]).toMatchObject({
      session: 's1', trailers: [{ token: 'Feishu-User', value: '张三 <u_1>' }, { token: 'Reviewed-By', value: 'bot' }],
    })
  })

  it('fails the push without committing when a trailer listener throws', async () => {
    const { outcome, push } = await pushWithListeners([event => { event.add('A', 'b') }, () => { throw new Error('directory down') }])
    await expect(outcome).rejects.toThrow(/\[unavailable\] repo\/commit-trailers 监听者出错，没有提交：directory down/)
    expect(push).not.toHaveBeenCalled()
  })

  it('declares its Cordis surface', () => {
    expect(plugin.name).toBe('dsh-repo')
    expect([...plugin.inject]).toEqual(['tools', 'credentials'])
  })

  it('provides dshRepos and offers tools when a host is configured', async () => {
    const { ctx, registered, provided, env } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const service = provided.get('dshRepos')
    expect(service).toBeInstanceOf(RepoService)
    expect((service as RepoService).version).toBe(2)
    expect((service as RepoService).mirrorSettings().dir).toBe(join(env.DSH_HOME, 'dsh-repo', 'mirrors'))
    expect(registered.length).toBeGreaterThan(10)
    expect(await registered[0]?.when?.()).toBe(true)
  })

  it('offers tools only after a host is added, and fails loudly on bad config', async () => {
    const { ctx, registered, provided, info, env } = context()
    plugin.apply(ctx, undefined, { env })
    const service = provided.get('dshRepos') as RepoService
    expect(registered.length).toBeGreaterThan(10)
    expect(await registered[0]?.when?.()).toBe(false)
    expect(info).toHaveBeenCalled()
    await service.addHost({ url: 'https://code.example.com' })
    expect(await registered[0]?.when?.()).toBe(true)
    expect(() => plugin.apply(context().ctx, { hosts: 'github.com' })).toThrow(/配置不合法/)
  })

  it('offers tools as the saved tool settings allow', async () => {
    const { ctx, registered, provided, env } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
    const service = provided.get('dshRepos') as RepoService
    const offered = async (name: string) => await registered.find(entry => entry.definition.name === name)!.when!()
    expect([await offered('repo_info'), await offered('repo_issue_create'), await offered('repo_mr_merge')]).toEqual([true, true, false])
    await service.updateSettings({ tools: { merge: true } })
    expect(await offered('repo_mr_merge')).toBe(true)
    await service.updateSettings({ tools: { writes: 'off', merge: true } })
    expect([await offered('repo_info'), await offered('repo_issue_create'), await offered('repo_mr_merge')]).toEqual([true, false, false])
    await service.updateSettings({ tools: { enabled: false } })
    expect(await offered('repo_info')).toBe(false)
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
