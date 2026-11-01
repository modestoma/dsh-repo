/**
 * The PR/MR watcher: polls each watched PR/MR, turns changes into activity,
 * batches it, and hands it to the watching Session.
 *
 * - Polls every `activeIntervalMs`, slowing to `quietIntervalMs` after
 *   `quietAfterMs` without activity unless CI is running or activity waits.
 *   Failed polls back off and are listed on the settings page; the cursor
 *   catches up once the host answers again.
 * - Activity whose action is `wake` starts a turn; `note` is added to the
 *   Session's next step while one of its Agents is live, and otherwise waits
 *   for the next turn. Activity is collected for `batchMs`; merge, close, and
 *   idle are delivered at once and end the watch.
 * - A watch ends when its PR/MR is merged or closed, after `idleDays`
 *   without activity, when its Session is gone, when its repository is no
 *   longer reachable through the configured hosts and repositories, or on
 *   request.
 * - Activity is removed from the record only after the Session acknowledged
 *   it; a failed acknowledgement can deliver the same activity again.
 *
 * @module dsh-repo/watch/watcher
 */

import type { ChangeInfo, RepoRef } from '../contract.ts'
import type { WatchSettings } from '../config.ts'
import type { HostLogger } from '../host.ts'
import type { ActivityRequest, ChangeActivity } from '../providers/types.ts'
import type { WatchAction, WatchEventKind, WatchInfo } from '../settings/contract.ts'
import { detect, FINAL_EVENTS, freshCursor, MAX_OWN_COMMENTS, MAX_OWN_HEADS, MAX_PENDING, renderMessage, watchId } from './activity.ts'
import type { WatchEvent, WatchRecord, WatchSource } from './activity.ts'
import type { WatchDelivery } from './delivery.ts'
import type { WatchStore } from './store.ts'

/** How long after the head moved CI keeps being read while no check has reported. */
const CHECKS_GRACE_MS = 10 * 60 * 1000
/** Most polls running at once. */
const CONCURRENT_POLLS = 4
/** Shortest wait between two timer runs. */
const MIN_TICK_MS = 1000
const DAY_MS = 86_400_000

/** The service calls the watcher makes. */
export interface WatchService {
  resolve(repo: string): RepoRef
  changeActivity(repo: string, number: number, request: ActivityRequest, options: { readonly signal?: AbortSignal }): Promise<ChangeActivity>
}

/** Collaborators of the watcher. */
export interface WatcherDeps {
  readonly service: WatchService
  readonly store: WatchStore
  /** Watch settings now in effect, read on every poll. */
  readonly settings: () => WatchSettings
  readonly delivery: WatchDelivery
  readonly logger?: HostLogger
  /** Current time; tests substitute it. */
  readonly now?: () => number
}

/** What starts or refreshes a watch. */
export interface TrackRequest {
  /** Repository target of the PR/MR. */
  readonly repo: string
  readonly change: ChangeInfo
  readonly session: string
  readonly source: WatchSource
  /** Head the tools just pushed. */
  readonly pushed?: string
}

