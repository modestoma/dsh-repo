/**
 * Local syncs: every catalog repository whose local sync is enabled keeps a
 * local directory equal to the head of its branch, on a schedule.
 *
 * - The catalog decides which repository syncs where and how often;
 *   {@link LocalSyncer.reconcile} applies a catalog change: a new or changed
 *   address, branch, or directory syncs at once, a changed interval only
 *   moves the next due time, and a disabled or removed sync stops. The
 *   progress of a disabled sync is kept so enabling it again continues in the
 *   same directory; the progress and git index of a removed one are deleted.
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
 *   index file. Moving a sync to another directory leaves the files in the
 *   old directory.
 * - Syncs run one at a time. A sync is due `intervalMinutes` after its last
 *   success; a failed attempt is retried after the interval or
 *   {@link RETRY_MS}, whichever is shorter. Due times survive restarts
 *   because the last success is stored.
 *
 * @module dsh-repo/sync/syncer
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CatalogEntry } from '../catalog/entry.ts'
import type { MirrorState } from '../mirror/store.ts'
import { RepoError, toRepoError } from '../errors.ts'
import type { HostLogger } from '../host.ts'
import type { GitRunner } from '../mirror/git.ts'
import { overlaps, realPathOf } from '../paths.ts'
import { MAX_TIMER_DELAY_MS } from '../settings/contract.ts'
import type { LocalSyncStatus } from '../settings/contract.ts'
import type { SyncStore } from './store.ts'

/** Longest wait before a failed sync is attempted again. */
export const RETRY_MS = 30 * 60 * 1000

/** One enabled local sync, as the catalog defines it. */
export interface SyncRecord {
  /** Catalog entry id. */
  readonly id: string
  readonly url: string
  readonly branch?: string
  readonly dir: string
  readonly intervalMinutes: number
}

/**
 * The enabled local syncs of catalog entries.
 * @param entries - catalog entries.
 * @returns one record for each entry whose local sync is enabled, following its own branch or else the entry's baseline branch.
 */
export function syncRecords(entries: readonly CatalogEntry[]): SyncRecord[] {
  return entries.flatMap((entry) => {
    if (entry.localSync?.enabled !== true) return []
    const branch = entry.localSync.branch ?? entry.base
    return [{ id: entry.id, url: entry.url, ...branch === undefined ? {} : { branch }, dir: entry.localSync.dir, intervalMinutes: entry.localSync.intervalMinutes }]
  })
}

/** The mirror calls a sync makes. */
export interface SyncMirrors {
  /** Clone or fetch the mirror of `url` and resolve `branch` (default: the remote's default branch). */
  sync(url: string, options?: { readonly branch?: string; readonly signal?: AbortSignal }): Promise<MirrorState>
  /** @returns the mirror directory now in use, or undefined while none is chosen; sync directories must stay outside it. */
  settings(): { readonly dir: string | undefined }
}

/** Collaborators of the syncer. */
export interface SyncerDeps {
  readonly mirrors: SyncMirrors
  /** The enabled local syncs of the catalog, read on every use. */
  readonly records: () => readonly SyncRecord[]
  /** Ids of every catalog entry, enabled or not; progress of other ids is deleted. */
  readonly ids: () => ReadonlySet<string>
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
  /** The enabled syncs as of the last {@link start} or {@link reconcile}. */
  private known = new Map<string, SyncRecord>()
  private queue: Promise<void> = Promise.resolve()
  /** Deleting the progress of removed repositories; never rejects. */
  private cleanup: Promise<void> = Promise.resolve()
  private started = false
  private stopped = false
  private readonly now: () => number

