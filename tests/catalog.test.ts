import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogKey } from '../src/catalog/catalog.ts'
import { HostStore } from '../src/hosts.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import type { ParallelDispatch } from '../src/events.ts'
import { credentials, mirrorLimits, testConfig, withMirrors } from './helpers.ts'

/** A service with an empty catalog over a fresh settings file. */
function setup(parallel?: ParallelDispatch, seed?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-catalog-'))
  const file = join(root, 'hosts.json')
  if (seed !== undefined) writeFileSync(file, JSON.stringify(seed))
  const warnings: string[] = []
  const hosts = new HostStore(testConfig().hosts, file, { warn: (message: string) => { warnings.push(message) } })
  const service = new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials({}),
    hosts,
    ...withMirrors(new MirrorStore({ git: async () => '', root: join(root, 'mirrors'), limits: mirrorLimits(10, 10, 1000) })),
    ...parallel === undefined ? {} : { parallel },
  })
  return { root, file, service, catalog: service.catalog, warnings }
}

describe('repository catalog', () => {
  it('keys repositories by host and path in lowercase, and local repositories by absolute path', () => {
    const { hosts } = testConfig()
    expect(catalogKey('https://GitHub.com/A/B.git', hosts)).toBe('github.com/a/b')
    expect(catalogKey('git@code.example.com:team/app.git', hosts)).toBe('code.example.com/gitlab/team/app')
    // Two instances on one host name keep their path prefixes apart.
    const shared = [...hosts, { kind: 'gitlab' as const, url: 'https://code.example.com/other', tokenRef: 'OTHER' }]
    expect(catalogKey('https://code.example.com/other/team/app', shared)).toBe('code.example.com/other/team/app')
    expect(catalogKey('https://code.example.com/gitlab/team/app', shared)).toBe('code.example.com/gitlab/team/app')
    expect(catalogKey('https://github.com/a/b/pull/3', hosts)).toBe('github.com/a/b')
    expect(catalogKey('/srv/repos/x/../app', hosts)).toBe('local:/srv/repos/app')
    expect(catalogKey(pathToFileURL('/srv/repos/app').href, hosts)).toBe('local:/srv/repos/app')
    expect(() => catalogKey('https://gitlab.com/a/b', hosts)).toThrow(expect.objectContaining({ code: 'not-allowed' }))
    expect(() => catalogKey('file://remote-host/x', hosts)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it('refuses repositories outside the catalog and calls above an entry\'s access', async () => {
    const { catalog, service } = setup()
    expect(catalog.highestAccess()).toBeUndefined()
    expect(() => catalog.require('github.com/a/b', 'read')).toThrow(expect.objectContaining({ code: 'not-allowed', message: expect.stringContaining('不在 dsh-repo 的仓库清单中') }))
    await catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    expect(catalog.highestAccess()).toBe('read')
    expect(catalog.require('https://GITHUB.com/a/B/pull/1', 'read').url).toBe('https://github.com/a/b')
    expect(() => catalog.require('github.com/a/b', 'write')).toThrow(expect.objectContaining({ code: 'not-allowed', message: expect.stringContaining('权限是「只读」，这次操作需要「可改代码」') }))
    await expect(service.listIssues('github.com/a/other')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.createIssue('github.com/a/b', { title: 'x' })).rejects.toMatchObject({ code: 'not-allowed' })
    await catalog.add({ url: 'https://github.com/a/c', access: 'merge', features: [] })
    expect(catalog.highestAccess()).toBe('merge')
    expect(catalog.require('github.com/a/c', 'merge').access).toBe('merge')
  })

  it('adds, changes, and removes entries, refusing a repository held twice and a full catalog', async () => {
    const { catalog, file } = setup()
    const added = await catalog.add({ url: ' https://github.com/a/b ', branch: ' dev ', access: 'write', features: ['b-feature', 'a-feature', 'b-feature'] })
    expect(added).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{12}$/), url: 'https://github.com/a/b', branch: 'dev', access: 'write', features: ['b-feature', 'a-feature'] })
    await expect(catalog.add({ url: 'git@github.com:A/B.git', access: 'read', features: [] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(catalog.add({ url: 'https://github.com/A/B', access: 'read', features: [] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: ['Bad'] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [], branch: '-x' })).rejects.toMatchObject({ code: 'invalid' })
    const updated = await catalog.update(added.id, { url: 'https://github.com/a/b', access: 'merge', features: [] })
    expect(updated).toEqual({ id: added.id, url: 'https://github.com/a/b', access: 'merge', features: [], addedAt: added.addedAt })
    await expect(catalog.update('000000000000', { url: 'https://github.com/a/b', access: 'read', features: [] })).rejects.toMatchObject({ code: 'not-found' })
    expect(JSON.parse(readFileSync(file, 'utf8')).repos).toEqual([updated])
    expect(await catalog.remove(added.id)).toEqual(updated)
    expect(await catalog.remove(added.id)).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hosts: [] })
  })

  it('refuses entries past the catalog limit', async () => {
    const repos = Array.from({ length: 200 }, (_, index) => ({ id: index.toString(16).padStart(12, '0'), url: `https://github.com/a/r${index}`, access: 'read', features: [], addedAt: 't' }))
    const { catalog } = setup(undefined, { hosts: [], repos })
    await expect(catalog.add({ url: 'https://github.com/a/more', access: 'read', features: [] })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('lists entries by feature and tells listeners about catalog changes and feature registrations', async () => {
    const { catalog, service } = setup()
    const seen: string[][] = []
    const stop = service.onReposChange(() => { seen.push(service.listRepos({ feature: 'log-analysis' }).map(repo => repo.url)) })
    const first = service.registerFeature({ id: 'log-analysis', title: ' 日志分析 ', description: '' })
    const second = service.registerFeature({ id: 'log-analysis', title: '日志', description: '分析日志' })
    expect(catalog.registeredFeatures()).toEqual([{ id: 'log-analysis', title: '日志', description: '分析日志' }])
    first()
    expect(catalog.registeredFeatures()).toHaveLength(1)
    second()
    expect(catalog.registeredFeatures()).toEqual([])
    expect(() => service.registerFeature({ id: 'x', title: '' })).toThrow(expect.objectContaining({ code: 'invalid' }))
    await catalog.add({ url: 'https://github.com/a/b', access: 'read', features: ['log-analysis'], localSync: { enabled: false, dir: '/srv/skills' } })
    await catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [] })
    expect(service.listRepos().map(repo => repo.url)).toEqual(['https://github.com/a/b', 'https://github.com/a/c'])
    expect(service.listRepos({ feature: 'log-analysis' })).toEqual([{ id: expect.any(String), url: 'https://github.com/a/b', access: 'read', features: ['log-analysis'], localSync: { enabled: false, dir: '/srv/skills', intervalMinutes: 720 } }])
    stop()
    await catalog.add({ url: 'https://github.com/a/d', access: 'read', features: ['log-analysis'] })
    expect(seen).toEqual([[], [], [], ['https://github.com/a/b'], ['https://github.com/a/b']])
  })

  it('adds a repository for a Session after access/authorize allows an admin change, and turns features on for an entry', async () => {
    const events: unknown[] = []
    let refuse: string | undefined
    const { service } = setup(async (name, ...args) => {
      events.push([name, args[0]])
      if (refuse !== undefined) throw new AggregateError([new Error(refuse)])
    })
    service.registerFeature({ id: 'log-analysis', title: '日志分析' })
    refuse = '只有管理员可以改仓库清单'
    await expect(service.addRepo('https://github.com/a/b', { features: ['log-analysis'], session: 's1' })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('只有管理员') })
    expect(service.listRepos()).toEqual([])
    refuse = undefined
    const added = await service.addRepo('https://github.com/a/b', { features: ['log-analysis'], session: 's1' })
    expect(added).toMatchObject({ status: 'added', repo: { url: 'https://github.com/a/b', access: 'read', features: ['log-analysis'] } })
    expect(events.at(-1)).toEqual(['access/authorize', { session: 's1', level: 'admin', action: 'addRepo', summary: '把 github.com/a/b 加入 dsh-repo 仓库清单（权限：只读；打开功能：日志分析）' }])
    expect(await service.addRepo('https://GitHub.com/A/B', { features: ['log-analysis'], session: 's1' })).toMatchObject({ status: 'unchanged' })
    expect(events).toHaveLength(2)
    const updated = await service.addRepo('https://github.com/a/b', { features: ['other'], access: 'merge', session: 's1' })
    expect(updated).toMatchObject({ status: 'updated', repo: { access: 'read', features: ['log-analysis', 'other'] } })
    expect(events.at(-1)).toMatchObject(['access/authorize', { summary: '为仓库清单中的 github.com/a/b 打开功能：other' }])
    await expect(service.addRepo('https://github.com/a/b', { branch: 'dev' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('默认分支') })
    await expect(service.addRepo('https://github.com/a/c', { session: ' ' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.addRepo('https://gitlab.com/a/c')).rejects.toMatchObject({ code: 'not-allowed' })
    expect(await service.addRepo('https://github.com/a/c', { branch: 'dev', access: 'write' })).toMatchObject({ status: 'added', repo: { branch: 'dev', access: 'write', features: [] } })
    expect(events).toHaveLength(3)
    // Concurrent additions on different branches: the one stored second is refused instead of joining the first's branch.
    const racing = await Promise.allSettled([
      service.addRepo('https://github.com/a/race', { branch: 'main', features: ['x'], session: 's1' }),
      service.addRepo('https://github.com/a/race', { branch: 'dev', features: ['y'], session: 's1' }),
    ])
    expect(racing.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(racing[1]).toMatchObject({ reason: { code: 'conflict' } })
    expect(service.listRepos().find(repo => repo.url === 'https://github.com/a/race')).toMatchObject({ branch: 'main', features: ['x'] })
    events.length = 0
    // The merged feature list stays within the limit the settings file accepts.
    const many = Array.from({ length: 20 }, (_, index) => `f${index}`)
    await service.addRepo('https://github.com/a/full', { features: many })
    await expect(service.addRepo('https://github.com/a/full', { features: ['one-more'] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('最多打开 20 个功能') })
    expect(service.listRepos().find(repo => repo.url === 'https://github.com/a/full')?.features).toHaveLength(20)
  })

  it('keeps entries whose host is gone, reports them, and skips them for the highest access', async () => {
    const entry = { id: 'abcdefabcdef', url: 'https://gone.example.com/a/b', access: 'merge', features: [], addedAt: 't' }
    const { catalog } = setup(undefined, { hosts: [], repos: [entry] })
    expect(catalog.keyOf(catalog.entries()[0]!)).toEqual({ problem: expect.stringContaining('gone.example.com') })
    expect(catalog.highestAccess()).toBeUndefined()
  })

  it('ignores retired settings with a warning and drops them on the next save', async () => {
    const seed = { hosts: [], settings: { repos: ['github.com/a/*'], mirror: { otherHosts: true, gitTimeoutMs: 60_000 }, tools: { merge: true } } }
    const { warnings, service, file } = setup(undefined, seed)
    expect(warnings).toEqual([expect.stringContaining('settings.repos、settings.mirror.otherHosts、settings.tools.merge')])
    expect(service.settings.mirror.gitTimeoutMs).toBe(60_000)
    await service.catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    expect(JSON.parse(readFileSync(file, 'utf8')).settings).toEqual({ mirror: { gitTimeoutMs: 60_000 } })
  })
})
