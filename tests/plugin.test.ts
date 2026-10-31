import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
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

describe('plugin', () => {
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

  it('reads added hosts at load and refuses an invalid hosts file', async () => {
    const first = context()
    plugin.apply(first.ctx, undefined, { env: first.env })
    await (first.provided.get('dshRepos') as RepoService).addHost({ url: 'https://code.example.com', alias: '公司 GitLab' })
    const second = context()
    plugin.apply(second.ctx, undefined, { env: first.env })
    const hosts = await (second.provided.get('dshRepos') as RepoService).listHosts()
    expect(hosts).toMatchObject([{ kind: 'gitlab', url: 'https://code.example.com', alias: '公司 GitLab', origin: 'added' }])
    expect(() => plugin.apply(context().ctx, { hostsFile: join(first.env.DSH_HOME, 'dsh-repo') })).toThrow(/无法读取主机文件/)
  })
})