function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function capped<T>(values: readonly T[], value: T, max: number): T[] {
  return values.includes(value) ? [...values] : [...values, value].slice(-max)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Polls watched PRs/MRs and delivers their activity. */
export class ChangeWatcher {
  private readonly now: () => number
  private readonly nextPoll = new Map<string, number>()
  private readonly running = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private abort: AbortController | undefined
  private ticking: Promise<void> | undefined

  /** @param deps - service, store, settings, and delivery. */
  constructor(private readonly deps: WatcherDeps) {
    this.now = deps.now ?? Date.now
  }

  /** @returns whether watching is on and this composition can start a turn of a Session. */
  get active(): boolean {
    return this.deps.settings().enabled && this.deps.delivery.available()
  }

  /** Start polling every stored watch. */
  start(): void {
    if (this.abort !== undefined) return
    this.abort = new AbortController()
    const now = this.now()
    for (const record of this.deps.store.all()) this.nextPoll.set(record.id, now)
    this.schedule()
  }

  /**
   * Stop polling and abort polls in flight; stored watches stay.
   * @returns after the polls in flight settled.
   */
  async stop(): Promise<void> {
    this.abort?.abort()
    this.abort = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.settled()
  }

  /** @returns after the polls running now, and the deliveries they make, finished. */
  async settled(): Promise<void> {
    while (this.ticking !== undefined) await this.ticking
  }

  /** @returns every watch for the settings page, most recent activity first. */
  list(): WatchInfo[] {
    return this.deps.store.all()
      .map(record => ({
        id: record.id,
        repo: `${record.host}/${record.path}`,
        number: record.number,
        title: record.title,
        webUrl: record.webUrl,
        session: record.session,
        source: record.source,
        startedAt: record.startedAt,
        lastActivityAt: record.lastActivityAt,
        failures: record.failures,
        ...record.lastError === undefined ? {} : { lastError: record.lastError },
        pending: record.pending.length,
      }))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  }

  /**
   * Start watching a PR/MR for a Session, or refresh the watch. A PR/MR the
   * tools opened or pushed to awaits CI of its head and reports comments
   * after its last update; one the model asked to watch reports what changes
   * after its first poll. Over `maxWatches`, the watch quiet longest ends.
   * @param request - the PR/MR, the Session, and why.
   * @returns the watch.
   * @throws {RepoError} `unavailable` when the watch cannot be stored.
   */
  async track(request: TrackRequest): Promise<WatchInfo> {
    const ref = this.deps.service.resolve(request.repo)
    const id = watchId(ref.host, ref.path, request.change.number, request.session)
    const now = this.now()
    const iso = new Date(now).toISOString()
    const { maxWatches } = this.deps.settings()
    const evicted: string[] = []
    await this.deps.store.update((current) => {
      const existing = current.find(record => record.id === id)
      const pushed = request.pushed
      let record: WatchRecord
      if (existing !== undefined) {
        const cursor = existing.cursor === undefined || pushed === undefined || existing.cursor.headSha === pushed
          ? existing.cursor
          : { ...existing.cursor, headSha: pushed, headMovedAt: iso, checks: 'pending' as const, failing: [] }
        record = {
          ...existing,
          title: request.change.title,
          lastActivityAt: iso,
          ...pushed === undefined ? {} : { ownHeads: capped(existing.ownHeads, pushed, MAX_OWN_HEADS) },
          ...cursor === undefined ? {} : { cursor },
        }
      } else {
        const since = request.source === 'created' ? request.change.createdAt : request.change.updatedAt
        record = {
          id,
          kind: ref.kind,
          host: ref.host,
          path: ref.path,
          number: request.change.number,
          title: request.change.title,
          webUrl: request.change.webUrl,
          session: request.session,
          source: request.source,
          startedAt: iso,
          lastActivityAt: iso,
          ...request.source === 'requested' ? {} : { cursor: freshCursor(request.change, since, iso) },
          ownComments: [],
          ownHeads: pushed === undefined ? [request.change.headSha] : [pushed],
          wakes: { day: localDay(now), count: 0 },
          pending: [],
          dropped: 0,
          failures: 0,
        }
      }
      const others = current.filter(entry => entry.id !== id)
      const keep = [...others].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, maxWatches - 1)
      for (const entry of others) if (!keep.includes(entry)) evicted.push(entry.id)
      return [...others.filter(entry => keep.includes(entry)), record]
    })
    for (const gone of evicted) {
      this.nextPoll.delete(gone)
      this.deps.logger?.info?.(`dsh-repo: 跟踪数达到上限 ${maxWatches}，停止跟踪最久没有动态的 ${gone}`)
    }
    this.nextPoll.set(id, now + this.deps.settings().activeIntervalMs)
    this.schedule()
    return this.list().find(info => info.id === id) as WatchInfo
  }

  /**
   * End watches of a PR/MR for a Session.
   * @param repo - repository target.
   * @param number - PR/MR number.
   * @param session - Session id.
   * @returns whether a watch ended.
   * @throws {RepoError} `unavailable` when the change cannot be stored.
   */
  async untrack(repo: string, number: number, session: string): Promise<boolean> {
    const ref = this.deps.service.resolve(repo)
    return await this.remove(watchId(ref.host, ref.path, number, session))
  }

  /**
   * End a watch by id.
   * @param id - watch id.
   * @returns whether it existed.
   * @throws {RepoError} `unavailable` when the change cannot be stored.
   */
  async remove(id: string): Promise<boolean> {
    let found = false
    await this.deps.store.update((current) => {
      found = current.some(record => record.id === id)
      return current.filter(record => record.id !== id)
    })
    this.nextPoll.delete(id)
    return found
  }

  /**
   * Remember a comment posted through the tools so no watch of its PR/MR reports it.
   * @param repo - repository target.
   * @param number - PR/MR number.
   * @param commentId - the posted comment's id.
   */
  async ownComment(repo: string, number: number, commentId: string): Promise<void> {
    const ref = this.deps.service.resolve(repo)
    if (!this.deps.store.all().some(record => record.host === ref.host && record.path === ref.path && record.number === number)) return
    const iso = new Date(this.now()).toISOString()
    await this.deps.store.update(current => current.map(record => record.host === ref.host && record.path === ref.path && record.number === number
      ? { ...record, ownComments: capped(record.ownComments, commentId, MAX_OWN_COMMENTS), lastActivityAt: iso }
      : record))
  }

  /** Arm the timer for the earliest due poll. */
  private schedule(): void {
    if (this.abort === undefined) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const due = Math.min(...this.nextPoll.values())
    if (!Number.isFinite(due)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.ticking = this.tick().finally(() => { this.ticking = undefined; this.schedule() })
    }, Math.max(MIN_TICK_MS, due - this.now()))
    this.timer.unref?.()
  }

  /** Poll every due watch, a few at a time. */
  private async tick(): Promise<void> {
    if (!this.deps.settings().enabled) {
      // Watching is off: look again after the quiet interval, keeping every watch.
      const later = this.now() + this.deps.settings().quietIntervalMs
      for (const id of this.nextPoll.keys()) this.nextPoll.set(id, later)
      return
    }
    const now = this.now()
    const due = [...this.nextPoll.entries()].filter(([id, at]) => at <= now && !this.running.has(id)).map(([id]) => id)
    for (let index = 0; index < due.length; index += CONCURRENT_POLLS) {
      await Promise.all(due.slice(index, index + CONCURRENT_POLLS).map(id => this.poll(id)))
    }
  }

  /** Poll one watch, deliver what is due, and set its next poll. */
  private async poll(id: string): Promise<void> {
    const signal = this.abort?.signal
    if (signal === undefined || signal.aborted) return
    this.running.add(id)
    try {
      await this.pollNow(id, signal)
    } catch (error) {
      // Only a failed store write reaches here; the watch stays as stored and is retried.
      this.deps.logger?.warn?.(`dsh-repo: 跟踪 ${id} 时保存失败：${errorText(error)}`)
      this.retryLater(id, 1)
    } finally {
      this.running.delete(id)
    }
  }

  private async pollNow(id: string, signal: AbortSignal): Promise<void> {
    const record = this.deps.store.get(id)
    if (record === undefined) {
      this.nextPoll.delete(id)
      return
    }
    const settings = this.deps.settings()
    const now = this.now()
    const iso = new Date(now).toISOString()
    if (now - Date.parse(record.lastActivityAt) >= settings.idleDays * DAY_MS) {
      await this.finish(record, [{ kind: 'idle', at: iso }])
      return
    }
    let activity: ChangeActivity
    try {
      activity = await this.deps.service.changeActivity(`${record.host}/${record.path}`, record.number, {
        ...record.cursor?.updatedAt === undefined ? {} : { updatedAt: record.cursor.updatedAt },
        withStatus: this.needsStatus(record, now),
        since: record.cursor?.since ?? record.startedAt,
      }, { signal })
    } catch (error) {
      if (signal.aborted) return
      if ((error as { code?: unknown }).code === 'not-allowed') {
        this.deps.logger?.info?.(`dsh-repo: ${record.host}/${record.path} 已不在可访问范围内，停止跟踪 ${id}`)
        await this.remove(id)
        return
      }
      await this.fail(id, `检查失败：${errorText(error)}`)
      return
    }
    const { cursor, events, touched } = detect(record, activity, iso)
    const ending = events.some(event => FINAL_EVENTS.has(event.kind))
    const kept = events.filter(event => this.action(event.kind) !== 'off')
    const updated = await this.merge(id, current => ({
      ...current,
      title: activity.change.title,
      webUrl: activity.change.webUrl,
      cursor,
      ...touched ? { lastActivityAt: iso } : {},
      ...this.enqueue(current, kept, iso),
      failures: 0,
      lastError: undefined,
    }))
    if (updated === undefined) return
    await this.flush(updated, ending)
  }

  /** CI is read while it may change: the head moved recently, CI runs, or it was never read. */
  private needsStatus(record: WatchRecord, now: number): boolean {
    const cursor = record.cursor
    if (cursor === undefined || cursor.checks === 'pending' || cursor.checks === 'unknown') return true
    return cursor.checks === 'none' && now - Date.parse(cursor.headMovedAt) < CHECKS_GRACE_MS
  }

  private action(kind: WatchEventKind): WatchAction {
    return this.deps.settings().events[kind]
  }

  /** Append events to the pending queue, dropping the oldest beyond {@link MAX_PENDING}. */
  private enqueue(record: WatchRecord, events: readonly WatchEvent[], iso: string): Pick<WatchRecord, 'pending' | 'dropped'> & { pendingSince?: string } {
    if (events.length === 0) return { pending: record.pending, dropped: record.dropped, ...record.pendingSince === undefined ? {} : { pendingSince: record.pendingSince } }
    const all = [...record.pending, ...events]
    const overflow = Math.max(0, all.length - MAX_PENDING)
    return { pending: all.slice(overflow), dropped: record.dropped + overflow, pendingSince: record.pendingSince ?? iso }
  }

  /**
   * Store a change computed from an earlier read, re-applying what the tools
   * recorded meanwhile: activity they caused is not reported.
   * @returns the stored watch, or undefined when it ended meanwhile.
   */
  private async merge(id: string, change: (current: WatchRecord) => WatchRecord): Promise<WatchRecord | undefined> {
    let result: WatchRecord | undefined
    await this.deps.store.update(current => current.map((record) => {
      if (record.id !== id) return record
      const next = change(record)
      const pending = next.pending.filter(event => !(event.item !== undefined && record.ownComments.includes(event.item.id)) && !(event.kind === 'pushed' && event.sha !== undefined && record.ownHeads.includes(event.sha)))
      result = { ...next, ownComments: record.ownComments, ownHeads: record.ownHeads, pending, pendingSince: pending.length === 0 ? undefined : next.pendingSince ?? pending[0]?.at }
      return result
    }))
    return result
  }

  /** End a watch with a final event, delivering it with whatever is pending. */
  private async finish(record: WatchRecord, events: readonly WatchEvent[]): Promise<void> {
    const kept = events.filter(event => this.action(event.kind) !== 'off')
    const updated = await this.merge(record.id, current => ({ ...current, ...this.enqueue(current, kept, events[0]?.at ?? new Date(this.now()).toISOString()) }))
    if (updated !== undefined) await this.flush(updated, true)
  }

  /**
   * Deliver pending activity when its batch window passed or the watch ends,
   * then end the watch or set its next poll.
   */
  private async flush(record: WatchRecord, ending: boolean): Promise<void> {
    const settings = this.deps.settings()
    const now = this.now()
    if (record.pending.length === 0) {
      if (ending) await this.remove(record.id)
      else this.nextPoll.set(record.id, now + this.interval(record, now))
      return
    }
    const pendingSince = Date.parse(record.pendingSince ?? new Date(now).toISOString())
    if (!ending && now - pendingSince < settings.batchMs) {
      this.nextPoll.set(record.id, Math.min(now + this.interval(record, now), pendingSince + settings.batchMs))
      return
    }
    const today = localDay(now)
    const wakesToday = record.wakes.day === today ? record.wakes.count : 0
    const wants = record.pending.some(event => this.action(event.kind) === 'wake')
    const limited = wants && !ending && wakesToday >= settings.dailyWakeLimit
    const wake = wants && !limited
    const message = renderMessage(record, record.pending, { wake, idleDays: settings.idleDays, limited })
    let outcome
    try {
      outcome = await this.deps.delivery.deliver(record.session, message, wake)
    } catch (error) {
      await this.fail(record.id, `通知会话失败：${errorText(error)}`)
      return
    }
    if (outcome === 'gone') {
      this.deps.logger?.info?.(`dsh-repo: 会话 ${record.session} 已不存在，停止跟踪 ${record.id}`)
      await this.remove(record.id)
      return
    }
    if (outcome === 'held') {
      if (ending) await this.remove(record.id)
      else this.nextPoll.set(record.id, now + this.interval(record, now))
      return
    }
    if (ending) {
      await this.remove(record.id)
      return
    }
    const delivered = new Set(record.pending)
    await this.merge(record.id, (current) => {
      const pending = current.pending.filter(event => !delivered.has(event))
      return { ...current, pending, pendingSince: pending[0]?.at, dropped: 0, wakes: { day: today, count: wakesToday + (wake ? 1 : 0) } }
    })
    this.nextPoll.set(record.id, now + this.interval(record, now))
  }

  /** The poll interval: active while CI runs, activity waits, or the PR/MR moved within `quietAfterMs`. */
  private interval(record: WatchRecord, now: number): number {
    const settings = this.deps.settings()
    const busy = record.cursor?.checks === 'pending' || record.pending.length > 0 || now - Date.parse(record.lastActivityAt) < settings.quietAfterMs
    return busy ? settings.activeIntervalMs : settings.quietIntervalMs
  }

  /** Record a failed poll or delivery and back off. */
  private async fail(id: string, reason: string): Promise<void> {
    const updated = await this.merge(id, current => ({ ...current, failures: current.failures + 1, lastError: reason }))
    if (updated !== undefined) this.retryLater(id, updated.failures)
  }

  /** Retry after the active interval, doubled per consecutive failure up to the quiet interval. */
  private retryLater(id: string, failures: number): void {
    const settings = this.deps.settings()
    const delay = Math.min(settings.quietIntervalMs, settings.activeIntervalMs * 2 ** Math.min(failures - 1, 10))
    this.nextPoll.set(id, this.now() + Math.max(settings.activeIntervalMs, delay))
  }
}
