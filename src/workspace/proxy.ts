/**
 * The local git proxy: an HTTP server on 127.0.0.1 that every workspace's
 * `origin` is rewritten to. It holds no token in any workspace: a workspace
 * proves itself with its own secret, and the proxy adds the host token only
 * on the requests it forwards.
 *
 * - Fetch and clone (`git-upload-pack`) are served from the repository's
 *   mirror, which is fetched from the remote first, by `git http-backend`.
 *   Needs catalog access `read`.
 * - Push (`git-receive-pack`) is forwarded to the remote with the host's
 *   token after the write policy (`dsh-repo/policy`) allowed its commands:
 *   writes on, catalog access `write`, only branches (`refs/heads/*`), never
 *   the default or a protected branch, no deletions; non-fast-forward
 *   updates of other branches are allowed. It also needs, for a workspace a
 *   Session created, an `access/authorize` grant
 *   (`code-write`) for that Session. A refused push is answered in git's own
 *   report format, so `git push` prints the reason per branch. After the
 *   remote accepted it, the mirror is fetched before the answer is returned.
 *
 * @module dsh-repo/workspace/proxy
 */

import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { basename, dirname } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { RepoError } from '../errors.ts'
import { authorize } from '../events.ts'
import type { ParallelDispatch } from '../events.ts'
import type { HostLogger } from '../host.ts'
import { gitEnvironment } from '../mirror/git.ts'
import type { RepoService } from '../service.ts'
import type { WorkspaceRecord, WorkspaceRegistry } from './registry.ts'

/** Collaborators of the proxy. */
export interface GitProxyDeps {
  readonly service: RepoService
  readonly registry: WorkspaceRegistry
  /** `ctx.parallel` for `access/authorize`; absent means no listeners. */
  readonly parallel?: ParallelDispatch
  /** Runs after the remote accepted a push, with the branches its report lists as updated. */
  readonly onPushed?: (record: WorkspaceRecord, branches: readonly string[]) => void
  readonly logger?: HostLogger
  /** HTTP client of the requests forwarded to the remote; default: the global `fetch`. */
  readonly fetch?: typeof fetch
}

/** One command of a push. */
interface PushCommand {
  readonly old: string
  readonly new: string
  readonly ref: string
}

/** Largest command section of a push read before the pack data. */
const MAX_COMMAND_BYTES = 1024 * 1024

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data])
}

/**
 * Read a push request up to the flush packet that ends its commands.
 * @param body - the uncompressed request body.
 * @returns the commands, the client's capabilities, the bytes read, and the rest of the body.
 * @throws {RepoError} `invalid` for a malformed or oversized command section or a signed push.
 */
async function readCommands(body: Readable): Promise<{ commands: PushCommand[]; capabilities: string[]; head: Buffer; rest: Readable }> {
  const chunks: Buffer[] = []
  let size = 0
  const iterator = body[Symbol.asyncIterator]()
  for (;;) {
    const buffer = Buffer.concat(chunks)
    const parsed = parseCommands(buffer)
    if (parsed !== undefined) {
      const head = buffer.subarray(0, parsed.end)
      const leftover = buffer.subarray(parsed.end)
      const rest = Readable.from((async function* () {
        if (leftover.length > 0) yield leftover
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) return
          yield next.value as Buffer
        }
      })())
      return { commands: parsed.commands, capabilities: parsed.capabilities, head, rest }
    }
    if (size > MAX_COMMAND_BYTES) throw new RepoError('invalid', '推送请求的命令部分过大')
    const next = await iterator.next()
    if (next.done === true) throw new RepoError('invalid', '推送请求不完整')
    const chunk = next.value as Buffer
    chunks.push(chunk)
    size += chunk.length
  }
}

/** The commands of a buffered push request, or undefined while its flush packet has not arrived. */
function parseCommands(buffer: Buffer): { commands: PushCommand[]; capabilities: string[]; end: number } | undefined {
  const commands: PushCommand[] = []
  let capabilities: string[] = []
  let offset = 0
  for (;;) {
    if (buffer.length < offset + 4) return undefined
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16)
    if (Number.isNaN(length)) throw new RepoError('invalid', '推送请求格式不对')
    if (length === 0) return { commands, capabilities, end: offset + 4 }
    if (length < 4) throw new RepoError('invalid', '推送请求格式不对')
    if (buffer.length < offset + length) return undefined
    let line = buffer.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '')
    offset += length
    if (line.startsWith('shallow ')) continue
    if (line.startsWith('push-cert')) throw new RepoError('invalid', 'dsh-repo 不支持签名推送（--signed）')
    const nul = line.indexOf('\0')
    if (nul >= 0) {
      if (commands.length === 0) capabilities = line.slice(nul + 1).split(' ').filter(word => word !== '')
      line = line.slice(0, nul)
    }
    const [old = '', next = '', ref = ''] = line.split(' ')
    commands.push({ old, new: next, ref })
  }
}

