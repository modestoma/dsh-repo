/**
 * 设置页的 HTTP 路由，挂在宿主可选的 `webServer` 上（没有 Web 的组合不挂载）。
 * 每个请求先经宿主 `connection.requestRejection`（与 DSH `/api` 相同的
 * Host/Origin 校验和登录 cookie 鉴权）；写操作另做同源校验。
 *
 * @module dsh-repo/settings/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { RepoErrorCode } from '../contract.ts'
import { RepoError } from '../errors.ts'
import type { HostContext, HostRequestGate, HostWebServer } from '../host.ts'
import type { RepoService } from '../service.ts'
import type { DirectoryPicker } from './directory-picker.ts'
import { hostDirectoryPicker } from './directory-picker.ts'
import type { WorkspacePanel } from '../workspace/panel.ts'
import { HOST_TOKEN_ROUTE, HOSTS_ROUTE, MIRROR_ROUTE, MIRROR_USAGE_ROUTE, PICK_DIRECTORY_ROUTE, REPO_SYNC_ROUTE, REPOS_ROUTE, SETTINGS_ROUTE, STATE_ROUTE, WATCHES_ROUTE, WORKSPACE_DIR_ROUTE, WORKSPACES_ROUTE } from './contract.ts'
import type { LocalSyncStatus, RepoInput, RepoRow, SettingsState, WatchInfo, WorkspaceCreateInput } from './contract.ts'

type WebHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Request body cap: every settings payload is small. */
const MAX_BODY_BYTES = 64 * 1024

const hostAddSchema = z.object({
  kind: z.enum(['github', 'gitlab']).optional(),
  url: z.string(),
  apiUrl: z.string().optional(),
  alias: z.string().optional(),
  token: z.string().optional(),
}).strict()
const hostUrlSchema = z.object({ url: z.string() }).strict()
const hostTokenSchema = z.object({ url: z.string(), value: z.string() }).strict()
const mirrorSchema = z.object({ dir: z.string() }).strict()
const watchIdSchema = z.object({ id: z.string() }).strict()
const workspaceCreateSchema = z.object({ repo: z.string(), base: z.string().optional(), branch: z.string().optional(), name: z.string().optional() }).strict()
const workspaceRemoveSchema = z.object({ id: z.string(), force: z.boolean().optional() }).strict()

/** The PR/MR watcher as the settings page uses it. */
export interface WatchList {
  /** @returns whether watching is on and this composition can start a turn of a Session. */
  readonly active: boolean
  list(): WatchInfo[]
  remove(id: string): Promise<boolean>
}

/** No watcher: nothing is watched. */
const NO_WATCHES: WatchList = { active: false, list: () => [], remove: async () => false }

const repoFields = {
  url: z.string(),
  branch: z.string().optional(),
  access: z.enum(['read', 'write', 'merge']),
  features: z.array(z.string()),
  localSync: z.object({ enabled: z.boolean(), dir: z.string(), intervalMinutes: z.number().optional() }).strict().optional(),
}
const repoAddSchema = z.object(repoFields).strict()
const repoUpdateSchema = z.object({ id: z.string(), ...repoFields }).strict()
const repoIdSchema = z.object({ id: z.string() }).strict()

/** No workspaces: none are listed, and creating one is refused. */
const NO_WORKSPACES: WorkspacePanel = {
  dir: () => undefined,
  setDir: async () => { throw new HttpError(404, '当前组合没有工作区') },
  proxyPort: () => undefined,
  rows: async () => [],
  create: async () => { throw new HttpError(404, '当前组合没有工作区') },
  remove: async () => { throw new HttpError(404, '当前组合没有工作区') },
}

function workspaceInput(body: z.output<typeof workspaceCreateSchema>): WorkspaceCreateInput {
  return {
    repo: body.repo,
    ...body.base === undefined ? {} : { base: body.base },
    ...body.branch === undefined ? {} : { branch: body.branch },
    ...body.name === undefined ? {} : { name: body.name },
  }
}