  /** @param deps - mirrors, catalog view, git, store, index directory, and limits. */
  constructor(private readonly deps: SyncerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Schedule every enabled sync; overdue and never-synced ones are queued at once. Forgets progress of repositories no longer in the catalog. */
  start(): void {
    if (this.started) return
    this.started = true
    this.known = new Map(this.deps.records().map(record => [record.id, record]))
    this.forgetRemoved()
    for (const id of this.known.keys()) this.schedule(id)
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
    await Promise.all([this.queue, this.cleanup])
  }

  /** Apply the catalog as it is now: start, restart, reschedule, or stop syncs. */
  reconcile(): void {
    if (!this.started || this.stopped) return
    const current = new Map(this.deps.records().map(record => [record.id, record]))
    for (const id of this.known.keys()) {
      if (!current.has(id)) this.cancel(id)
    }
    for (const [id, record] of current) {
      const before = this.known.get(id)
      if (before === undefined || before.url !== record.url || before.branch !== record.branch || before.dir !== record.dir) {
        const status = this.entry(id)
        delete status.failedAt
        delete status.error
        void this.run(id, true)
      } else if (before.intervalMinutes !== record.intervalMinutes) {
        this.schedule(id)
      }
    }
    this.known = current
    this.forgetRemoved()
  }

  /**
   * Where one repository's local sync stands.
   * @param id - catalog entry id.
   * @returns the status, or undefined while its local sync is not enabled.
   */
  status(id: string): LocalSyncStatus | undefined {
    if (!this.deps.records().some(record => record.id === id)) return undefined
    const status = this.statuses.get(id)
    const progress = this.deps.store.get(id)
    const record = this.deps.records().find(item => item.id === id)
    const last = progress?.last !== undefined && progress.last.dir === record?.dir ? progress.last : undefined
    return {
      state: status?.state ?? 'idle',
      ...last === undefined ? {} : { syncedAt: last.syncedAt, commit: last.commit, syncedBranch: last.branch },
      ...status?.error === undefined ? {} : { error: status.error },
      ...status?.failedAt === undefined ? {} : { failedAt: new Date(status.failedAt).toISOString() },
      ...status?.nextAt === undefined || status.state !== 'idle' ? {} : { nextAt: new Date(status.nextAt).toISOString() },
    }
  }

  /**
   * Sync now, or wait for the sync already queued or running.
   * @param id - catalog entry id.
   * @returns once the attempt finished; a failed attempt is reported by {@link status}.
   * @throws {RepoError} `not-found` while the repository's local sync is not enabled.
   */
  async syncNow(id: string): Promise<void> {
    if (!this.deps.records().some(record => record.id === id)) throw new RepoError('not-found', '这个仓库没有打开本地同步')
    await this.run(id)
  }

  /**
   * @param id - catalog entry id.
   * @returns once the sync queued or running for it and the deletion of removed repositories' progress finished.
   */
  async settled(id: string): Promise<void> {
    await Promise.all([this.statuses.get(id)?.pending, this.cleanup])
  }

  /** @returns once every queued and running sync and the deletion of removed repositories' progress finished. */
  async idle(): Promise<void> {
    await Promise.all([this.queue, this.cleanup])
  }

  /** Stop one sync's timer and running attempt. */
  private cancel(id: string): void {
    const status = this.statuses.get(id)
    if (status === undefined) return
    clearTimeout(status.timer)
    delete status.timer
    delete status.nextAt
    status.abort?.abort(new RepoError('unavailable', '本地同步已关闭或仓库已从清单删除'))
  }

  /** Queue deleting the progress and index files of repositories no longer in the catalog. */
  private forgetRemoved(): void {
    this.cleanup = this.cleanup.then(() => this.deleteRemoved())
  }

  private async deleteRemoved(): Promise<void> {
    const ids = this.deps.ids()
    for (const progress of this.deps.store.all()) {
      if (ids.has(progress.id)) continue
      this.statuses.delete(progress.id)
      try {
        await this.deps.store.update(progress.id, () => undefined)
        await this.removeIndexes(progress.id, undefined)
      } catch (error) {
        this.deps.logger?.warn?.(`dsh-repo: 清理已删除仓库的本地同步进度失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private entry(id: string): Status {
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

  private record(id: string): SyncRecord | undefined {
    return this.deps.records().find(record => record.id === id)
  }

  /**
   * Queue a sync unless one is queued or running.
   * @param id - catalog entry id.
   * @param again - when one is queued or running, sync once more after it, so changed fields are used.
   * @returns settles when the sync finished; never rejects.
   */
  private run(id: string, again = false): Promise<void> {
    const status = this.entry(id)
    if (status.pending !== undefined) {
      if (!again) return status.pending
      status.again = true
      return status.pending.then(() => status.pending)
    }
    clearTimeout(status.timer)
    delete status.timer
    status.state = 'queued'
    const pending = this.queue.then(async () => {
      const record = this.record(id)
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
    const record = this.record(id)
    const status = this.statuses.get(id) ?? (record === undefined ? undefined : this.entry(id))
    if (status === undefined) return
    clearTimeout(status.timer)
    delete status.timer
    delete status.nextAt
    if (record === undefined || this.stopped || !this.started) return
    const now = this.now()
    const interval = record.intervalMinutes * 60_000
    const last = this.deps.store.get(id)?.last
    let next: number
    if (status.failedAt !== undefined) next = status.failedAt + Math.min(interval, RETRY_MS)
    else if (last?.dir !== record.dir) next = now
    else next = Date.parse(last.syncedAt) + interval
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
   * @throws {RepoError} the mirror's failures; `conflict` when the directory now overlaps the mirror directory or a first sync finds a non-empty directory; `unavailable` when the claim or the result cannot be saved.
   */
  private async expand(record: SyncRecord, signal: AbortSignal): Promise<void> {
    // The mirror directory can change after the sync was configured, so the overlap is checked again here; an unset directory fails the mirror sync itself.
    const mirrors = this.deps.mirrors.settings().dir
    if (mirrors !== undefined) {
      const real = new Map([[record.dir, await realPathOf(record.dir)], [mirrors, await realPathOf(mirrors)]])
      if (overlaps(mirrors, record.dir, real)) {
        throw new RepoError('conflict', `本地目录 ${record.dir} 与镜像目录 ${mirrors} 重叠，没有同步；请把本地同步或镜像目录换到不重叠的位置`)
      }
    }
    const mirror = await this.deps.mirrors.sync(record.url, { ...record.branch === undefined ? {} : { branch: record.branch }, signal })
    const index = this.indexFile(record.id, record.dir)
    const progress = this.deps.store.get(record.id)
    if (progress?.last?.dir !== record.dir && progress?.claimedDir !== record.dir) {
      await requireEmpty(record.dir)
      await rm(index, { force: true })
      await this.deps.store.update(record.id, current => ({ ...current, id: record.id, claimedDir: record.dir }))
    }
    await mkdir(record.dir, { recursive: true })
    await mkdir(this.deps.indexDir, { recursive: true })
    const git = (args: readonly string[]): Promise<string> => this.deps.git(['--git-dir', mirror.dir, '--work-tree', record.dir, ...args], {
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
    await this.deps.store.update(record.id, () => ({ id: record.id, last }))
    await this.removeIndexes(record.id, record.dir)
  }
}