/** A push answered in git's report format with every command rejected for `reason`. */
function rejection(commands: readonly PushCommand[], capabilities: readonly string[], reason: string): Buffer {
  const line = reason.replace(/[\r\n]+/g, ' ')
  const report = Buffer.concat([pktLine('unpack ok\n'), ...commands.map(command => pktLine(`ng ${command.ref} dsh-repo: ${line}\n`)), Buffer.from('0000')])
  if (!capabilities.includes('side-band-64k') && !capabilities.includes('side-band')) return report
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0000')])
}

/**
 * Split pkt-lines up to the first flush packet.
 * @param data - pkt-line encoded bytes.
 * @returns the payloads, or undefined when the data is not pkt-line encoded.
 */
function pktLines(data: Buffer): Buffer[] | undefined {
  const lines: Buffer[] = []
  let offset = 0
  while (offset + 4 <= data.length) {
    const length = Number.parseInt(data.subarray(offset, offset + 4).toString('ascii'), 16)
    if (Number.isNaN(length) || (length > 0 && length < 4) || offset + length > data.length) return undefined
    if (length === 0) return lines
    lines.push(data.subarray(offset + 4, offset + length))
    offset += length
  }
  return lines
}

/**
 * The refs a remote reported as updated in a receive-pack answer.
 * @param answer - the remote's `git-receive-pack` response body.
 * @param commands - the push's ref updates.
 * @param capabilities - the client's capabilities, which select side-band and the report.
 * @returns the updated refs; every command when the client asked for no report, none when the answer cannot be read.
 */
function acceptedRefs(answer: Buffer, commands: readonly PushCommand[], capabilities: readonly string[]): string[] {
  if (!capabilities.includes('report-status') && !capabilities.includes('report-status-v2')) return commands.map(command => command.ref)
  let report: Buffer | undefined = answer
  if (capabilities.includes('side-band-64k') || capabilities.includes('side-band')) {
    const packets = pktLines(answer)
    report = packets === undefined ? undefined : Buffer.concat(packets.filter(packet => packet[0] === 1).map(packet => packet.subarray(1)))
  }
  const lines = report === undefined ? undefined : pktLines(report)?.map(line => line.toString('utf8').replace(/\n$/, ''))
  if (lines === undefined || lines[0] !== 'unpack ok') return []
  return lines.filter(line => line.startsWith('ok ')).map(line => line.slice(3))
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', ...headers })
  res.end(`${text}\n`)
}

/** Status for a refused request; git prints a `text/plain` body as `remote: …`. */
function statusOf(error: RepoError): number {
  switch (error.code) {
    case 'not-allowed':
    case 'forbidden':
      return 403
    case 'not-found':
      return 404
    case 'invalid':
      return 400
    default:
      return 502
  }
}

/** The local git proxy. */
export class GitProxy {
  private server: Server | undefined
  private listening: number | undefined

  private readonly fetch: typeof fetch

  /** @param deps - engine, registry, event dispatch, the push hook, and the HTTP client. */
  constructor(private readonly deps: GitProxyDeps) {
    this.fetch = deps.fetch ?? (async (input, init) => await fetch(input, init))
  }

  /** @returns the port the proxy listens on, or undefined while it is stopped. */
  get port(): number | undefined {
    return this.listening
  }

