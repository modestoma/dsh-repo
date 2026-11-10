/**
 * `local-syncs.json`: each catalog repository's local sync progress (the
 * directory a first sync claimed and the last successful sync), keyed by the
 * catalog entry id. Which repository syncs where lives in the catalog. Every
 * change is a read-modify-write after the ones queued before it, written
 * atomically.
 *
 * @module dsh-repo/sync/store
 */

import { z } from 'zod'
import { JsonFile } from '../files.ts'
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
  private readonly json: JsonFile<readonly SyncProgress[]>

  /**
   * Read the file. A missing file means no progress; an unreadable or invalid
   * one is renamed to `<file>.invalid-<time>` and reported, and every sync
   * starts as a first sync.
   * @param file - absolute path of `local-syncs.json`.
   * @param logger - reports a set-aside file.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    this.json = new JsonFile<readonly SyncProgress[]>({
      file,
      label: '本地同步进度',
      schema: fileSchema.transform(content => content.syncs),
      empty: [],
      invalid: 'set-aside',
      encode: syncs => ({ syncs }),
      ...logger === undefined ? {} : { logger },
    })
  }

  /** @returns the progress of every repository that has any. */
  all(): readonly SyncProgress[] {
    return this.json.value
  }

  /**
   * @param id - catalog entry id.
   * @returns the progress, or undefined before the first attempt.
   */
  get(id: string): SyncProgress | undefined {
    return this.json.value.find(record => record.id === id)
  }

  /**
   * Change the progress of one repository and persist it.
   * @param id - catalog entry id.
   * @param change - returns the new progress (from the current one, after every change queued before it), or undefined to forget it.
   * @throws {RepoError} `unavailable` when the file cannot be written; nothing changes then.
   */
  update(id: string, change: (current: SyncProgress | undefined) => SyncProgress | undefined): Promise<void> {
    return this.json.update((current) => {
      const next = change(current.find(record => record.id === id))
      return { value: [...current.filter(record => record.id !== id), ...next === undefined ? [] : [next]], result: undefined }
    })
  }
}