/** The local syncs as the settings page uses them. */
export interface SyncList {
  /** @returns the status of a repository's enabled local sync, or undefined. */
  status(id: string): LocalSyncStatus | undefined
  /** Sync now; resolves when the attempt finished. */
  syncNow(id: string): Promise<void>
  /** @returns once the sync, or the deletion of a removed repository's progress, that a catalog change started finished. */
  settled(id: string): Promise<void>
}

/** No syncer: nothing is synced, and syncing on demand is refused. */
const NO_SYNCS: SyncList = {
  status: () => undefined,
  syncNow: async () => { throw new HttpError(404, '当前组合没有本地同步') },
  settled: async () => undefined,
}

function repoInput(body: z.output<typeof repoAddSchema>): RepoInput {
  const { localSync } = body
  return {
    url: body.url,
    ...body.branch === undefined ? {} : { branch: body.branch },
    access: body.access,
    features: body.features,
    ...localSync === undefined ? {} : { localSync: { enabled: localSync.enabled, dir: localSync.dir, ...localSync.intervalMinutes === undefined ? {} : { intervalMinutes: localSync.intervalMinutes } } },
  }
}

/**
 * The settings page's rows of the catalog.
 * @param service - the `dshRepos` implementation.
 * @param syncs - the local syncs.
 * @returns every entry with its key or problem and its local sync status.
 */
export function repoRows(service: RepoService, syncs: SyncList = NO_SYNCS): RepoRow[] {
  return service.catalog.entries().map((entry) => {
    const own = service.catalog.keyOf(entry)
    const sync = syncs.status(entry.id)
    return {
      id: entry.id,
      url: entry.url,
      ...entry.branch === undefined ? {} : { branch: entry.branch },
      access: entry.access,
      features: [...entry.features],
      ...entry.localSync === undefined ? {} : { localSync: { ...entry.localSync } },
      addedAt: entry.addedAt,
      ...'key' in own ? { key: own.key.startsWith('local:') ? own.key.slice('local:'.length) : own.key } : { problem: own.problem },
      ...sync === undefined ? {} : { sync },
    }
  })
}

/** The service validates the settings fields and reports every bad one. */
const settingsBodySchema = z.record(z.string(), z.unknown())

/** HTTP status of each service failure the routes can surface. */
const STATUS: Readonly<Record<RepoErrorCode, number>> = {
  'invalid': 400,
  'not-allowed': 403,
  'unauthenticated': 401,
  'forbidden': 403,
  'not-found': 404,
  'conflict': 409,
  'declined': 403,
  'rate-limited': 429,
  'too-large': 413,
  'unavailable': 503,
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Mutating requests must come from the same origin. A missing Origin (curl and
 * other non-browser local clients) is allowed; a mismatched one is refused.
 * @param req - incoming request.
 * @returns whether the write is same-origin.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    // An unparsable Origin is not this origin.
    return false
  }
}

