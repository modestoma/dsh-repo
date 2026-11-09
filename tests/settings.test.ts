import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostContext, HostWebServer } from '../src/host.ts'
import * as plugin from '../src/index.ts'
import type { RepoService } from '../src/service.ts'
import type { MirrorUsage, SettingsState, WorkspaceRow } from '../src/settings/contract.ts'
import { credentials } from './helpers.ts'
import { fileRemote, REMOTE_TOKENS, remoteConfig, stubProviders } from './remote.ts'
import type { Remote } from './remote.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const servers: { close(): void }[] = []
/** Disposers of the plugin's effects, run after each test so its git proxy and timers stop. */
const effects: (() => void)[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dispose of effects.splice(0)) dispose()
})

/** Apply the plugin with a Web server whose routes are served on a real port. */
async function serve(rejection?: 401 | 403, extra: Record<string, unknown> = {}, home?: string, remote?: Remote) {
  const routes = new Map<string, Handler>()
  const webServer: HostWebServer = {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const services: Record<string, unknown> = { webServer, connection: { requestRejection: () => rejection }, ...extra }
  const provided = new Map<string, unknown>()
  const disposers: (() => void)[] = []
  const ctx: HostContext = {
    tools: { register: () => () => {} },
    credentials: credentials({ GITHUB_TOKEN: 'gh', ...remote === undefined ? {} : REMOTE_TOKENS }),
    provide: (name, value) => { provided.set(name, value) },
    get: name => services[name],
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') {
        disposers.push(dispose)
        effects.push(dispose)
      }
      return () => {}
    },
    inject: (names, callback) => { if (names.every(name => services[name] !== undefined)) callback(ctx) },
  }
  const env = { DSH_HOME: home ?? mkdtempSync(join(tmpdir(), 'dsh-repo-settings-')) }
  // Test directories live under the system temporary directory, so only `$DSH_HOME` stays forbidden here.
  const github = { kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }
  plugin.apply(ctx, remote === undefined ? { hosts: [github] } : remoteConfig([github]), {
    env,
    forbiddenMirrorRoots: [env.DSH_HOME],
    ...remote === undefined ? {} : { git: remote.git, providerFactory: stubProviders({ getBranch: async () => undefined, listMrs: async () => ({ items: [] }) }) },
  })
  const http = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  servers.push(http)
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, init)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
    ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
  return { call, json, routes, disposers, service: Reflect.get(provided.get('dshRepos') as object, 'service') as RepoService, env, base }
}

