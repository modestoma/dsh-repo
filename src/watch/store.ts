/**
 * `watches.json`: the watched PRs/MRs with their cursors and undelivered
 * activity, so a restart neither repeats nor loses activity. Every change is
 * a read-modify-write after the ones queued before it, written atomically.
 *
 * @module dsh-repo/watch/store
 */

import { z } from 'zod'
import { JsonFile } from '../files.ts'
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

const failedJobSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  stage: z.string().optional(),
  failureReason: z.string().optional(),
}).strict()

const ciFailureSchema = z.object({
  name: z.string(),
  runId: z.number().int().optional(),
  jobId: z.number().int().optional(),
  webUrl: z.string().optional(),
  jobs: z.array(failedJobSchema).optional(),
  jobsError: z.string().optional(),
}).strict()

const eventSchema = z.object({
  kind: z.enum(WATCH_EVENT_KINDS),
  at: z.string(),
  sha: z.string().optional(),
  checks: z.array(z.string()).optional(),
  failures: z.array(ciFailureSchema).optional(),
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
  private readonly json: JsonFile<readonly WatchRecord[]>

  /**
   * Read `watches.json`. A missing file means no watches; an unreadable or
   * invalid one is renamed to `watches.json.invalid-<time>` and reported, and
   * watching starts empty.
   * @param file - absolute path of `watches.json`.
   * @param logger - reports a set-aside file.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    this.json = new JsonFile<readonly WatchRecord[]>({
      file,
      label: 'PR/MR 跟踪记录',
      schema: fileSchema.transform(content => content.watches),
      empty: [],
      invalid: 'set-aside',
      encode: watches => ({ watches }),
      ...logger === undefined ? {} : { logger },
    })
  }

  /** @returns every watch. */
  all(): readonly WatchRecord[] {
    return this.json.value
  }

  /**
   * @param id - watch id.
   * @returns the watch, or undefined.
   */
  get(id: string): WatchRecord | undefined {
    return this.json.value.find(record => record.id === id)
  }

  /**
   * Change watches and persist them. `change` sees the current watches,
   * after every change queued before it.
   * @param change - returns the watches to store; ids not returned are removed.
   * @returns the stored watches.
   * @throws {RepoError} `unavailable` when the file cannot be written; nothing changes then.
   */
  update(change: (current: readonly WatchRecord[]) => readonly WatchRecord[]): Promise<readonly WatchRecord[]> {
    return this.json.update((current) => {
      const value = change(current)
      return { value, result: value }
    })
  }
}
