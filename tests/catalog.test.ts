import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogKey } from '../src/catalog/catalog.ts'
import { SettingsStore } from '../src/settings/store.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { credentials, mirrorLimits, testConfig } from './helpers.ts'

/** A service with an empty catalog over a fresh settings file. */
function setup(seed?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-catalog-'))
  const file = join(root, 'hosts.json')
  if (seed !== undefined) writeFileSync(file, JSON.stringify(seed))
  const warnings: string[] = []
  const hosts = new SettingsStore(testConfig().hosts, file, { warn: (message: string) => { warnings.push(message) } })
  const service = new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials({}),
    store: hosts,
    mirrorStore: new MirrorStore({ git: async () => '', root: join(root, 'mirrors'), limits: mirrorLimits(1000) }),
  })
  return { root, file, service, catalog: service.catalog, warnings }
}

describe('repository catalog', () => {
  it('keys repositories by host and path in lowercase, and refuses local paths', () => {
    const { hosts } = testConfig()
    expect(catalogKey('https://GitHub.com/A/B.git', hosts)).toBe('github.com/a/b')
    expect(catalogKey('git@code.example.com:team/app.git', hosts)).toBe('code.example.com/gitlab/team/app')
    // Two instances on one host name keep their path prefixes apart.
    const shared = [...hosts, { kind: 'gitlab' as const, url: 'https://code.example.com/other', tokenRef: 'OTHER' }]
    expect(catalogKey('https://code.example.com/other/team/app', shared)).toBe('code.example.com/other/team/app')
    expect(catalogKey('https://code.example.com/gitlab/team/app', shared)).toBe('code.example.com/gitlab/team/app')
    expect(catalogKey('https://github.com/a/b/pull/3', hosts)).toBe('github.com/a/b')
    expect(() => catalogKey('/srv/repos/app', hosts)).toThrow(expect.objectContaining({ code: 'not-allowed' }))
    expect(() => catalogKey(pathToFileURL('/srv/repos/app').href, hosts)).toThrow(expect.objectContaining({ code: 'invalid' }))
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
    expect(catalog.open(' https://GITHUB.com/a/B/pull/1', 'read')).toMatchObject({ key: 'github.com/a/b', entry: { url: 'https://github.com/a/b' }, target: { path: 'a/B', spec: { kind: 'github' } } })
    expect(() => catalog.require('github.com/a/b', 'write')).toThrow(expect.objectContaining({ code: 'not-allowed', message: expect.stringContaining('权限是「只读」，这次操作需要「可改代码」') }))
    await expect(service.forge.listIssues('github.com/a/other')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.forge.createIssue('github.com/a/b', { title: 'x' })).rejects.toMatchObject({ code: 'not-allowed' })
    await catalog.add({ url: 'https://github.com/a/c', access: 'merge', features: [] })
    expect(catalog.highestAccess()).toBe('merge')
    expect(catalog.require('github.com/a/c', 'merge').access).toBe('merge')
  })

  it('resolves a repository path without a host to the one entry that has it', async () => {
    const { catalog, service } = setup()
    await catalog.add({ url: 'https://code.example.com/gitlab/pe/tool/modem_cli', access: 'read', features: [] })
    await catalog.add({ url: 'https://github.com/team/app', access: 'read', features: [] })
    await catalog.add({ url: 'https://ghe.example.com/team/app', access: 'read', features: [] })
    await catalog.add({ url: 'https://github.com/other/modem_cli', access: 'read', features: [] })
    expect(catalog.open('pe/tool/modem_cli', 'read')).toMatchObject({ key: 'code.example.com/gitlab/pe/tool/modem_cli', target: { kind: 'gitlab', path: 'pe/tool/modem_cli', spec: { url: 'https://code.example.com/gitlab' } } })
    expect(catalog.find(' /PE/Tool/modem_cli.git/ ')?.url).toBe('https://code.example.com/gitlab/pe/tool/modem_cli')
    expect(service.forge.resolve('pe/tool/modem_cli')).toEqual({ kind: 'gitlab', host: 'code.example.com', path: 'pe/tool/modem_cli', webUrl: 'https://code.example.com/gitlab/pe/tool/modem_cli' })
    // A configured host wins over an entry path.
    expect(catalog.open('github.com/team/app', 'read').key).toBe('github.com/team/app')
    expect(() => catalog.open('team/app', 'read')).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringContaining('github.com/team/app、ghe.example.com/team/app') }))
    expect(() => catalog.open('tool/modem_cli', 'read')).toThrow(expect.objectContaining({ code: 'not-allowed', message: expect.stringContaining('同名的仓库：code.example.com/gitlab/pe/tool/modem_cli、github.com/other/modem_cli') }))
    expect(() => catalog.open('pe/tool/nothing', 'read')).toThrow(expect.objectContaining({ code: 'not-allowed', message: expect.stringContaining('用 repo_list 查看') }))
    // A first segment that looks like a host name keeps the host refusal; other forms never become paths.
    expect(() => catalog.open('git.unknown.com/pe/tool/modem_cli', 'read')).toThrow(expect.objectContaining({ code: 'not-allowed', message: expect.stringContaining('没有为 git.unknown.com 配置主机') }))
    expect(() => catalog.open('https://pe/tool/modem_cli', 'read')).toThrow(expect.objectContaining({ message: expect.stringContaining('没有为 pe 配置主机') }))
    expect(() => catalog.open('modem_cli', 'read')).toThrow(expect.objectContaining({ message: expect.stringContaining('没有为 modem_cli 配置主机') }))
    expect(() => catalog.open('pe/../modem_cli', 'read')).toThrow(expect.objectContaining({ code: 'not-allowed' }))
  })

  it('skips entries whose host was removed when resolving a path without a host', () => {
    const { catalog } = setup({ hosts: [], repos: [{ id: '000000000001', url: 'https://gone.example.com/pe/app', access: 'read', features: [], addedAt: 't' }, { id: '000000000002', url: 'https://github.com/pe/app', access: 'read', features: [], addedAt: 't' }] })
    expect(catalog.open('pe/app', 'read').key).toBe('github.com/pe/app')
  })

  it('adds, changes, and removes entries, refusing a repository held twice and a full catalog', async () => {
    const { catalog, file } = setup()
    const added = await catalog.add({ url: ' https://github.com/a/b ', base: ' dev ', access: 'write', features: [{ id: 'b-feature', branch: ' main ' }, { id: 'a-feature', branch: '' }, { id: 'b-feature' }], localSync: { enabled: false, dir: '/srv/x', branch: 'release' }, branchTemplate: ' feature/{random} ', branchPattern: '^feature/' })
    expect(added).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{12}$/), url: 'https://github.com/a/b', base: 'dev', access: 'write', features: [{ id: 'b-feature', branch: 'main' }, { id: 'a-feature' }], localSync: { branch: 'release' }, branchRules: { template: 'feature/{random}', pattern: '^feature/' } })
    await expect(catalog.add({ url: 'git@github.com:A/B.git', access: 'read', features: [] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(catalog.add({ url: 'https://github.com/A/B', access: 'read', features: [] })).rejects.toMatchObject({ code: 'conflict' })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [{ id: 'Bad' }] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [], base: '-x' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('基线分支') })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [{ id: 'x', branch: 'a..b' }] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('功能 x 的分支') })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [], branchTemplate: 'fixed' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('{session} 或 {random}') })
    await expect(catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [], branchPattern: '(' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('正则') })
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
    const { catalog } = setup({ hosts: [], repos })
    await expect(catalog.add({ url: 'https://github.com/a/more', access: 'read', features: [] })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('lists entries by feature and tells listeners about catalog changes and feature registrations', async () => {
    const { catalog, service } = setup()
    const seen: string[][] = []
    const stop = service.catalog.onChange(() => { seen.push(service.catalog.list({ feature: 'log-analysis' }).map(repo => repo.url)) })
    const first = service.catalog.registerFeature({ id: 'log-analysis', title: ' 日志分析 ', description: '' })
    const second = service.catalog.registerFeature({ id: 'log-analysis', title: '日志', description: '分析日志' })
    expect(catalog.registeredFeatures()).toEqual([{ id: 'log-analysis', title: '日志', description: '分析日志' }])
    first()
    expect(catalog.registeredFeatures()).toHaveLength(1)
    second()
    expect(catalog.registeredFeatures()).toEqual([])
    expect(() => service.catalog.registerFeature({ id: 'x', title: '' })).toThrow(expect.objectContaining({ code: 'invalid' }))
    await catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [{ id: 'log-analysis', branch: 'main' }], localSync: { enabled: false, dir: '/srv/skills' } })
    await catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [] })
    expect(service.catalog.list().map(repo => repo.url)).toEqual(['https://github.com/a/b', 'https://github.com/a/c'])
    expect(service.catalog.list({ feature: 'log-analysis' })).toEqual([{ id: expect.any(String), url: 'https://github.com/a/b', access: 'read', features: [{ id: 'log-analysis', branch: 'main' }], localSync: { enabled: false, dir: '/srv/skills', intervalMinutes: 720 } }])
    stop()
    await catalog.add({ url: 'https://github.com/a/d', access: 'read', features: [{ id: 'log-analysis' }] })
    expect(seen).toEqual([[], [], [], ['https://github.com/a/b'], ['https://github.com/a/b']])
  })

  it('rewrites entries of earlier versions: their branch becomes the baseline, feature, and local sync branch', () => {
    const { catalog } = setup({
      hosts: [],
      repos: [
        { id: '000000000001', url: 'https://github.com/a/b', branch: 'main', access: 'write', features: ['log-analysis'], localSync: { enabled: true, dir: '/srv/b', intervalMinutes: 60 }, addedAt: 't' },
        { id: '000000000002', url: 'https://github.com/a/c', access: 'read', features: ['log-analysis'], addedAt: 't' },
      ],
    })
    expect(catalog.list()).toEqual([
      { id: '000000000001', url: 'https://github.com/a/b', base: 'main', access: 'write', features: [{ id: 'log-analysis', branch: 'main' }], localSync: { enabled: true, dir: '/srv/b', intervalMinutes: 60, branch: 'main' } },
      { id: '000000000002', url: 'https://github.com/a/c', access: 'read', features: [{ id: 'log-analysis' }] },
    ])
  })

  it('keeps entries whose host is gone, reports them, and skips them for the highest access', async () => {
    const entry = { id: 'abcdefabcdef', url: 'https://gone.example.com/a/b', access: 'merge', features: [], addedAt: 't' }
    const { catalog } = setup({ hosts: [], repos: [entry] })
    expect(catalog.keyOf(catalog.entries()[0]!)).toEqual({ problem: expect.stringContaining('gone.example.com') })
    expect(catalog.highestAccess()).toBeUndefined()
  })

  it('ignores retired settings with a warning and drops them on the next save', async () => {
    const seed = { hosts: [], settings: { repos: ['github.com/a/*'], mirror: { otherHosts: true, gitTimeoutMs: 60_000 }, tools: { merge: true } } }
    const { warnings, service, file } = setup(seed)
    expect(warnings).toEqual([expect.stringContaining('settings.repos、settings.mirror.otherHosts、settings.tools.merge')])
    expect(service.settings.current.mirror.gitTimeoutMs).toBe(60_000)
    await service.catalog.add({ url: 'https://github.com/a/b', access: 'read', features: [] })
    expect(JSON.parse(readFileSync(file, 'utf8')).settings).toEqual({ mirror: { gitTimeoutMs: 60_000 } })
  })

  it('ignores catalog entries of local repositories with a warning and drops them on the next save', async () => {
    const entry = { access: 'read', features: [], addedAt: '2026-11-01T00:00:00.000Z' }
    const seed = { hosts: [], repos: [{ ...entry, id: '000000000001', url: '/srv/repos/app' }, { ...entry, id: '000000000002', url: 'file:///srv/repos/lib' }, { ...entry, id: '000000000003', url: 'https://github.com/a/b' }] }
    const { warnings, service, file } = setup(seed)
    expect(warnings).toEqual([expect.stringContaining('/srv/repos/app、file:///srv/repos/lib')])
    expect(service.catalog.entries().map(item => item.url)).toEqual(['https://github.com/a/b'])
    await service.catalog.add({ url: 'https://github.com/a/c', access: 'read', features: [] })
    expect(JSON.parse(readFileSync(file, 'utf8')).repos.map((item: { url: string }) => item.url)).toEqual(['https://github.com/a/b', 'https://github.com/a/c'])
  })
})