async function readJsonBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, '请求体为空')
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, '请求体必须是 application/json')
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // The parse error position is not useful to the page.
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, `请求体不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
  return parsed.data
}

function guarded(gate: HostRequestGate, methods: readonly string[], handler: WebHandler): WebHandler {
  return async (req, res) => {
    const rejection = gate.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { ok: false, error: rejection === 401 ? '未登录 DSH，请从 DSH 启动链接打开页面' : '请求来源不受信任' })
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    if (!methods.includes(method)) {
      res.setHeader('allow', methods.join(', '))
      sendJson(res, 405, { ok: false, error: `方法 ${method} 不受支持` })
      return
    }
    if (method !== 'GET' && !isSameOriginRequest(req)) {
      sendJson(res, 403, { ok: false, error: '跨站写入被拒绝（Origin 与 Host 不一致）' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) sendJson(res, error.status, { ok: false, error: error.message })
      else if (error instanceof RepoError) sendJson(res, STATUS[error.code], { ok: false, error: error.message })
      else sendJson(res, 500, { ok: false, error: `内部错误：${error instanceof Error ? error.message : String(error)}` })
    }
  }
}

/**
 * The settings page's view of the service.
 * @param service - the `dshRepos` implementation.
 * @param picker - the Host's directory dialog.
 * @param watches - the PR/MR watcher.
 * @param syncs - the local syncs.
 * @param workspaces - the workspaces.
 * @returns hosts with token status, the mirror directory, the run-time settings with their defaults, the settings file, whether a directory dialog is available, the watched PRs/MRs, the catalog with local sync status, the registered features, and the workspace directory and proxy port.
 */
export async function settingsState(service: RepoService, picker: DirectoryPicker, watches: WatchList = NO_WATCHES, syncs: SyncList = NO_SYNCS, workspaces: WorkspacePanel = NO_WORKSPACES): Promise<SettingsState> {
  const dir = workspaces.dir()
  const listening = workspaces.proxyPort()
  return {
    hosts: await service.listHosts(),
    mirror: service.mirrorSettings(),
    settings: service.settings,
    defaults: service.defaultSettings,
    file: service.settingsFile,
    pickerAvailable: picker.available,
    watches: watches.list(),
    watchAvailable: watches.active,
    repos: repoRows(service, syncs),
    features: service.catalog.registeredFeatures(),
    workspace: {
      available: workspaces !== NO_WORKSPACES,
      ...dir === undefined ? {} : { dir },
      ...listening === undefined ? {} : { proxyListening: listening },
    },
  }
}

/**
 * Register the settings routes.
 * @param server - host web server.
 * @param gate - host request gate.
 * @param service - the `dshRepos` implementation.
 * @param picker - the Host's directory dialog.
 * @param watches - the PR/MR watcher.
 * @param syncs - the local syncs.
 * @param workspaces - the workspaces.
 * @returns disposer removing every route.
 */
export function registerSettingsRoutes(server: HostWebServer, gate: HostRequestGate, service: RepoService, picker: DirectoryPicker, watches: WatchList = NO_WATCHES, syncs: SyncList = NO_SYNCS, workspaces: WorkspacePanel = NO_WORKSPACES): () => void {
  const state = (): Promise<SettingsState> => settingsState(service, picker, watches, syncs, workspaces)
  const reply = async (res: ServerResponse): Promise<void> => { sendJson(res, 200, { ok: true, state: await state() }) }
  const disposers = [
    server.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: guarded(gate, ['GET'], async (_req, res) => { sendJson(res, 200, await state()) }),
    }),
    server.register({
      kind: 'exact',
      path: HOSTS_ROUTE,
      handler: guarded(gate, ['POST', 'DELETE'], async (req, res) => {
        if (req.method?.toUpperCase() === 'DELETE') {
          await service.removeHost((await readJsonBody(req, hostUrlSchema)).url)
        } else {
          const { kind, url, apiUrl, alias, token } = await readJsonBody(req, hostAddSchema)
          await service.addHost({ url, ...kind === undefined ? {} : { kind }, ...apiUrl === undefined ? {} : { apiUrl }, ...alias === undefined ? {} : { alias }, ...token === undefined ? {} : { token } })
        }
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: HOST_TOKEN_ROUTE,
      handler: guarded(gate, ['PUT', 'DELETE'], async (req, res) => {
        if (req.method?.toUpperCase() === 'DELETE') {
          await service.setHostToken((await readJsonBody(req, hostUrlSchema)).url, undefined)
        } else {
          const { url, value } = await readJsonBody(req, hostTokenSchema)
          await service.setHostToken(url, value)
        }
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: MIRROR_ROUTE,
      handler: guarded(gate, ['PUT', 'DELETE'], async (req, res) => {
        await service.setMirrorDir(req.method?.toUpperCase() === 'DELETE' ? undefined : (await readJsonBody(req, mirrorSchema)).dir)
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: guarded(gate, ['PUT', 'DELETE'], async (req, res) => {
        await service.updateSettings(req.method?.toUpperCase() === 'DELETE' ? undefined : await readJsonBody(req, settingsBodySchema))
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: WATCHES_ROUTE,
      handler: guarded(gate, ['DELETE'], async (req, res) => {
        if (!await watches.remove((await readJsonBody(req, watchIdSchema)).id)) throw new HttpError(404, '没有这个跟踪，可能已经结束')
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: REPOS_ROUTE,
      handler: guarded(gate, ['POST', 'PUT', 'DELETE'], async (req, res) => {
        const method = req.method?.toUpperCase()
        if (method === 'DELETE') {
          const { id } = await readJsonBody(req, repoIdSchema)
          if (await service.catalog.remove(id) === undefined) throw new HttpError(404, '仓库清单中没有这个仓库，可能已经删除')
          await syncs.settled(id)
        } else {
          const entry = method === 'PUT'
            ? await (async () => {
              const { id, ...body } = await readJsonBody(req, repoUpdateSchema)
              return await service.catalog.update(id, repoInput(body))
            })()
            : await service.catalog.add(repoInput(await readJsonBody(req, repoAddSchema)))
          await syncs.settled(entry.id)
        }
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: REPO_SYNC_ROUTE,
      handler: guarded(gate, ['POST'], async (req, res) => {
        await syncs.syncNow((await readJsonBody(req, repoIdSchema)).id)
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: WORKSPACES_ROUTE,
      handler: guarded(gate, ['GET', 'POST', 'DELETE'], async (req, res) => {
        const method = req.method?.toUpperCase()
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, workspaces: await workspaces.rows() })
        } else if (method === 'POST') {
          sendJson(res, 200, { ok: true, workspace: await workspaces.create(workspaceInput(await readJsonBody(req, workspaceCreateSchema))) })
        } else {
          const { id, force } = await readJsonBody(req, workspaceRemoveSchema)
          await workspaces.remove(id, force === true)
          sendJson(res, 200, { ok: true, workspaces: await workspaces.rows() })
        }
      }),
    }),
    server.register({
      kind: 'exact',
      path: WORKSPACE_DIR_ROUTE,
      handler: guarded(gate, ['PUT', 'DELETE'], async (req, res) => {
        await workspaces.setDir(req.method?.toUpperCase() === 'DELETE' ? undefined : (await readJsonBody(req, mirrorSchema)).dir)
        await reply(res)
      }),
    }),
    server.register({
      kind: 'exact',
      path: MIRROR_USAGE_ROUTE,
      handler: guarded(gate, ['GET'], async (_req, res) => { sendJson(res, 200, await service.mirrorUsage()) }),
    }),
    server.register({
      kind: 'exact',
      path: PICK_DIRECTORY_ROUTE,
      handler: guarded(gate, ['POST'], async (req, res) => {
        const abort = new AbortController()
        const onClose = (): void => { abort.abort() }
        res.on('close', onClose)
        try {
          sendJson(res, 200, { ok: true, path: await picker.pick(abort.signal) })
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : String(error))
        } finally {
          res.off('close', onClose)
        }
      }),
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Mount the routes while both `webServer` and `connection` are available.
 * @param ctx - plugin context.
 * @param service - the `dshRepos` implementation.
 * @param watches - the PR/MR watcher.
 * @param syncs - the local syncs.
 * @param workspaces - the workspaces.
 */
export function mountSettingsRoutes(ctx: HostContext, service: RepoService, watches: WatchList = NO_WATCHES, syncs: SyncList = NO_SYNCS, workspaces: WorkspacePanel = NO_WORKSPACES): void {
  const attach = (webCtx: HostContext): void => {
    const server = webCtx.get?.('webServer') as HostWebServer | undefined
    const gate = webCtx.get?.('connection') as HostRequestGate | undefined
    if (server === undefined || gate === undefined) return
    webCtx.effect(() => registerSettingsRoutes(server, gate, service, hostDirectoryPicker(webCtx), watches, syncs, workspaces), 'dsh-repo: settings routes')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], attach)
    return
  }
  attach(ctx)
}
