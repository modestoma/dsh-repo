/**
 * `syncs.json`: the local syncs and the result of each one's last successful
 * sync. Every change is a read-modify-write after the ones queued before it,
 * written atomically.
 *
 * @module dsh-repo/sync/store
 */

import { readFileSync, renameSync } from 'node:fs'
import { z } from 'zod'
import { RepoError } from '../errors.ts'
import { writeJsonAtomic } from '../files.ts'
import type { HostLogger } from '../host.ts'

/** One local sync as stored. */
export interface SyncRecord {
  readonly id: string
  readonly url: string
  readonly branch?: string
  readonly dir: string
  readonly intervalMinutes: number
  readonly createdAt: string
  /** Last successful sync; `dir` is the directory the sync's git index describes. */
  readonly last?: {
    readonly dir: string
    readonly commit: string
    readonly branch: string
    readonly syncedAt: string
  }
}

const recordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  url: z.string().min(1),
  branch: z.string().min(1).optional(),
  dir: z.string().min(1),
  intervalMinutes: z.number().int().positive(),
  createdAt: z.string(),
  last: z.object({
    dir: z.string().min(1),
    commit: z.string(),
    branch: z.string(),
    syncedAt: z.string(),
  }).strict().optional(),
}).strict()

const fileSchema = z.object({ syncs: z.array(recordSchema) }).strict()

/** The local syncs. */
export class SyncStore {
  private records: readonly SyncRecord[]
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Read `syncs.json`. A missing file means no syncs; an unreadable or
   * invalid one is renamed to `syncs.json.invalid-<time>` and reported, and
   * the list starts empty.
   * @param file - absolute path of `syncs.json`.
   * @param logger - reports a set-aside file.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    this.records = SyncStore.read(file, logger)
  }

  private static read(file: string, logger: HostLogger | undefined): SyncRecord[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      logger?.warn?.(`dsh-repo: 无法读取本地同步记录 ${file}，本次不同步任何仓库：${(error as Error).message}`)
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
      logger?.warn?.(`dsh-repo: 本地同步记录 ${file} 内容不合法（${reason}），已移到 ${aside}，本地同步列表重新开始`)
    } catch (error) {
      logger?.warn?.(`dsh-repo: 本地同步记录 ${file} 内容不合法（${reason}），也无法移开（${(error as Error).message}），保存新的本地同步时会覆盖它`)
    }
    return []
  }

  /** @returns every sync, in the order they were added. */
  all(): readonly SyncRecord[] {
    return this.records
  }

  /**
   * @param id - sync id.
   * @returns the sync, or undefined.
   */
  get(id: string): SyncRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  /**
   * Change syncs and persist them. `change` sees the current syncs, after
   * every change queued before it.
   * @param change - returns the syncs to store.
   * @returns the stored syncs.
   * @throws {RepoError} `unavailable` when the file cannot be written; nothing changes then. Whatever `change` throws.
   */
  update(change: (current: readonly SyncRecord[]) => readonly SyncRecord[]): Promise<readonly SyncRecord[]> {
    const run = this.queue.then(async () => {
      const next = change(this.records)
      try {
        await writeJsonAtomic(this.file, { syncs: next })
      } catch (error) {
        throw new RepoError('unavailable', `无法写入本地同步记录 ${this.file}：${(error as Error).message}`)
      }
      this.records = next
      return next
    })
    // The queue only orders work; callers observe the failure through `run`.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}
