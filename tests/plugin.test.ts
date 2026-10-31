import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import type { HostContext, ToolDefinition } from '../src/host.ts'
import { RepoService } from '../src/service.ts'
import { credentials } from './helpers.ts'

function context() {
  const registered: ToolDefinition[] = []
  const provided = new Map<string, unknown>()
  const warn = vi.fn()
  const ctx: HostContext = {
    tools: { register: (definition) => { registered.push(definition as ToolDefinition); return () => {} } },
    credentials: credentials({}),
    logger: { warn },
    provide: (name, value) => { provided.set(name, value) },
    effect: (callback) => { callback(); return () => {} },
  }
  return { ctx, registered, provided, warn }
}

describe('plugin', () => {
  it('declares its Cordis surface', () => {
    expect(plugin.name).toBe('dsh-repo')
    expect([...plugin.inject]).toEqual(['tools', 'credentials'])
  })

  it('provides dshRepos and registers tools when a host is configured', () => {
    const { ctx, registered, provided } = context()
    plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] })
    const service = provided.get('dshRepos')
    expect(service).toBeInstanceOf(RepoService)
    expect((service as RepoService).version).toBe(1)
    expect(registered.length).toBeGreaterThan(10)
  })

  it('provides the service but registers no tools without hosts, and fails loudly on bad config', () => {
    const { ctx, registered, provided, warn } = context()
    plugin.apply(ctx, undefined)
    expect(provided.has('dshRepos')).toBe(true)
    expect(registered).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(() => plugin.apply(context().ctx, { hosts: 'github.com' })).toThrow(/配置不合法/)
  })
})
