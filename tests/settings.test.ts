import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostContext, HostWebServer } from '../src/host.ts'
import * as plugin from '../src/index.ts'
import type { RepoService } from '../src/service.ts'
import type { SettingsState } from '../src/settings/contract.ts'
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

  it('removes its routes when the Web server goes away', async () => {
    const { routes, disposers } = await serve()
    expect([...routes.keys()].sort()).toEqual(['/dsh-repo/host-token', '/dsh-repo/hosts', '/dsh-repo/mirror', '/dsh-repo/pick-directory', '/dsh-repo/state'])
    for (const dispose of disposers) dispose()
    expect(routes.size).toBe(0)
  })
})