  /**
   * Listen on 127.0.0.1, replacing the current listener only once the new one listens.
   * @param port - port to listen on; 0 picks a free one.
   * @returns the port listened on.
   * @throws the listen error, e.g. `EADDRINUSE`; the current listener, if any, keeps running.
   */
  async start(port: number): Promise<number> {
    if (this.server !== undefined && port !== 0 && port === this.listening) return port
    const server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (error) => { this.deps.logger?.error?.('dsh-repo: 本机 git 代理出错：%s', error.message) })
    await this.stop()
    this.server = server
    const address = server.address()
    this.listening = typeof address === 'object' && address !== null ? address.port : port
    return this.listening
  }

  /** Stop listening and close open connections. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.listening = undefined
    if (server === undefined) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const match = /^\/w\/([0-9a-f]{16})\/(.*)$/.exec(url.pathname)
      const record = match === null ? undefined : this.deps.registry.get(match[1] ?? '')
      if (match === null || record === undefined) {
        sendText(res, 404, 'dsh-repo: 没有这个工作区')
        return
      }
      if (!this.authenticated(req, record)) {
        sendText(res, 401, 'dsh-repo: 需要工作区凭据', { 'www-authenticate': 'Basic realm="dsh-repo"' })
        return
      }
      const rest = match[2] ?? ''
      const service = url.searchParams.get('service')
      const method = req.method?.toUpperCase()
      if (method === 'GET' && /(?:^|\/)info\/refs$/.test(rest) && service === 'git-upload-pack') await this.advertiseUpload(req, res, record, url.search.slice(1))
      else if (method === 'POST' && /(?:^|\/)git-upload-pack$/.test(rest)) await this.upload(req, res, record)
      else if (method === 'GET' && /(?:^|\/)info\/refs$/.test(rest) && service === 'git-receive-pack') await this.advertiseReceive(req, res, record, url.search.slice(1))
      else if (method === 'POST' && /(?:^|\/)git-receive-pack$/.test(rest)) await this.receive(req, res, record)
      else sendText(res, 404, 'dsh-repo: 代理只支持 git 的智能 HTTP 协议')
    } catch (error) {
      const failure = error instanceof RepoError ? error : new RepoError('unavailable', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) sendText(res, statusOf(failure), `dsh-repo: ${failure.message}`)
      else res.destroy()
    }
  }

  private authenticated(req: IncomingMessage, record: WorkspaceRecord): boolean {
    const header = req.headers.authorization
    if (header === undefined || !header.startsWith('Basic ')) return false
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1), 'utf8')
    const expected = Buffer.from(record.secret, 'utf8')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /** Fetch the mirror from the remote, then advertise its refs. */
  private async advertiseUpload(req: IncomingMessage, res: ServerResponse, record: WorkspaceRecord, query: string): Promise<void> {
    const mirror = await this.deps.service.mirrors.sync(record.repo)
    await this.backend(req, res, dirname(mirror.dir), `/${basename(mirror.dir)}/info/refs`, query)
  }

  private async upload(req: IncomingMessage, res: ServerResponse, record: WorkspaceRecord): Promise<void> {
    this.deps.service.catalog.require(record.repo, 'read')
    const dir = this.deps.service.mirrors.store.dirOf(record.repo)
    await this.backend(req, res, dirname(dir), `/${basename(dir)}/git-upload-pack`, '')
  }

  private async advertiseReceive(req: IncomingMessage, res: ServerResponse, record: WorkspaceRecord, query: string): Promise<void> {
    this.deps.service.catalog.require(record.repo, 'write')
    const upstream = await this.upstream(record.repo)
    const answer = await this.fetch(`${upstream.base}/info/refs?${query}`, { headers: upstream.headers, redirect: 'follow' })
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    res.end(Buffer.from(await answer.arrayBuffer()))
  }

  private async receive(req: IncomingMessage, res: ServerResponse, record: WorkspaceRecord): Promise<void> {
    const { service } = this.deps
    const body = req.headers['content-encoding'] === 'gzip' ? req.pipe(createGunzip()) : req
    const { commands, capabilities, head, rest } = await readCommands(body)
    const refused = await this.check(record, commands)
    if (refused !== undefined) {
      rest.resume()
      await new Promise(resolve => rest.once('end', resolve))
      this.deps.logger?.info?.('dsh-repo: 代理拒绝推送 %s（工作区 %s）：%s', record.repo, record.path, refused)
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' })
      res.end(rejection(commands, capabilities, refused))
      return
    }
    const input = new PassThrough()
    input.write(head)
    rest.pipe(input)
    const upstream = await this.upstream(record.repo)
    const response = await this.fetch(`${upstream.base}/git-receive-pack`, {
      method: 'POST',
      headers: { ...upstream.headers, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
      body: Readable.toWeb(input) as ReadableStream<Uint8Array>,
      duplex: 'half',
      redirect: 'follow',
    } as RequestInit & { duplex: 'half' })
    const status = response.status
    const type = response.headers.get('content-type') ?? 'application/x-git-receive-pack-result'
    const answer = Buffer.from(await response.arrayBuffer())
    // The remote answers a refused update (a hook, a race) with HTTP 200 and `ng` in the report.
    const branches = status === 200 ? acceptedRefs(answer, commands, capabilities).map(ref => ref.slice('refs/heads/'.length)) : []
    this.deps.logger?.info?.('dsh-repo: 代理推送 %s %s（工作区 %s，会话 %s）：HTTP %d，远端接受 %s', record.repo, commands.map(command => command.ref.slice('refs/heads/'.length)).join(' '), record.path, record.session ?? '无', status, branches.join(' ') || '无')
    if (status === 200) {
      try {
        await service.mirrors.sync(record.repo)
      } catch (error) {
        this.deps.logger?.warn?.('dsh-repo: 推送后同步镜像 %s 失败：%s', record.repo, error instanceof Error ? error.message : String(error))
      }
      if (branches.length > 0) this.deps.onPushed?.(record, branches)
    }
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' })
    res.end(answer)
  }

  /**
   * Why a push is refused, or undefined when every command may go to the remote.
   * @param record - the pushing workspace.
   * @param commands - the push's ref updates.
   * @returns the reason in Chinese.
   */
  private async check(record: WorkspaceRecord, commands: readonly PushCommand[]): Promise<string | undefined> {
    const refused = await this.deps.service.policy.pushRefusal(record.repo, commands)
    if (refused !== undefined) return refused
    if (record.session !== undefined) {
      try {
        await authorize(this.deps.parallel, { session: record.session, level: 'code-write', action: 'git-push', summary: `从工作区 ${record.path} 推送 ${record.repo} 的分支 ${commands.map(command => command.ref.slice('refs/heads/'.length)).join('、')}` })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    return undefined
  }

  /** Base URL and headers of a remote repository's smart HTTP endpoints, with the host's token. */
  private async upstream(url: string): Promise<{ base: string; headers: Record<string, string> }> {
    const credentials = await this.deps.service.hosts.gitCredentials(url)
    const trimmed = url.replace(/\/+$/, '')
    return {
      base: trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`,
      headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}`, 'user-agent': 'git/dsh-repo' },
    }
  }

  /** Serve a request with `git http-backend`, streaming its answer. */
  private async backend(req: IncomingMessage, res: ServerResponse, root: string, pathInfo: string, query: string): Promise<void> {
    const child = spawn('git', ['http-backend'], { env: this.cgiEnv(req, root, pathInfo, query), stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64) stderr.push(chunk) })
    req.pipe(child.stdin)
    const headers = await readCgiHeaders(child.stdout)
    if (headers === undefined) {
      const code = await new Promise<number | null>(resolve => child.once('close', resolve))
      throw new RepoError('unavailable', `git http-backend 失败（${String(code)}）：${Buffer.concat(stderr).toString('utf8').trim()}`)
    }
    res.writeHead(headers.status, headers.headers)
    headers.rest.pipe(res)
    await new Promise(resolve => res.once('close', resolve))
  }

  /** CGI environment of `git http-backend` serving a fetch from the mirrors. */
  private cgiEnv(req: IncomingMessage, root: string, pathInfo: string, query: string): NodeJS.ProcessEnv {
    const protocol = req.headers['git-protocol']
    const encoding = req.headers['content-encoding']
    return {
      ...gitEnvironment(),
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_ADDR: '127.0.0.1',
      ...typeof protocol === 'string' ? { HTTP_GIT_PROTOCOL: protocol } : {},
      ...typeof encoding === 'string' ? { HTTP_CONTENT_ENCODING: encoding } : {},
    }
  }
}

