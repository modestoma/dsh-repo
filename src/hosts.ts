/**
 * Hosts: the ones configured in cordis.yml plus the ones added at run time,
 * which are kept in a JSON file (written to a temporary file, then renamed)
 * and carry tokens under generated credential references. The same file
 * keeps the mirror directory chosen at run time.
 *
 * @module dsh-repo/hosts
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import type { HostCreate } from './contract.ts'
import { hostSpecSchema, normalizeHostUrl } from './config.ts'
import type { HostSpec } from './config.ts'
import { RepoError } from './errors.ts'

/** Longest accepted token; personal access tokens are far shorter. */
export const MAX_TOKEN_LENGTH = 4096

const fileSchema = z.object({ hosts: z.array(hostSpecSchema), mirrorDir: z.string().min(1).refine(isAbsolute, '镜像目录必须是绝对路径').optional() }).strict()

/**
 * Whether a token value can be handed to an SDK and to git: non-empty,
 * bounded, and free of control characters.
 * @param value - candidate token.
 * @returns whether it is accepted.
 */
export function isAcceptedToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Credential reference of an added host, derived from its address.
 * @param url - normalized host address.
 * @returns `DSH_REPO_HOST_<hash>`.
 */
export function addedTokenRef(url: string): string {
  return `DSH_REPO_HOST_${createHash('sha1').update(url).digest('hex').slice(0, 12).toUpperCase()}`
}

/** Configured and added hosts. */
export class HostStore {
  private added: HostSpec[]
  private chosenMirrorDir: string | undefined
  /** Tail of the queue that runs additions and removals one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Read the added hosts. A missing file means none.
   * @param configured - hosts from cordis.yml.
   * @param file - absolute path of the added-hosts file.
   * @throws when the file exists but cannot be read or is invalid.
   */
  constructor(private readonly configured: readonly HostSpec[], readonly file: string) {
    const stored = HostStore.read(file)
    this.added = stored.hosts.filter(host => !configured.some(spec => spec.url === host.url))
    this.chosenMirrorDir = stored.mirrorDir
  }

  private static read(file: string): z.infer<typeof fileSchema> {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hosts: [] }
      throw new Error(`dsh-repo 无法读取主机文件 ${file}：${(error as Error).message}`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(`dsh-repo 主机文件 ${file} 不是合法 JSON：${(error as Error).message}`)
    }
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) throw new Error(`dsh-repo 主机文件 ${file} 内容不合法：${parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')}`)
    return parsed.data
  }

  /** @returns the mirror directory chosen at run time, or undefined for the default. */
  mirrorDir(): string | undefined {
    return this.chosenMirrorDir
  }

  /**
   * Persist the mirror directory, or clear it to return to the default.
   * @param dir - absolute directory, or undefined.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  setMirrorDir(dir: string | undefined): Promise<void> {
    return this.enqueue(() => this.write(this.added, dir))
  }

  /** @returns every host, configured ones first. */
  all(): readonly HostSpec[] {
    return [...this.configured, ...this.added]
  }

  /**
   * Whether a host was added at run time.
   * @param url - normalized host address.
   * @returns whether it is an added host.
   */
  isAdded(url: string): boolean {
    return this.added.some(host => host.url === url)
  }

  /**
   * The host with an address, after normalizing it.
   * @param url - host address.
   * @returns the host.
   * @throws {RepoError} `not-found` when no host has that address.
   */
  find(url: string): HostSpec {
    const normalized = normalizeHostUrl(url.trim()) ?? url
    const host = this.all().find(spec => spec.url === normalized)
    if (host === undefined) throw new RepoError('not-found', `没有地址为 ${url} 的主机`)
    return host
  }

  /**
   * Add and persist a host.
   * @param create - kind, address, and alias.
   * @returns the stored host.
   * @throws {RepoError} `invalid` for a bad address or alias, `conflict` when the address is taken, `unavailable` when the file cannot be written.
   */
  add(create: HostCreate): Promise<HostSpec> {
    return this.enqueue(() => this.addNow(create))
  }

  private async addNow(create: HostCreate): Promise<HostSpec> {
    const url = normalizeHostUrl(create.url.trim())
    if (url === undefined) throw new RepoError('invalid', `主机地址不合法：${create.url}（填 https://主机[:端口][/路径]，不含用户名、查询参数或片段）`)
    const alias = create.alias?.trim()
    if (alias !== undefined && (alias.length > 64 || /[\u0000-\u001f\u007f]/.test(alias))) throw new RepoError('invalid', '别名不能超过 64 个字符或包含控制字符')
    if (this.all().some(host => host.url === url)) throw new RepoError('conflict', `主机 ${url} 已存在`)
    const host: HostSpec = { kind: create.kind ?? 'gitlab', url, tokenRef: addedTokenRef(url), ...alias === undefined || alias === '' ? {} : { alias } }
    await this.write([...this.added, host], this.chosenMirrorDir)
    return host
  }

  /**
   * Remove and persist an added host.
   * @param url - host address.
   * @returns the removed host.
   * @throws {RepoError} `not-found`, `forbidden` for a configured host, `unavailable` when the file cannot be written.
   */
  remove(url: string): Promise<HostSpec> {
    return this.enqueue(() => this.removeNow(url))
  }

  private async removeNow(url: string): Promise<HostSpec> {
    const host = this.find(url)
    if (!this.isAdded(host.url)) throw new RepoError('forbidden', `${host.url} 配置在 cordis.yml 中，不能在运行时删除`)
    await this.write(this.added.filter(spec => spec.url !== host.url), this.chosenMirrorDir)
    return host
  }

  /** Run a read-modify-write after every one queued before it. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    // The queue only orders work; callers observe the failure through `run`.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async write(hosts: HostSpec[], mirrorDir: string | undefined): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temporary, `${JSON.stringify({ hosts, ...mirrorDir === undefined ? {} : { mirrorDir } }, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.file)
    } catch (error) {
      throw new RepoError('unavailable', `无法写入主机文件 ${this.file}：${(error as Error).message}`)
    }
    this.added = hosts
    this.chosenMirrorDir = mirrorDir
  }
}