describe('settings routes', () => {
  it('reports hosts with token status and that no mirror directory is chosen', async () => {
    const { call } = await serve()
    const { status, body } = await call('/dsh-repo/state')
    expect(status).toBe(200)
    const state = body as unknown as SettingsState
    expect(state.mirror).toEqual({})
    expect(state.pickerAvailable).toBe(false)
    expect(state.hosts).toMatchObject([{ kind: 'github', url: 'https://github.com', origin: 'config', token: { configured: true, source: 'file' } }])
    expect(JSON.stringify(body)).not.toContain('"gh"')
  })

  it('adds, updates, and removes hosts, and reports each change', async () => {
    const { call, json, service } = await serve()
    const changes: string[] = []
    service.onHostsChange((change) => { changes.push(change.kind) })
    let response = await call('/dsh-repo/hosts', json('POST', { kind: 'gitlab', url: 'https://git.example.com/', alias: 'git', token: 'abc' }))
    expect(response.status).toBe(200)
    expect((response.body.state as SettingsState).hosts[1]).toMatchObject({ url: 'https://git.example.com', alias: 'git', origin: 'added', token: { configured: true } })
    response = await call('/dsh-repo/host-token', json('DELETE', { url: 'https://git.example.com' }))
    expect((response.body.state as SettingsState).hosts[1]?.token.configured).toBe(false)
    response = await call('/dsh-repo/host-token', json('PUT', { url: 'https://git.example.com', value: 'def' }))
    expect((response.body.state as SettingsState).hosts[1]?.token.configured).toBe(true)
    response = await call('/dsh-repo/hosts', json('DELETE', { url: 'https://git.example.com' }))
    expect((response.body.state as SettingsState).hosts).toHaveLength(1)
    expect(changes).toEqual(['added', 'token', 'token', 'removed'])
  })

  it('maps service failures and bad requests to HTTP statuses', async () => {
    const { call, json } = await serve()
    expect((await call('/dsh-repo/hosts', json('DELETE', { url: 'https://github.com' }))).status).toBe(403)
    expect((await call('/dsh-repo/host-token', json('PUT', { url: 'https://nowhere.example.com', value: 'x' }))).status).toBe(404)
    expect((await call('/dsh-repo/hosts', json('POST', { url: 'https://github.com' }))).status).toBe(409)
    const invalid = await call('/dsh-repo/hosts', json('POST', { url: 'https://x.example.com', extra: 1 }))
    expect(invalid).toMatchObject({ status: 400, body: { ok: false } })
    expect((await call('/dsh-repo/hosts', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status).toBe(400)
    expect((await call('/dsh-repo/hosts', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await call('/dsh-repo/hosts', { method: 'POST' })).status).toBe(400)
    expect((await call('/dsh-repo/state', { method: 'POST' })).status).toBe(405)
  })

  it('refuses cross-origin writes and requests the Host gate rejects', async () => {
    const { call, json } = await serve()
    const cross = await call('/dsh-repo/hosts', json('POST', { url: 'https://x.example.com' }, { origin: 'https://evil.example.com' }))
    expect(cross.status).toBe(403)
    expect((await (await serve(401)).call('/dsh-repo/state')).status).toBe(401)
  })

  it('chooses the mirror directory, keeps the choice in hosts.json, refuses forbidden roots, and clears it', async () => {
    const { call, json, service, env } = await serve()
    const changes: (string | undefined)[] = []
    service.onHostsChange((change) => { if (change.kind === 'mirror') changes.push(change.dir) })
    const chosen = join(mkdtempSync(join(tmpdir(), 'dsh-repo-chosen-')), 'mirrors')
    let response = await call('/dsh-repo/mirror', json('PUT', { dir: chosen }))
    expect(response.status).toBe(200)
    expect((response.body.state as SettingsState).mirror).toEqual({ dir: chosen })
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'hosts.json'), 'utf8'))).toEqual({ hosts: [], mirrorDir: chosen })
    expect(existsSync(chosen)).toBe(true)

    const reloaded = await serve(undefined, {}, env.DSH_HOME)
    expect(reloaded.service.mirrorSettings().dir).toBe(chosen)

    expect((await call('/dsh-repo/mirror', json('PUT', { dir: 'relative/mirrors' }))).status).toBe(400)
    const forbidden = await call('/dsh-repo/mirror', json('PUT', { dir: join(env.DSH_HOME, 'dsh-repo', 'mirrors') }))
    expect(forbidden.status).toBe(400)
    expect(forbidden.body.error).toContain(env.DSH_HOME)
    expect((await call('/dsh-repo/state')).body).toMatchObject({ mirror: { dir: chosen } })
    response = await call('/dsh-repo/mirror', { method: 'DELETE' })
    expect((response.body.state as SettingsState).mirror).toEqual({})
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'hosts.json'), 'utf8'))).toEqual({ hosts: [] })
    expect(changes).toEqual([chosen, undefined])
  })

  it('reports a stored mirror directory that breaks the rules and refuses the usage listing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-repo-stored-'))
    mkdirSync(join(home, 'dsh-repo'))
    writeFileSync(join(home, 'dsh-repo', 'hosts.json'), `${JSON.stringify({ hosts: [], mirrorDir: join(home, 'dsh-repo', 'mirrors') })}\n`)
    const { call } = await serve(undefined, {}, home)
    const state = (await call('/dsh-repo/state')).body as unknown as SettingsState
    expect(state.mirror.dir).toBeUndefined()
    expect(state.mirror.problem).toContain(join(home, 'dsh-repo', 'mirrors'))
    const usage = await call('/dsh-repo/mirror-usage')
    expect(usage.status).toBe(503)
    expect(usage.body.error).toContain('镜像目录未设置')
  })

  it('saves run-time settings as overrides, applies them at once, and resets them', async () => {
    const { call, json, service, env } = await serve()
    const file = join(env.DSH_HOME, 'dsh-repo', 'hosts.json')
    const initial = (await call('/dsh-repo/state')).body as unknown as SettingsState
    expect(initial.settings).toEqual(initial.defaults)
    expect(initial.file).toBe(file)
    const next = { ...initial.defaults, tools: { ...initial.defaults.tools, writes: 'off' }, limits: { ...initial.defaults.limits, perPage: 20 } }
    let response = await call('/dsh-repo/settings', json('PUT', next))
    expect(response.status).toBe(200)
    expect((response.body.state as SettingsState).settings).toEqual(next)
    expect(service.settings.tools.writes).toBe('off')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hosts: [], settings: { tools: { writes: 'off' }, limits: { perPage: 20 } } })

    expect((await serve(undefined, {}, env.DSH_HOME)).service.settings).toEqual(next)

    const invalid = await call('/dsh-repo/settings', json('PUT', { ...next, timeoutMs: 5 }))
    expect(invalid).toMatchObject({ status: 400, body: { ok: false, error: expect.stringContaining('timeoutMs') } })
    expect(service.settings).toEqual(next)
    response = await call('/dsh-repo/settings', { method: 'DELETE' })
    expect((response.body.state as SettingsState).settings).toEqual(initial.defaults)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hosts: [] })
  })

  it('adds a GitHub Enterprise host with its API address', async () => {
    const { call, json } = await serve()
    const response = await call('/dsh-repo/hosts', json('POST', { kind: 'github', url: 'https://ghe.example.com', apiUrl: 'https://api.ghe.example.com/', alias: 'GHE' }))
    expect((response.body.state as SettingsState).hosts[1]).toMatchObject({ url: 'https://ghe.example.com', apiUrl: 'https://api.ghe.example.com' })
    expect((await call('/dsh-repo/hosts', json('POST', { kind: 'gitlab', url: 'https://g.example.com', apiUrl: 'https://g.example.com/api' }))).status).toBe(400)
  })

  it('opens the Host directory dialog only when it is native', async () => {
    const { call } = await serve()
    expect((await call('/dsh-repo/pick-directory', { method: 'POST' })).status).toBe(409)
    const browse = await serve(undefined, { directoryPicker: { capability: () => ({ kind: 'browse' }) } })
    expect((await browse.call('/dsh-repo/state')).body.pickerAvailable).toBe(false)
    const picks: (string | null)[] = ['/picked/dir', null]
    const native = await serve(undefined, { directoryPicker: { capability: () => ({ kind: 'native', pick: async () => picks.shift() ?? null }) } })
    expect((await native.call('/dsh-repo/state')).body.pickerAvailable).toBe(true)
    expect((await native.call('/dsh-repo/pick-directory', { method: 'POST' })).body).toEqual({ ok: true, path: '/picked/dir' })
    expect((await native.call('/dsh-repo/pick-directory', { method: 'POST' })).body).toEqual({ ok: true, path: null })
  })

  it('lists watched PRs/MRs, stops one on request, and reports whether watching can wake Sessions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-repo-settings-'))
    mkdirSync(join(home, 'dsh-repo'), { recursive: true })
    const watch = {
      id: 'github.com/a/b!5@s1', kind: 'github', host: 'github.com', path: 'a/b', number: 5, title: 'Fix', webUrl: 'https://github.com/a/b/pull/5', session: 's1', source: 'created',
      startedAt: '2026-11-01T00:00:00.000Z', lastActivityAt: '2026-11-01T00:00:00.000Z', ownComments: [], ownHeads: [], wakes: { day: '2026-11-01', count: 0 }, pending: [], dropped: 0, failures: 3, lastError: '检查失败',
    }
    writeFileSync(join(home, 'dsh-repo', 'watches.json'), JSON.stringify({ watches: [watch] }))
    // Watching off: the seeded watch is listed but never polled, so no request leaves the test.
    writeFileSync(join(home, 'dsh-repo', 'hosts.json'), JSON.stringify({ hosts: [], settings: { watch: { enabled: false } } }))
    const { call, json } = await serve(undefined, { sessionController: { resolveAgent: async () => ({ error: new Error('unused') }) } }, home)
    const state = (await call('/dsh-repo/state')).body as unknown as SettingsState
    expect(state.watchAvailable).toBe(false)
    expect(state.watches).toEqual([{ id: watch.id, repo: 'github.com/a/b', number: 5, title: 'Fix', webUrl: watch.webUrl, session: 's1', source: 'created', startedAt: watch.startedAt, lastActivityAt: watch.lastActivityAt, failures: 3, lastError: '检查失败', pending: 0 }])
    expect((await call('/dsh-repo/watches', json('DELETE', { id: 'missing' }))).status).toBe(404)
    const stopped = await call('/dsh-repo/watches', json('DELETE', { id: watch.id }))
    expect((stopped.body.state as SettingsState).watches).toEqual([])
    expect(JSON.parse(readFileSync(join(home, 'dsh-repo', 'watches.json'), 'utf8'))).toEqual({ watches: [] })
    expect(((await (await serve(undefined, { sessionController: {} })).call('/dsh-repo/state')).body as unknown as SettingsState).watchAvailable).toBe(true)
    expect(((await (await serve()).call('/dsh-repo/state')).body as unknown as SettingsState).watchAvailable).toBe(false)
  })

  it('adds, changes, syncs, and removes catalog repositories with their local syncs, and measures the mirror directory', async () => {
    const remote = fileRemote()
    const { url: repo, dir: origin } = remote.repo('team/skills', { 'skill-a/SKILL.md': 'a\n' })
    const author = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    const { call, json, env, service } = await serve(undefined, {}, undefined, remote)
    const file = join(env.DSH_HOME, 'dsh-repo', 'hosts.json')
    const dir = join(env.DSH_HOME, 'shared-skills')
    const changes: number[] = []
    service.onReposChange(() => { changes.push(service.listRepos().length) })
    const dispose = service.registerFeature({ id: 'log-analysis', title: '日志分析' })
    expect(((await call('/dsh-repo/state')).body as unknown as SettingsState).features).toEqual([{ id: 'log-analysis', title: '日志分析' }])

    // Without a mirror directory the entry is stored but its first sync fails with the refusal.
    let response = await call('/dsh-repo/repos', json('POST', { url: repo, access: 'read', features: [], localSync: { enabled: true, dir } }))
    expect(response.status).toBe(200)
    let [row] = (response.body.state as SettingsState).repos
    expect(row).toMatchObject({ url: repo, access: 'read', key: 'git.test/team/skills', sync: { state: 'idle', error: expect.stringContaining('镜像目录未设置') } })
    expect((await call('/dsh-repo/repos', json('DELETE', { id: row?.id }))).status).toBe(200)
    const mirrors = join(mkdtempSync(join(tmpdir(), 'dsh-repo-settings-mirrors-')), 'mirrors')
    expect((await call('/dsh-repo/mirror', json('PUT', { dir: mirrors }))).status).toBe(200)

    response = await call('/dsh-repo/repos', json('POST', { url: repo, access: 'write', features: ['log-analysis'], localSync: { enabled: true, dir } }))
    expect(response.status).toBe(200)
    ;[row] = (response.body.state as SettingsState).repos
    expect(row).toMatchObject({ url: repo, access: 'write', features: ['log-analysis'], localSync: { enabled: true, dir, intervalMinutes: 720 }, sync: { syncedBranch: 'main', state: 'idle' } })
    expect(readFileSync(join(dir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('a\n')
    expect(JSON.parse(readFileSync(file, 'utf8')).repos).toEqual([expect.objectContaining({ id: row?.id, url: repo, access: 'write' })])
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'local-syncs.json'), 'utf8')).syncs).toHaveLength(1)
    expect(service.listRepos({ feature: 'log-analysis' })).toEqual([{ id: row?.id, url: repo, access: 'write', features: ['log-analysis'], localSync: { enabled: true, dir, intervalMinutes: 720 } }])

    writeFileSync(join(origin, 'skill-a', 'SKILL.md'), 'a2\n')
    execFileSync('git', ['commit', '--quiet', '-am', 'two'], { cwd: origin, env: author })
    await call('/dsh-repo/repos/sync', json('POST', { id: row?.id }))
    expect(readFileSync(join(dir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('a2\n')
    response = await call('/dsh-repo/repos', json('PUT', { id: row?.id, url: repo, access: 'merge', features: [], localSync: { enabled: true, dir, intervalMinutes: 60 } }))
    expect((response.body.state as SettingsState).repos[0]).toMatchObject({ access: 'merge', features: [], localSync: { intervalMinutes: 60 } })
    expect(service.listRepos({ feature: 'log-analysis' })).toEqual([])

    expect((await call('/dsh-repo/repos', json('POST', { url: repo, access: 'read', features: [] }))).status).toBe(409)
    expect((await call('/dsh-repo/repos', json('POST', { url: 'git@x:y.git', access: 'read', features: [] }))).status).toBe(400)
    expect((await call('/dsh-repo/repos', json('POST', { url: repo, access: 'admin', features: [] }))).status).toBe(400)
    expect((await call('/dsh-repo/repos', json('PUT', { id: '000000000000', url: repo, access: 'read', features: [] }))).status).toBe(404)
    expect((await call('/dsh-repo/repos/sync', json('POST', { id: 'missing' }))).status).toBe(404)

    const usage = (await call('/dsh-repo/mirror-usage')).body as unknown as MirrorUsage
    expect(usage.root).toBe(mirrors)
    expect(usage.mirrors).toHaveLength(1)
    expect(usage.mirrors[0]).toMatchObject({ path: 'git.test/team/skills.git', url: repo })
    expect(usage.mirrors[0]?.bytes).toBeGreaterThan(0)
    expect(usage.totalBytes).toBeGreaterThanOrEqual(usage.mirrors[0]?.bytes ?? 0)

    response = await call('/dsh-repo/repos', json('DELETE', { id: row?.id }))
    expect((response.body.state as SettingsState).repos).toEqual([])
    expect(existsSync(join(dir, 'skill-a', 'SKILL.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'local-syncs.json'), 'utf8'))).toEqual({ syncs: [] })
    expect((await call('/dsh-repo/repos', json('DELETE', { id: row?.id }))).status).toBe(404)
    expect(changes).toEqual([0, 1, 0, 1, 1, 0])
    dispose()
    expect(((await call('/dsh-repo/state')).body as unknown as SettingsState).features).toEqual([])
  })

  it('reports catalog entries whose host is no longer configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-repo-settings-'))
    mkdirSync(join(home, 'dsh-repo'))
    const entry = { id: 'abcdefabcdef', url: 'https://gone.example.com/a/b', access: 'read', features: ['old-feature'], addedAt: '2026-11-09T00:00:00.000Z' }
    writeFileSync(join(home, 'dsh-repo', 'hosts.json'), JSON.stringify({ hosts: [], repos: [entry] }))
    const { call, service } = await serve(undefined, {}, home)
    const [row] = ((await call('/dsh-repo/state')).body as unknown as SettingsState).repos
    expect(row).toMatchObject({ id: entry.id, url: entry.url, features: ['old-feature'], problem: expect.stringContaining('gone.example.com') })
    expect(row?.key).toBeUndefined()
    expect(() => service.resolve('https://gone.example.com/a/b')).toThrow(expect.objectContaining({ code: 'not-allowed' }))
  })

  it('creates workspaces in the chosen directory, lists them with their unsaved work, and removes them after confirmation', async () => {
    const remote = fileRemote()
    const { url: repo } = remote.repo('team/app')
    const { call, json } = await serve(undefined, {}, undefined, remote)
    const state = async () => (await call('/dsh-repo/state')).body as unknown as SettingsState
    await vi.waitFor(async () => { expect((await state()).workspace.proxyListening).toBeGreaterThan(0) })
    expect((await state()).workspace).toMatchObject({ available: true })
    expect((await call('/dsh-repo/mirror', json('PUT', { dir: mkdtempSync(join(tmpdir(), 'dsh-repo-settings-mirrors-')) }))).status).toBe(200)
    const added = await call('/dsh-repo/repos', json('POST', { url: repo, access: 'write', features: [] }))
    const id = (added.body.state as SettingsState).repos[0]!.id

    // No directory yet: creation is refused and says where to set one.
    expect(await call('/dsh-repo/workspaces', json('POST', { repo: id }))).toMatchObject({ status: 400, body: { error: expect.stringContaining('工作区目录') } })
    const parent = join(mkdtempSync(join(tmpdir(), 'dsh-repo-settings-ws-')), 'nested')
    expect((await call('/dsh-repo/workspace-dir', json('PUT', { dir: 'relative' }))).status).toBe(400)
    const saved = await call('/dsh-repo/workspace-dir', json('PUT', { dir: parent }))
    expect((saved.body.state as SettingsState).workspace.dir).toBe(parent)
    expect(existsSync(parent)).toBe(true)
    expect((await call('/dsh-repo/workspaces')).body).toEqual({ ok: true, workspaces: [] })

    expect((await call('/dsh-repo/workspaces', json('POST', { repo: id, name: '../x' }))).status).toBe(400)
    expect((await call('/dsh-repo/workspaces', json('POST', { repo: '000000000000' }))).status).toBe(404)
    const created = await call('/dsh-repo/workspaces', json('POST', { repo: id, branch: 'fix/a' }))
    expect(created.status).toBe(200)
    const row = created.body.workspace as WorkspaceRow
    const name = 'app'
    expect(row).toMatchObject({ url: repo, repo: 'git.test/team/app', path: join(parent, name), base: 'main', branch: 'fix/a', currentBranch: 'fix/a', uncommittedFiles: 0, unpushed: 0, mrs: [] })
    expect(row).not.toHaveProperty('session')
    expect(readFileSync(join(row.path, 'README.md'), 'utf8')).toBe('hello\n')
    // The default name is taken now, so the next one is numbered.
    const second = (await call('/dsh-repo/workspaces', json('POST', { repo: id }))).body.workspace as WorkspaceRow
    expect(second.path).toBe(join(parent, `${name}-2`))

    writeFileSync(join(row.path, 'a.txt'), 'a\n')
    const listed = (await call('/dsh-repo/workspaces')).body.workspaces as WorkspaceRow[]
    expect(listed.map(item => item.path)).toEqual([row.path, second.path])
    expect(listed[0]).toMatchObject({ uncommittedFiles: 1, unpushed: 0, activityAt: expect.any(String) })
    expect(await call('/dsh-repo/workspaces', json('DELETE', { id: row.id }))).toMatchObject({ status: 409, body: { error: expect.stringContaining('未提交') } })
    expect(existsSync(row.path)).toBe(true)
    const removed = await call('/dsh-repo/workspaces', json('DELETE', { id: row.id, force: true }))
    expect((removed.body.workspaces as WorkspaceRow[]).map(item => item.id)).toEqual([second.id])
    expect(existsSync(row.path)).toBe(false)
    expect((await call('/dsh-repo/workspaces', json('DELETE', { id: row.id }))).status).toBe(404)

    expect(((await call('/dsh-repo/workspace-dir', { method: 'DELETE' })).body.state as SettingsState).workspace).not.toHaveProperty('dir')
  })

  it('removes its routes when the Web server goes away', async () => {
    const { routes, disposers } = await serve()
    expect([...routes.keys()].sort()).toEqual(['/dsh-repo/host-token', '/dsh-repo/hosts', '/dsh-repo/mirror', '/dsh-repo/mirror-usage', '/dsh-repo/pick-directory', '/dsh-repo/repos', '/dsh-repo/repos/sync', '/dsh-repo/settings', '/dsh-repo/state', '/dsh-repo/watches', '/dsh-repo/workspace-dir', '/dsh-repo/workspaces'])
    for (const dispose of disposers) dispose()
    expect(routes.size).toBe(0)
  })
})
