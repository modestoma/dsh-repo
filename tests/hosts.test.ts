import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostStore, addedTokenRef } from '../src/hosts.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { credentials, testConfig } from './helpers.ts'

function setup(tokens: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-hosts-'))
  const config = testConfig()
  const store = credentials(tokens)
  const hosts = new HostStore(config.hosts, join(root, 'hosts.json'))
  const service = new RepoService(config, {
    credentials: store,
    hosts,
    mirrors: new MirrorStore({ git: async () => '', root: join(root, 'mirrors'), timeoutMs: 1000, maxFileBytes: 10, maxTreeEntries: 10 }),
  })
  return { root, store, service }
}

describe('hosts', () => {
  it('lists configured hosts with their token status', async () => {
    const { service } = setup({ GITHUB_TOKEN: 'x' })
    const hosts = await service.listHosts()
    expect(hosts.map(host => [host.url, host.origin, host.token.configured])).toEqual([
      ['https://github.com', 'config', true],
      ['https://ghe.example.com', 'config', false],
      ['https://code.example.com/gitlab', 'config', false],
    ])
  })

  it('adds a host with its token, persists it, and resolves repositories on it', async () => {
    const { root, store, service } = setup()
    const added = await service.addHost({ url: 'https://Git.Example.com/', alias: 'git', token: ' secret ' })
    expect(added).toMatchObject({ kind: 'gitlab', url: 'https://git.example.com', alias: 'git', origin: 'added', tokenRef: addedTokenRef('https://git.example.com'), token: { configured: true } })
    expect(store.values[added.tokenRef]).toBe('secret')
    expect(JSON.parse(readFileSync(join(root, 'hosts.json'), 'utf8'))).toEqual({ hosts: [{ kind: 'gitlab', url: 'https://git.example.com', tokenRef: added.tokenRef, alias: 'git' }] })
    expect(service.resolve('git.example.com/team/app')).toMatchObject({ kind: 'gitlab', path: 'team/app' })
    await expect(service.addHost({ url: 'https://git.example.com' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.addHost({ url: 'ssh://git.example.com' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.addHost({ url: 'https://other.example.com', token: 'a\nb' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('keeps every host when additions and removals overlap', async () => {
    const { root, service } = setup()
    await service.addHost({ url: 'https://old.example.com' })
    await Promise.all([
      service.addHost({ url: 'https://a.example.com' }),
      service.addHost({ url: 'https://b.example.com' }),
      service.removeHost('https://old.example.com'),
      service.addHost({ url: 'https://c.example.com' }),
    ])
    const stored = JSON.parse(readFileSync(join(root, 'hosts.json'), 'utf8')) as { hosts: { url: string }[] }
    expect(stored.hosts.map(host => host.url)).toEqual(['https://a.example.com', 'https://b.example.com', 'https://c.example.com'])
  })

  it('sets and clears tokens, and removes only added hosts', async () => {
    const { store, service } = setup()
    const added = await service.addHost({ url: 'https://git.example.com' })
    expect(added.token.configured).toBe(false)
    expect((await service.setHostToken('https://git.example.com', 'abc')).token.configured).toBe(true)
    expect((await service.setHostToken('https://github.com', 'gh')).token.configured).toBe(true)
    expect((await service.setHostToken('https://github.com', undefined)).token.configured).toBe(false)
    await expect(service.setHostToken('https://nowhere.example.com', 'x')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.removeHost('https://github.com')).rejects.toMatchObject({ code: 'forbidden' })
    await service.removeHost('https://git.example.com')
    expect(store.values[added.tokenRef]).toBeUndefined()
    expect(() => service.resolve('git.example.com/team/app')).toThrow(/没有为 git.example.com 配置主机/)
  })
})