/** Split a buffered CGI answer into status, headers, and body. */
function splitCgi(output: Buffer): { status: number; headers: Record<string, string>; body: Buffer } | undefined {
  const crlf = output.indexOf('\r\n\r\n')
  const lf = output.indexOf('\n\n')
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf >= 0 ? lf + 2 : -1
  if (end < 0) return undefined
  const { status, headers } = cgiHeaders(output.subarray(0, end).toString('utf8'))
  return { status, headers, body: output.subarray(end) }
}

function cgiHeaders(text: string): { status: number; headers: Record<string, string> } {
  let status = 200
  const headers: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === 'status') status = Number.parseInt(value, 10) || 200
    else headers[name] = value
  }
  return { status, headers }
}

/** Read CGI headers from a stream; the rest of the stream is the body. */
async function readCgiHeaders(stream: Readable): Promise<{ status: number; headers: Record<string, string>; rest: Readable } | undefined> {
  const chunks: Buffer[] = []
  const iterator = stream[Symbol.asyncIterator]()
  for (;;) {
    const buffer = Buffer.concat(chunks)
    const split = splitCgi(buffer)
    if (split !== undefined) {
      const rest = Readable.from((async function* () {
        if (split.body.length > 0) yield split.body
        for (;;) {
          const next = await iterator.next()
          if (next.done === true) return
          yield next.value as Buffer
        }
      })())
      return { status: split.status, headers: split.headers, rest }
    }
    const next = await iterator.next()
    if (next.done === true) return undefined
    chunks.push(next.value as Buffer)
  }
}
