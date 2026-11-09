/**
 * `local-syncs.json`: each catalog repository's local sync progress (the
 * directory a first sync claimed and the last successful sync), keyed by the
 * catalog entry id. Which repository syncs where lives in the catalog. Every
 * change is a read-modify-write after the ones queued before it, written
 * atomically.
 *
 * @module dsh-repo/sync/store
 */

import { readFileSync, renameSync } from 'node:fs'
import { z } from 'zod'
import { RepoError } from '../errors.ts'
import { writeJsonAtomic } from '../files.ts'
import type { HostLogger } from '../host.ts'

/** One repository's local sync progress. */
export interface SyncProgress {
  /** Catalog entry id. */
  readonly id: string
  /**
   * Directory a first sync was allowed into after it was found missing or
   * empty, kept until that sync succeeds, so an attempt interrupted after
   * writing files can be retried there.
   */
  readonly claimedDir?: string
  /** Last successful sync; `dir` is the directory the sync's git index describes. */
  readonly last?: {
    readonly dir: string
    readonly commit: string
    readonly branch: string
    readonly syncedAt: string
  }
}

const progressSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  claimedDir: z.string().min(1).optional(),
  last: z.object({
    dir: z.string().min(1),
    commit: z.string(),
    branch: z.string(),
    syncedAt: z.string(),
  }).strict().optional(),
}).strict()

const fileSchema = z.object({ syncs: z.array(progressSchema) }).strict()

/** Local sync progress of every catalog repository that synced. */
export class SyncStore {
  private records: readonly SyncProgress[]
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Read the file. A missing file means no progress; an unreadable or invalid
   * one is renamed to `<file>.invalid-<time>` and reported, and every sync
   * starts as a first sync.
   * @param file - absolute path of `local-syncs.json`.
   * @param logger - reports a set-aside file.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    this.records = SyncStore.read(file, logger)
  }

  private static read(file: string, logger: HostLogger | undefined): SyncProgress[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      logger?.warn?.(`dsh-repo: 无法读取本地同步进度 ${file}，每个本地同步都按第一次同步处理：${(error as Error).message}`)
      return []
    }
    let reason: string
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data.syncs
      reason = parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')
    } catch (error) {
      reason = `不是合法 JSON：${(error as Error).message}`
    }
    const aside = `${file}.invalid-${Date.now()}`
    try {
      renameSync(file, aside)
      logger?.warn?.(`dsh-repo: 本地同步进度 ${file} 内容不合法（${reason}），已移到 ${aside}，每个本地同步都按第一次同步处理`)
    } catch (error) {
      logger?.warn?.(`dsh-repo: 本地同步进度 ${file} 内容不合法（${reason}），也无法移开（${(error as Error).message}），保存新的进度时会覆盖它`)
    }
    return []
  }

  /** @returns the progress of every repository that has any. */
  all(): readonly SyncProgress[] {
    return this.records
  }

  /**
   * @param id - catalog entry id.
   * @returns the progress, or undefined before the first attempt.
   */
  get(id: string): SyncProgress | undefined {
    return this.records.find(record => record.id === id)
  }

  /**
   * Change the progress of one repository and persist it.
   * @param id - catalog entry id.
   * @param change - returns the new progress (from the current one, after every change queued before it), or undefined to forget it.
   * @throws {RepoError} `unavailable` when the file cannot be written; nothing changes then.
   */
  update(id: string, change: (current: SyncProgress | undefined) => SyncProgress | undefined): Promise<void> {
    const run = this.queue.then(async () => {
      const next = change(this.get(id))
      const records = [...this.records.filter(record => record.id !== id), ...next === undefined ? [] : [next]]
      try {
        await writeJsonAtomic(this.file, { syncs: records })
      } catch (error) {
        throw new RepoError('unavailable', `无法写入本地同步进度 ${this.file}：${(error as Error).message}`)
      }
      this.records = records
    })
    // The queue only orders work; callers observe the failure through `run`.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}
