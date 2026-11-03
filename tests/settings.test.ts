import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostContext, HostWebServer } from '../src/host.ts'
import * as plugin from '../src/index.ts'
import type { RepoService } from '../src/service.ts'
import type { MirrorUsage, SettingsState } from '../src/settings/contract.ts'
import { credentials } from './helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const servers: { close(): void }[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

/** Apply the plugin with a Web server whose routes are served on a real port. */
async function serve(rejection?: 401 | 403, extra: Record<string, unknown> = {}, home?: string) {
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
    credentials: credentials({ GITHUB_TOKEN: 'gh' }),
    provide: (name, value) => { provided.set(name, value) },
    get: name => services[name],
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject: (names, callback) => { if (names.every(name => services[name] !== undefined)) callback(ctx) },
  }
  const env = { DSH_HOME: home ?? mkdtempSync(join(tmpdir(), 'dsh-repo-settings-')) }
  plugin.apply(ctx, { hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' }] }, { env })
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
  return { call, json, routes, disposers, service: provided.get('dshRepos') as RepoService, env, base }
}

describe('settings routes', () => {
  it('reports hosts with token status and the mirror directory', async () => {
    const { call, env } = await serve()
    const { status, body } = await call('/dsh-repo/state')
    expect(status).toBe(200)
    const state = body as unknown as SettingsState
    expect(state.mirror).toEqual({ dir: join(env.DSH_HOME, 'dsh-repo', 'mirrors'), defaultDir: join(env.DSH_HOME, 'dsh-repo', 'mirrors') })
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

  it('moves the mirror directory, keeps the choice in hosts.json, and returns to the default', async () => {
    const { call, json, service, env } = await serve()
    const changes: string[] = []
    service.onHostsChange((change) => { if (change.kind === 'mirror') changes.push(change.dir) })
    const chosen = join(env.DSH_HOME, 'elsewhere', 'mirrors')
    let response = await call('/dsh-repo/mirror', json('PUT', { dir: chosen }))
    expect(response.status).toBe(200)
    expect((response.body.state as SettingsState).mirror.dir).toBe(chosen)
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'hosts.json'), 'utf8'))).toEqual({ hosts: [], mirrorDir: chosen })
    expect(existsSync(chosen)).toBe(true)

    const reloaded = await serve(undefined, {}, env.DSH_HOME)
    expect(reloaded.service.mirrorSettings().dir).toBe(chosen)

    expect((await call('/dsh-repo/mirror', json('PUT', { dir: 'relative/mirrors' }))).status).toBe(400)
    response = await call('/dsh-repo/mirror', { method: 'DELETE' })
    expect((response.body.state as SettingsState).mirror.dir).toBe(join(env.DSH_HOME, 'dsh-repo', 'mirrors'))
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'hosts.json'), 'utf8'))).toEqual({ hosts: [] })
    expect(changes).toEqual([chosen, join(env.DSH_HOME, 'dsh-repo', 'mirrors')])
  })

  it('saves run-time settings as overrides, applies them at once, and resets them', async () => {
    const { call, json, service, env } = await serve()
    const file = join(env.DSH_HOME, 'dsh-repo', 'hosts.json')
    const initial = (await call('/dsh-repo/state')).body as unknown as SettingsState
    expect(initial.settings).toEqual(initial.defaults)
    expect(initial.file).toBe(file)
    const next = { ...initial.defaults, repos: ['github.com/modestoma/*'], tools: { ...initial.defaults.tools, writes: 'off' }, limits: { ...initial.defaults.limits, perPage: 20 } }
    let response = await call('/dsh-repo/settings', json('PUT', next))
    expect(response.status).toBe(200)
    expect((response.body.state as SettingsState).settings).toEqual(next)
    expect(service.settings.tools.writes).toBe('off')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hosts: [], settings: { repos: ['github.com/modestoma/*'], tools: { writes: 'off' }, limits: { perPage: 20 } } })
    expect(() => service.resolve('github.com/other/repo')).toThrow(expect.objectContaining({ code: 'not-allowed' }))

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

  it('adds, syncs, changes, and removes local syncs, and measures the mirror directory', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-repo-settings-origin-'))
    const author = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo })
    mkdirSync(join(repo, 'skill-a'))
    writeFileSync(join(repo, 'skill-a', 'SKILL.md'), 'a\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: repo, env: author })
    const { call, json, env } = await serve()
    const dir = join(env.DSH_HOME, 'shared-skills')

    let response = await call('/dsh-repo/syncs', json('POST', { url: repo, dir }))
    expect(response.status).toBe(200)
    const [added] = (response.body.state as SettingsState).syncs
    expect(added).toMatchObject({ url: repo, dir, intervalMinutes: 720, syncedBranch: 'main', state: 'idle' })
    expect(readFileSync(join(dir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('a\n')
    expect(JSON.parse(readFileSync(join(env.DSH_HOME, 'dsh-repo', 'syncs.json'), 'utf8')).syncs).toHaveLength(1)

    writeFileSync(join(repo, 'skill-a', 'SKILL.md'), 'a2\n')
    execFileSync('git', ['commit', '--quiet', '-am', 'two'], { cwd: repo, env: author })
    response = await call('/dsh-repo/syncs/run', json('POST', { id: added?.id }))
    expect(readFileSync(join(dir, 'skill-a', 'SKILL.md'), 'utf8')).toBe('a2\n')
    response = await call('/dsh-repo/syncs', json('PUT', { id: added?.id, url: repo, dir, intervalMinutes: 60 }))
    expect((response.body.state as SettingsState).syncs[0]?.intervalMinutes).toBe(60)

    expect((await call('/dsh-repo/syncs', json('POST', { url: repo, dir: join(dir, 'inner') }))).status).toBe(409)
    expect((await call('/dsh-repo/syncs', json('POST', { url: 'git@x:y.git', dir: join(env.DSH_HOME, 'x') }))).status).toBe(400)
    expect((await call('/dsh-repo/syncs/run', json('POST', { id: 'missing' }))).status).toBe(404)

    const usage = (await call('/dsh-repo/mirror-usage')).body as unknown as MirrorUsage
    expect(usage.root).toBe(join(env.DSH_HOME, 'dsh-repo', 'mirrors'))
    expect(usage.mirrors).toHaveLength(1)
    expect(usage.mirrors[0]).toMatchObject({ path: expect.stringMatching(/^local\//), url: repo })
    expect(usage.mirrors[0]?.bytes).toBeGreaterThan(0)
    expect(usage.totalBytes).toBeGreaterThanOrEqual(usage.mirrors[0]?.bytes ?? 0)

    response = await call('/dsh-repo/syncs', json('DELETE', { id: added?.id }))
    expect((response.body.state as SettingsState).syncs).toEqual([])
    expect(existsSync(join(dir, 'skill-a', 'SKILL.md'))).toBe(true)
    expect((await call('/dsh-repo/syncs', json('DELETE', { id: added?.id }))).status).toBe(404)
  })

  it('removes its routes when the Web server goes away', async () => {
    const { routes, disposers } = await serve()
    expect([...routes.keys()].sort()).toEqual(['/dsh-repo/host-token', '/dsh-repo/hosts', '/dsh-repo/mirror', '/dsh-repo/mirror-usage', '/dsh-repo/pick-directory', '/dsh-repo/settings', '/dsh-repo/state', '/dsh-repo/syncs', '/dsh-repo/syncs/run', '/dsh-repo/watches'])
    for (const dispose of disposers) dispose()
    expect(routes.size).toBe(0)
  })
})
