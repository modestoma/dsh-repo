/**
 * Local syncs: each one keeps a local directory equal to the head of a
 * repository branch, on a schedule.
 *
 * - A sync fetches the repository into its mirror ({@link ../mirror/store.ts})
 *   and expands the branch head into the directory with
 *   `git --git-dir=<mirror> --work-tree=<dir> read-tree --reset -u`, using an
 *   index file of its own under the sync index directory. The directory gets
 *   plain files and no `.git`; git objects stay in the mirror, and the
 *   mirror's `HEAD` and index are not touched.
 * - Each sync writes only files that changed, deletes files the branch no
 *   longer has, and restores files edited or deleted locally. Files the
 *   branch never had are left alone.
 * - The first sync into a directory requires it to be missing or empty, so
 *   existing files are never overwritten. The directory is then recorded as
 *   claimed before any file is written, so a first sync interrupted after
 *   writing files is retried there. Each directory of a sync has its own
 *   index file. Removing a sync, or moving it to another directory, leaves
 *   the files in the old directory.
 * - Directory overlap is checked on real paths: existing ancestors are
 *   resolved through symbolic links.
 * - Syncs run one at a time. A sync is due `intervalMinutes` after its last
 *   success; a failed attempt is retried after the interval or
 *   {@link RETRY_MS}, whichever is shorter. Due times survive restarts
 *   because the last success is stored.
 *
 * @module dsh-repo/sync/syncer
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative } from 'node:path'
import { expandHome } from '../config.ts'
import type { MirrorState, MirrorSyncOptions } from '../contract.ts'
import { RepoError, toRepoError } from '../errors.ts'
import type { HostLogger } from '../host.ts'
import type { GitRunner } from '../mirror/git.ts'
import { isAcceptedGitUrl } from '../mirror/store.ts'
import { DEFAULT_SYNC_INTERVAL_MINUTES, MAX_SYNCS, MAX_TIMER_DELAY_MS, SYNC_INTERVAL_BOUNDS } from '../settings/contract.ts'
import type { SyncInfo, SyncInput } from '../settings/contract.ts'
import type { SyncRecord, SyncStore } from './store.ts'

/** Longest wait before a failed sync is attempted again. */
export const RETRY_MS = 30 * 60 * 1000

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[^\s~^:?*[\\\u0000-\u001f\u007f]+$/

/** The service calls a sync makes. */
export interface SyncService {
  syncMirror(url: string, options?: MirrorSyncOptions): Promise<MirrorState>
  /** @returns the mirror directory now in use; sync directories must stay outside it. */
  mirrorSettings(): { readonly dir: string }
}

/** Collaborators of the syncer. */
export interface SyncerDeps {
  readonly service: SyncService
  readonly git: GitRunner
  readonly store: SyncStore
  /** Directory holding each sync's git index. */
  readonly indexDir: string
  /** Timeout of one git command, read on every use. */
  readonly timeoutMs: () => number
  readonly logger?: HostLogger
  /** Current time; tests substitute it. */
  readonly now?: () => number
}

interface Status {
  state: 'idle' | 'queued' | 'running'
  error?: string
  failedAt?: number
  nextAt?: number
  timer?: ReturnType<typeof setTimeout>
  /** Settles when the queued or running sync finished. */
  pending?: Promise<void>
  /** The sync's fields changed while it was queued or running: sync again afterwards. */
  again?: boolean
  abort?: AbortController
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether `inner` is `outer` or lies inside it. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Validate a sync's fields, filling the defaults.
 * @param input - fields from the settings page.
 * @returns the address, branch, absolute directory, and interval.
 * @throws {RepoError} `invalid` naming the bad field.
 */
function resolveInput(input: SyncInput): Pick<SyncRecord, 'url' | 'branch' | 'dir' | 'intervalMinutes'> {
  const url = input.url.trim()
  if (!isAcceptedGitUrl(url)) throw new RepoError('invalid', `不支持的 git 地址：${input.url}（只支持 https 地址、file URL 或绝对路径；SSH 地址请改用仓库的 https 地址）`)
  const branch = input.branch?.trim()
  if (branch !== undefined && branch !== '' && (!BRANCH.test(branch) || branch.startsWith('/') || branch === '@')) throw new RepoError('invalid', `分支名不合法：${branch}`)
  const rawDir = input.dir.trim()
  if (rawDir === '' || /[\u0000-\u001f\u007f]/.test(rawDir)) throw new RepoError('invalid', '本地目录不能为空或包含控制字符')
  if (!isAbsolute(rawDir) && rawDir !== '~' && !rawDir.startsWith('~/')) throw new RepoError('invalid', `本地目录必须是绝对路径：${rawDir}`)
  const dir = expandHome(rawDir)
  if (dir === parse(dir).root || dir === homedir()) throw new RepoError('invalid', `本地目录不能是根目录或用户主目录：${dir}`)
  const intervalMinutes = input.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < SYNC_INTERVAL_BOUNDS.min || intervalMinutes > SYNC_INTERVAL_BOUNDS.max) {
    throw new RepoError('invalid', `同步间隔必须是 ${SYNC_INTERVAL_BOUNDS.min} 到 ${SYNC_INTERVAL_BOUNDS.max} 之间的整数分钟：${intervalMinutes}`)
  }
  return { url, ...branch === undefined || branch === '' ? {} : { branch }, dir, intervalMinutes }
}

/**
 * The path with its longest existing ancestor resolved through symbolic links.
 * @param path - absolute path, existing or not.
 * @returns the real path of the existing part joined with the rest.
 */
export async function realPathOf(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

async function requireEmpty(dir: string): Promise<void> {
  let names: string[]
  try {
    if (!(await stat(dir)).isDirectory()) throw new RepoError('conflict', `${dir} 已存在且不是目录`)
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (names.length > 0) throw new RepoError('conflict', `本地目录 ${dir} 不是空目录。第一次同步只写入不存在或空的目录，以免覆盖已有文件；请换一个目录或先清空它`)
}

/** Keeps local directories equal to repository branches. */
export class LocalSyncer {
  private readonly statuses = new Map<string, Status>()
  private queue: Promise<void> = Promise.resolve()
  private started = false
  private stopped = false
  private readonly now: () => number

  /** @param deps - service, git, store, index directory, and limits. */
  constructor(private readonly deps: SyncerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Schedule every sync; overdue and never-synced ones are queued at once. */
  start(): void {
    if (this.started) return
    this.started = true
    for (const record of this.deps.store.all()) this.schedule(record.id)
  }

  /**
   * Cancel timers and the running sync, and wait until no sync runs.
   * @returns once the queue is empty.
   */
  async stop(): Promise<void> {
    this.stopped = true
    for (const status of this.statuses.values()) {
      clearTimeout(status.timer)
      status.abort?.abort(new RepoError('unavailable', '插件停止，同步已取消'))
    }
    await this.queue
  }

  /** @returns every sync with its status, in the order they were added. */
  list(): SyncInfo[] {
    return this.deps.store.all().map(record => this.info(record))
  }

  /**
   * Add a sync and run its first sync.
   * @param input - address, branch, directory, and interval.
   * @returns the sync after its first attempt; a failed attempt is reported in `error`.
   * @throws {RepoError} `invalid` for a bad field, `conflict` when the directory overlaps another sync's or the mirror directory, `too-large` past {@link MAX_SYNCS}, `unavailable` when the list cannot be saved.
   */
  async add(input: SyncInput): Promise<SyncInfo> {
    const fields = resolveInput(input)
    const id = randomBytes(6).toString('hex')
    const real = await this.realPaths(fields.dir)
    await this.deps.store.update((current) => {
      if (current.length >= MAX_SYNCS) throw new RepoError('too-large', `本地同步最多 ${MAX_SYNCS} 条`)
      this.checkDir(fields.dir, current, undefined, real)
      return [...current, { id, ...fields, createdAt: new Date(this.now()).toISOString() }]
    })
    await this.run(id)
    return this.infoOf(id)
  }

  /**
   * Change a sync. A changed address, branch, or directory syncs at once; a
   * changed interval only moves the next due time.
   * @param id - sync id.
   * @param input - the complete new fields.
   * @returns the sync, after the sync a change caused.
   * @throws {RepoError} `not-found`, plus the failures of {@link add}.
   */
  async update(id: string, input: SyncInput): Promise<SyncInfo> {
    const fields = resolveInput(input)
    const real = await this.realPaths(fields.dir)
    let resync = false
    await this.deps.store.update((current) => {
      const record = current.find(item => item.id === id)
      if (record === undefined) throw new RepoError('not-found', '没有这条本地同步，可能已经删除')
      this.checkDir(fields.dir, current, id, real)
      resync = record.url !== fields.url || record.branch !== fields.branch || record.dir !== fields.dir
      const { branch: _branch, ...rest } = record
      return current.map(item => item.id === id ? { ...rest, ...fields } : item)
    })
    const status = this.status(id)
    if (resync) {
      delete status.failedAt
      delete status.error
      await this.run(id, true)
    } else {
      this.schedule(id)
    }
    return this.infoOf(id)
  }

  /**
   * Remove a sync, cancelling it when it runs, and delete its git index. The
   * files in its directory stay.
   * @param id - sync id.
   * @returns whether the sync existed.
   * @throws {RepoError} `unavailable` when the list cannot be saved.
   */
  async remove(id: string): Promise<boolean> {
    if (this.deps.store.get(id) === undefined) return false
    await this.deps.store.update(current => current.filter(item => item.id !== id))
    const status = this.statuses.get(id)
    if (status !== undefined) {
      clearTimeout(status.timer)
      status.abort?.abort(new RepoError('unavailable', '本地同步已删除'))
      await status.pending
      this.statuses.delete(id)
    }
    await this.removeIndexes(id, undefined)
    return true
  }

  /**
   * Sync now, or wait for the sync already queued or running.
   * @param id - sync id.
   * @returns the sync after the attempt; a failed attempt is reported in `error`.
   * @throws {RepoError} `not-found` for an unknown id.
   */
  async syncNow(id: string): Promise<SyncInfo> {
    if (this.deps.store.get(id) === undefined) throw new RepoError('not-found', '没有这条本地同步，可能已经删除')
    await this.run(id)
    return this.infoOf(id)
  }

  /** @returns once every queued and running sync finished. */
  idle(): Promise<void> {
    return this.queue
  }

  private infoOf(id: string): SyncInfo {
    const record = this.deps.store.get(id)
    if (record === undefined) throw new RepoError('not-found', '本地同步在同步期间被删除')
    return this.info(record)
  }

  private info(record: SyncRecord): SyncInfo {
    const status = this.statuses.get(record.id)
    return {
      id: record.id,
      url: record.url,
      ...record.branch === undefined ? {} : { branch: record.branch },
      dir: record.dir,
      intervalMinutes: record.intervalMinutes,
      state: status?.state ?? 'idle',
      ...record.last === undefined ? {} : { syncedAt: record.last.syncedAt, commit: record.last.commit, syncedBranch: record.last.branch },
      ...status?.error === undefined ? {} : { error: status.error },
      ...status?.failedAt === undefined ? {} : { failedAt: new Date(status.failedAt).toISOString() },
      ...status?.nextAt === undefined || status.state !== 'idle' ? {} : { nextAt: new Date(status.nextAt).toISOString() },
    }
  }

  private status(id: string): Status {
    let status = this.statuses.get(id)
    if (status === undefined) {
      status = { state: 'idle' }
      this.statuses.set(id, status)
    }
    return status
  }

  /** Index file of one directory of a sync: `<id>-<hash of the directory>.index`. */
  private indexFile(id: string, dir: string): string {
    return join(this.deps.indexDir, `${id}-${createHash('sha1').update(dir).digest('hex').slice(0, 12)}.index`)
  }

  /** Delete a sync's index files, except the one of `keep`. */
  private async removeIndexes(id: string, keep: string | undefined): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.deps.indexDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const kept = keep === undefined ? undefined : basename(this.indexFile(id, keep))
    await Promise.all(names.filter(name => name.startsWith(`${id}-`) && name !== kept).map(name => rm(join(this.deps.indexDir, name), { force: true })))
  }

  /**
   * Real paths of a candidate directory, the mirror directory, and every
   * sync's directory, read before the list changes so the check itself stays synchronous.
   */
  private async realPaths(dir: string): Promise<Map<string, string>> {
    const paths = [dir, this.deps.service.mirrorSettings().dir, ...this.deps.store.all().map(record => record.dir)]
    return new Map(await Promise.all(paths.map(async path => [path, await realPathOf(path)] as const)))
  }

  /**
   * Refuse a directory that overlaps the mirror directory or another sync's,
   * comparing real paths where they were read and the paths themselves otherwise.
   * @throws {RepoError} `conflict`.
   */
  private checkDir(dir: string, current: readonly SyncRecord[], self: string | undefined, real: ReadonlyMap<string, string>): void {
    const overlap = (a: string, b: string): boolean => {
      const ra = real.get(a) ?? a
      const rb = real.get(b) ?? b
      return within(a, b) || within(b, a) || within(ra, rb) || within(rb, ra)
    }
    const mirrors = this.deps.service.mirrorSettings().dir
    if (overlap(mirrors, dir)) throw new RepoError('conflict', `本地目录 ${dir} 与镜像目录 ${mirrors} 重叠，请换一个目录`)
    const other = current.find(item => item.id !== self && overlap(item.dir, dir))
    if (other !== undefined) throw new RepoError('conflict', `本地目录 ${dir} 与 ${other.url} 的本地目录 ${other.dir} 重叠，请换一个目录`)
  }

  /**
   * Queue a sync unless one is queued or running.
   * @param id - sync id.
   * @param again - when one is queued or running, sync once more after it, so changed fields are used.
   * @returns settles when the sync finished; never rejects.
   */
  private run(id: string, again = false): Promise<void> {
    const status = this.status(id)
    if (status.pending !== undefined) {
      if (!again) return status.pending
      status.again = true
      return status.pending.then(() => status.pending)
    }
    clearTimeout(status.timer)
    delete status.timer
    status.state = 'queued'
    const pending = this.queue.then(async () => {
      const record = this.deps.store.get(id)
      if (record === undefined || this.stopped) return
      status.state = 'running'
      const abort = new AbortController()
      status.abort = abort
      try {
        await this.expand(record, abort.signal)
        delete status.error
        delete status.failedAt
      } catch (error) {
        const failure = toRepoError(error, `同步 ${record.url} 到 ${record.dir}`)
        status.error = failure.message
        status.failedAt = this.now()
        if (!abort.signal.aborted) this.deps.logger?.warn?.(`dsh-repo: ${failure.message}`)
      } finally {
        delete status.abort
      }
    }).finally(() => {
      status.state = 'idle'
      delete status.pending
      if (status.again === true) {
        delete status.again
        void this.run(id)
      } else {
        this.schedule(id)
      }
    })
    status.pending = pending
    this.queue = pending
    return pending
  }

  private schedule(id: string): void {
    const record = this.deps.store.get(id)
    const status = this.statuses.get(id) ?? (record === undefined ? undefined : this.status(id))
    if (status === undefined) return
    clearTimeout(status.timer)
    delete status.timer
    delete status.nextAt
    if (record === undefined || this.stopped || !this.started) return
    const now = this.now()
    const interval = record.intervalMinutes * 60_000
    let next: number
    if (status.failedAt !== undefined) next = status.failedAt + Math.min(interval, RETRY_MS)
    else if (record.last?.dir !== record.dir) next = now
    else next = Date.parse(record.last.syncedAt) + interval
    status.nextAt = next
    const timer = setTimeout(() => {
      // A delay capped at the timer maximum reschedules instead of syncing early.
      if (this.now() < next) this.schedule(id)
      else void this.run(id)
    }, Math.min(Math.max(next - now, 0), MAX_TIMER_DELAY_MS))
    timer.unref?.()
    status.timer = timer
  }

  /**
   * Fetch the mirror and expand the branch head into the sync's directory.
   * @throws {RepoError} the mirror's failures; `conflict` when a first sync finds a non-empty directory; `unavailable` when the claim or the result cannot be saved.
   */
  private async expand(record: SyncRecord, signal: AbortSignal): Promise<void> {
    const mirror = await this.deps.service.syncMirror(record.url, { ...record.branch === undefined ? {} : { branch: record.branch }, signal })
    const index = this.indexFile(record.id, record.dir)
    if (record.last?.dir !== record.dir && record.claimedDir !== record.dir) {
      await requireEmpty(record.dir)
      await rm(index, { force: true })
      await this.deps.store.update(current => current.map(item => item.id === record.id && item.dir === record.dir ? { ...item, claimedDir: record.dir } : item))
    }
    await mkdir(record.dir, { recursive: true })
    await mkdir(this.deps.indexDir, { recursive: true })
    const git = (args: readonly string[]): Promise<string> => this.deps.git(['--git-dir', join(mirror.dir, '.git'), '--work-tree', record.dir, ...args], {
      cwd: record.dir,
      timeoutMs: this.deps.timeoutMs(),
      env: { GIT_INDEX_FILE: index },
      signal,
    })
    await git(['read-tree', '--reset', '-u', mirror.commit])
    try {
      await git(['update-index', '-q', '--refresh'])
    } catch {
      // A non-zero exit only says some files differ from the index; diff-files lists them.
    }
    if ((await git(['diff-files', '--name-only', '-z'])) !== '') await git(['checkout-index', '--all', '--force'])
    const last = { dir: record.dir, commit: mirror.commit, branch: mirror.branch, syncedAt: new Date(this.now()).toISOString() }
    await this.deps.store.update(current => current.map((item) => {
      if (item.id !== record.id || item.dir !== record.dir) return item
      const { claimedDir: _claimed, ...rest } = item
      return { ...rest, last }
    }))
    await this.removeIndexes(record.id, record.dir)
  }
}
