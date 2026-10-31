/**
 * 插件页设置的 HTTP 路由，挂在宿主可选的 `webServer` 上（没有 Web 的组合不挂载）。
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
import { HOST_TOKEN_ROUTE, HOSTS_ROUTE, MIRROR_ROUTE, PICK_DIRECTORY_ROUTE, STATE_ROUTE } from './contract.ts'
import type { SettingsState } from './contract.ts'

type WebHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Request body cap: every settings payload is small. */
const MAX_BODY_BYTES = 64 * 1024

const hostAddSchema = z.object({
  kind: z.enum(['github', 'gitlab']).optional(),
  url: z.string(),
  alias: z.string().optional(),
  token: z.string().optional(),
}).strict()
const hostUrlSchema = z.object({ url: z.string() }).strict()
const hostTokenSchema = z.object({ url: z.string(), value: z.string() }).strict()
const mirrorSchema = z.object({ dir: z.string() }).strict()

/** HTTP status of each service failure the routes can surface. */
const STATUS: Readonly<Record<RepoErrorCode, number>> = {
  'invalid': 400,
  'not-allowed': 403,
  'unauthenticated': 401,
  'forbidden': 403,
  'not-found': 404,
  'conflict': 409,
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
 * @returns hosts with token status, the mirror directory, and whether a directory dialog is available.
 */
export async function settingsState(service: RepoService, picker: DirectoryPicker): Promise<SettingsState> {
  return { hosts: await service.listHosts(), mirror: service.mirrorSettings(), pickerAvailable: picker.available }
}

/**
 * Register the settings routes.
 * @param server - host web server.
 * @param gate - host request gate.
 * @param service - the `dshRepos` implementation.
 * @param picker - the Host's directory dialog.
 * @returns disposer removing every route.
 */
export function registerSettingsRoutes(server: HostWebServer, gate: HostRequestGate, service: RepoService, picker: DirectoryPicker): () => void {
  const reply = async (res: ServerResponse): Promise<void> => { sendJson(res, 200, { ok: true, state: await settingsState(service, picker) }) }
  const disposers = [
    server.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: guarded(gate, ['GET'], async (_req, res) => { sendJson(res, 200, await settingsState(service, picker)) }),
    }),
    server.register({
      kind: 'exact',
      path: HOSTS_ROUTE,
      handler: guarded(gate, ['POST', 'DELETE'], async (req, res) => {
        if (req.method?.toUpperCase() === 'DELETE') {
          await service.removeHost((await readJsonBody(req, hostUrlSchema)).url)
        } else {
          const { kind, url, alias, token } = await readJsonBody(req, hostAddSchema)
          await service.addHost({ url, ...kind === undefined ? {} : { kind }, ...alias === undefined ? {} : { alias }, ...token === undefined ? {} : { token } })
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
 */
export function mountSettingsRoutes(ctx: HostContext, service: RepoService): void {
  const attach = (webCtx: HostContext): void => {
    const server = webCtx.get?.('webServer') as HostWebServer | undefined
    const gate = webCtx.get?.('connection') as HostRequestGate | undefined
    if (server === undefined || gate === undefined) return
    webCtx.effect(() => registerSettingsRoutes(server, gate, service, hostDirectoryPicker(webCtx)), 'dsh-repo: settings routes')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], attach)
    return
  }
  attach(ctx)
}
