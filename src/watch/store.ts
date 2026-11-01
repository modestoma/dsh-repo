/**
 * `watches.json`: the watched PRs/MRs with their cursors and undelivered
 * activity, so a restart neither repeats nor loses activity. Every change is
 * a read-modify-write after the ones queued before it, written atomically.
 *
 * @module dsh-repo/watch/store
 */

import { readFileSync, renameSync } from 'node:fs'
import { z } from 'zod'
import { RepoError } from '../errors.ts'
import { writeJsonAtomic } from '../files.ts'
import type { HostLogger } from '../host.ts'
import { WATCH_EVENT_KINDS } from '../settings/contract.ts'
import type { WatchRecord } from './activity.ts'

const itemSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  webUrl: z.string().optional(),
  path: z.string().optional(),
}).strict()

const eventSchema = z.object({
  kind: z.enum(WATCH_EVENT_KINDS),
  at: z.string(),
  sha: z.string().optional(),
  checks: z.array(z.string()).optional(),
  item: itemSchema.optional(),
}).strict()

const cursorSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']),
  headSha: z.string(),
  headMovedAt: z.string(),
  updatedAt: z.string().optional(),
  checks: z.enum(['success', 'failure', 'pending', 'none', 'unknown']),
  failing: z.array(z.string()),
  conflict: z.boolean(),
  since: z.string(),
  seen: z.array(z.string()),
}).strict()

const recordSchema = z.object({
  id: z.string(),
  kind: z.enum(['github', 'gitlab']),
  host: z.string(),
  path: z.string(),
  number: z.number().int().min(1),
  title: z.string(),
  webUrl: z.string(),
  session: z.string(),
  source: z.enum(['created', 'pushed', 'requested']),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  cursor: cursorSchema.optional(),
  ownComments: z.array(z.string()),
  ownHeads: z.array(z.string()),
  wakes: z.object({ day: z.string(), count: z.number().int().min(0) }).strict(),
  pending: z.array(eventSchema),
  pendingSince: z.string().optional(),
  dropped: z.number().int().min(0),
  failures: z.number().int().min(0),
  lastError: z.string().optional(),
}).strict()

const fileSchema = z.object({ watches: z.array(recordSchema) }).strict()

/** The watched PRs/MRs. */
export class WatchStore {
  private records: Map<string, WatchRecord>
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Read `watches.json`. A missing file means no watches; an unreadable or
   * invalid one is renamed to `watches.json.invalid-<time>` and reported, and
   * watching starts empty.
   * @param file - absolute path of `watches.json`.
   * @param logger - reports a set-aside file.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    this.records = new Map(WatchStore.read(file, logger).map(record => [record.id, record]))
  }

  private static read(file: string, logger: HostLogger | undefined): WatchRecord[] {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      logger?.warn?.(`dsh-repo: 无法读取 PR/MR 跟踪记录 ${file}，本次不跟踪任何 PR/MR：${(error as Error).message}`)
      return []
    }
    let reason: string
    try {
      const parsed = fileSchema.safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data.watches
      reason = parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')
    } catch (error) {
      reason = `不是合法 JSON：${(error as Error).message}`
    }
    const aside = `${file}.invalid-${Date.now()}`
    try {
      renameSync(file, aside)
      logger?.warn?.(`dsh-repo: PR/MR 跟踪记录 ${file} 内容不合法（${reason}），已移到 ${aside}，重新开始跟踪`)
    } catch (error) {
      logger?.warn?.(`dsh-repo: PR/MR 跟踪记录 ${file} 内容不合法（${reason}），也无法移开（${(error as Error).message}），保存新的跟踪记录时会覆盖它`)
    }
    return []
  }

  /** @returns every watch. */
  all(): readonly WatchRecord[] {
    return [...this.records.values()]
  }

  /**
   * @param id - watch id.
   * @returns the watch, or undefined.
   */
  get(id: string): WatchRecord | undefined {
    return this.records.get(id)
  }

  /**
   * Change watches and persist them. `change` sees the current watches,
   * after every change queued before it.
   * @param change - returns the watches to store; ids not returned are removed.
   * @returns the stored watches.
   * @throws {RepoError} `unavailable` when the file cannot be written; nothing changes then.
   */
  update(change: (current: readonly WatchRecord[]) => readonly WatchRecord[]): Promise<readonly WatchRecord[]> {
    const run = this.queue.then(async () => {
      const next = change(this.all())
      try {
        await writeJsonAtomic(this.file, { watches: next })
      } catch (error) {
        throw new RepoError('unavailable', `无法写入 PR/MR 跟踪记录 ${this.file}：${(error as Error).message}`)
      }
      this.records = new Map(next.map(record => [record.id, record]))
      return next
    })
    // The queue only orders work; callers observe the failure through `run`.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}
