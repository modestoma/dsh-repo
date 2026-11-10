/**
 * The repository catalog: the only repositories dsh-repo reaches, each with
 * the access it allows, the features other plugins turned on for it, and its
 * local sync.
 *
 * - The catalog is stored in the settings file and changed by the settings
 *   page or {@link RepoCatalog.ensure}; every change is a read-modify-write
 *   after the ones queued before it.
 * - A repository is identified by its key: `host/path` (lowercase) of its
 *   address on a configured host. An address on a host that is not configured cannot be added, and an
 *   entry whose host was removed afterwards matches nothing until the host is
 *   added again.
 * - Features are registered by other plugins at run time and are only
 *   labels: switches stay stored while their plugin is not loaded.
 * - Local sync directories must not overlap each other or the mirror
 *   directory, compared on real paths.
 *
 * @module dsh-repo/catalog
 */

import { randomBytes } from 'node:crypto'
import type { HostSpec } from '../config.ts'
import type { CatalogRepo, RepoAccess, RepoAddResult, RepoFeature, RepoTarget } from '../contract.ts'
import { RepoError } from '../errors.ts'
import type { HostLogger } from '../host.ts'
import type { SettingsStore } from '../settings/store.ts'
import { overlaps, realPathOf } from '../paths.ts'
import { ACCESS_LEVELS, MAX_REPO_FEATURES, MAX_REPOS } from '../settings/contract.ts'
import type { RepoInput } from '../settings/contract.ts'
import { resolveTarget } from '../target.ts'
import type { ResolvedTarget } from '../target.ts'
import { requireBranch } from '../refs.ts'
import { allows, checkFeature, checkFeatureIds, checkInput, publicRepo } from './entry.ts'
import type { CatalogEntry, CheckedInput } from './entry.ts'

/** Collaborators of the catalog. */
export interface CatalogDeps {
  /** Settings file holding the catalog and the hosts. */
  readonly store: SettingsStore
  /** @returns the mirror directory now in use; local sync directories must stay outside it. */
  readonly mirrorDir: () => string | undefined
  /** Reports a throwing change listener. */
  readonly logger?: HostLogger
  /** Current time; tests substitute it. */
  readonly now?: () => number
}

/** Label of an access level for messages. */
export function accessLabel(access: RepoAccess): string {
  return ACCESS_LEVELS.find(level => level.id === access)?.label ?? access
}

/**
 * The catalog key of an address.
 * @param url - accepted git address, `host/path`, or a PR/MR URL.
 * @param hosts - configured hosts.
 * @returns the repository's web address without its scheme (host, the host's path prefix, and the repository path) in lowercase. The path prefix keeps repositories of two instances on one host name apart.
 * @throws {RepoError} `invalid` for an unreadable address, `not-allowed` when no configured host serves it.
 */
export function catalogKey(url: string, hosts: readonly HostSpec[]): string {
  return keyOfTarget(resolveTarget(url.trim(), hosts))
}

function keyOfTarget(target: ResolvedTarget): string {
  return target.webUrl.replace(/^https?:\/\//, '').toLowerCase()
}

/** A repository the catalog allows a call on, resolved once. */
export interface CatalogHandle {
  /** The catalog entry holding the repository. */
  readonly entry: CatalogEntry
  /** Catalog key of the repository. */
  readonly key: string
  /** The repository resolved to its host. */
  readonly target: ResolvedTarget
}

/** Repositories dsh-repo may reach, with their access, features, and local syncs. */
export class RepoCatalog {
  private readonly features = new Map<string, { readonly feature: RepoFeature; readonly token: symbol }>()
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number

  /** @param deps - settings file, mirror directory, and logger. */
  constructor(private readonly deps: CatalogDeps) {
    this.now = deps.now ?? Date.now
  }

  /** @returns every entry in catalog order. */
  entries(): readonly CatalogEntry[] {
    return this.deps.store.repos()
  }

  /**
   * The key of an entry under the current hosts.
   * @param entry - stored entry.
   * @returns the key, or the reason the entry matches nothing now.
   */
  keyOf(entry: CatalogEntry): { readonly key: string } | { readonly problem: string } {
    try {
      return { key: catalogKey(entry.url, this.deps.store.all()) }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The entry holding a repository.
   * @param target - repository address, `host/path`, or PR/MR URL.
   * @returns the entry, or undefined when the catalog does not hold it.
   * @throws {RepoError} `invalid` for an unreadable target, `not-allowed` when no configured host serves it.
   */
  find(target: RepoTarget): CatalogEntry | undefined {
    return this.withKey(catalogKey(target, this.deps.store.all()))
  }

  /**
   * Resolve a repository and require it in the catalog with at least an access level.
   * @param target - repository address, `host/path`, or PR/MR URL.
   * @param needed - access the call needs.
   * @returns the entry, the key, and the resolved target.
   * @throws {RepoError} `not-allowed` without a configured host, when the catalog does not hold the repository, or when its access is lower; `invalid` for an unreadable target.
   */
  open(target: RepoTarget, needed: RepoAccess): CatalogHandle {
    const resolved = resolveTarget(target.trim(), this.deps.store.all())
    const key = keyOfTarget(resolved)
    const entry = this.withKey(key)
    if (entry === undefined) throw new RepoError('not-allowed', `${key} 不在 dsh-repo 的仓库清单中，不能访问；请管理员在「代码仓库 → 仓库」中添加`)
    if (!allows(entry.access, needed)) {
      throw new RepoError('not-allowed', `${key} 在仓库清单中的权限是「${accessLabel(entry.access)}」，这次操作需要「${accessLabel(needed)}」；请管理员在「代码仓库 → 仓库」中调整`)
    }
    return { entry, key, target: resolved }
  }

  /**
   * Require a repository to be in the catalog with at least an access level.
   * @param target - repository address, `host/path`, or PR/MR URL.
   * @param needed - access the call needs.
   * @returns the entry.
   * @throws {RepoError} see {@link open}.
   */
  require(target: RepoTarget, needed: RepoAccess): CatalogEntry {
    return this.open(target, needed).entry
  }

  /**
   * The public view of the entries.
   * @param options - only the entries with this feature turned on.
   * @returns the entries in catalog order.
   */
  list(options: { readonly feature?: string } = {}): readonly CatalogRepo[] {
    const { feature } = options
    return this.entries().filter(entry => feature === undefined || entry.features.includes(feature)).map(publicRepo)
  }

  /** @returns the highest access any reachable entry allows, or undefined for an empty catalog. */
  highestAccess(): RepoAccess | undefined {
    let highest: RepoAccess | undefined
    for (const entry of this.entries()) {
      if (!('key' in this.keyOf(entry))) continue
      if (highest === undefined || allows(entry.access, highest)) highest = entry.access
    }
    return highest
  }

  /** @returns the registered features in registration order. */
  registeredFeatures(): RepoFeature[] {
    return [...this.features.values()].map(item => item.feature)
  }

  /**
   * Register a feature; the latest registration of an id wins.
   * @param feature - id, title, and description.
   * @returns disposer that withdraws this registration (a later one of the same id stays).
   * @throws {RepoError} `invalid` for a bad field.
   */
  registerFeature(feature: RepoFeature): () => void {
    const checked = checkFeature(feature)
    const token = Symbol(checked.id)
    this.features.set(checked.id, { feature: checked, token })
    this.emit()
    return () => {
      if (this.features.get(checked.id)?.token !== token) return
      this.features.delete(checked.id)
      this.emit()
    }
  }

  /**
   * Observe catalog changes and feature registrations.
   * @param listener - runs after each change.
   * @returns disposer that stops the observation.
   */
  onChange(listener: () => void): () => void {
    const entry = (): void => { listener() }
    this.listeners.add(entry)
    return () => { this.listeners.delete(entry) }
  }

  /**
   * Add an entry from the settings page.
   * @param input - the entry's fields.
   * @returns the stored entry.
   * @throws {RepoError} `invalid` for a bad field, `not-allowed` for an address on an unconfigured host, `conflict` when another entry holds the repository or a local sync directory overlaps, `too-large` past {@link MAX_REPOS}, `unavailable` when the file cannot be written.
   */
  async add(input: RepoInput): Promise<CatalogEntry> {
    const checked = checkInput(input)
    const key = catalogKey(checked.url, this.deps.store.all())
    const real = await this.realPaths(checked)
    const added = await this.deps.store.updateRepos((current) => {
      if (current.length >= MAX_REPOS) throw new RepoError('too-large', `仓库清单最多 ${MAX_REPOS} 个仓库`)
      this.checkUnique(key, current, undefined)
      this.checkSyncDir(checked, current, undefined, real)
      const entry: CatalogEntry = { id: randomBytes(6).toString('hex'), ...checked, features: [...checked.features], addedAt: new Date(this.now()).toISOString() }
      return { repos: [...current, entry], result: entry }
    })
    this.emit()
    return added
  }

  /**
   * Replace an entry's fields from the settings page.
   * @param id - entry id.
   * @param input - the complete new fields.
   * @returns the stored entry.
   * @throws {RepoError} `not-found`, plus the failures of {@link add}.
   */
  async update(id: string, input: RepoInput): Promise<CatalogEntry> {
    const checked = checkInput(input)
    const key = catalogKey(checked.url, this.deps.store.all())
    const real = await this.realPaths(checked)
    const updated = await this.deps.store.updateRepos((current) => {
      const existing = current.find(entry => entry.id === id)
      if (existing === undefined) throw new RepoError('not-found', '仓库清单中没有这个仓库，可能已经删除')
      this.checkUnique(key, current, id)
      this.checkSyncDir(checked, current, id, real)
      const entry: CatalogEntry = { id, ...checked, features: [...checked.features], addedAt: existing.addedAt }
      return { repos: current.map(item => item.id === id ? entry : item), result: entry }
    })
    this.emit()
    return updated
  }

  /**
   * Remove an entry. Files in its local sync directory stay.
   * @param id - entry id.
   * @returns the removed entry, or undefined when there was none.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  async remove(id: string): Promise<CatalogEntry | undefined> {
    if (!this.entries().some(entry => entry.id === id)) return undefined
    const removed = await this.deps.store.updateRepos(current => ({ repos: current.filter(entry => entry.id !== id), result: current.find(entry => entry.id === id) }))
    if (removed !== undefined) this.emit()
    return removed
  }

  /**
   * Add a repository, or turn features on for the entry holding it.
   * @param url - repository address.
   * @param options - branch, access, and features; `session` is asked about by the caller before this runs.
   * @param authorize - runs once a change is certain and before it is stored; rejects to refuse.
   * @returns the outcome and the entry.
   * @throws {RepoError} `invalid`, `not-allowed`, `conflict` for another branch, `too-large`, `unavailable`, and whatever `authorize` rejects with.
   */
  async ensure(url: string, options: { readonly branch?: string; readonly access?: RepoAccess; readonly features?: readonly string[] }, authorize: (summary: string) => Promise<void>): Promise<RepoAddResult> {
    const trimmed = url.trim()
    const branch = options.branch?.trim()
    if (branch !== undefined && branch !== '') requireBranch(branch, '分支名')
    const features = checkFeatureIds(options.features ?? [])
    const checked = checkInput({ url: trimmed, ...branch === undefined || branch === '' ? {} : { branch }, access: options.access ?? 'read', features })
    const key = catalogKey(checked.url, this.deps.store.all())
    const existing = this.find(checked.url)
    if (existing !== undefined && (checked.branch ?? '') !== '' && checked.branch !== existing.branch) {
      throw new RepoError('conflict', `${key} 已在仓库清单中，跟随${existing.branch === undefined ? '默认分支' : `分支 ${existing.branch}`}；改分支请在「代码仓库 → 仓库」中操作`)
    }
    const missing = existing === undefined ? features : features.filter(id => !existing.features.includes(id))
    if (existing !== undefined && missing.length === 0) return { status: 'unchanged', repo: publicRepo(existing) }
    const names = missing.map(id => this.features.get(id)?.feature.title ?? id).join('、')
    await authorize(existing === undefined
      ? `把 ${key} 加入 dsh-repo 仓库清单（权限：${accessLabel(checked.access)}${names === '' ? '' : `；打开功能：${names}`}）`
      : `为仓库清单中的 ${key} 打开功能：${names}`)
    type Outcome = { readonly status: RepoAddResult['status']; readonly entry: CatalogEntry }
    const outcome = await this.deps.store.updateRepos<Outcome>((current) => {
      const held = current.find((entry) => {
        const own = this.keyOf(entry)
        return 'key' in own && own.key === key
      })
      if (held !== undefined) {
        // Another call may have stored the entry, on another branch, while this one was being authorized.
        if (checked.branch !== undefined && checked.branch !== held.branch) {
          throw new RepoError('conflict', `${key} 已在仓库清单中，跟随${held.branch === undefined ? '默认分支' : `分支 ${held.branch}`}；改分支请在「代码仓库 → 仓库」中操作`)
        }
        const next: CatalogEntry = { ...held, features: [...new Set([...held.features, ...features])] }
        if (next.features.length === held.features.length) return { repos: current, result: { status: 'unchanged', entry: held } }
        if (next.features.length > MAX_REPO_FEATURES) throw new RepoError('invalid', `一个仓库最多打开 ${MAX_REPO_FEATURES} 个功能，${key} 已有 ${held.features.length} 个`)
        return { repos: current.map(entry => entry.id === held.id ? next : entry), result: { status: 'updated', entry: next } }
      }
      if (current.length >= MAX_REPOS) throw new RepoError('too-large', `仓库清单最多 ${MAX_REPOS} 个仓库`)
      const entry: CatalogEntry = { id: randomBytes(6).toString('hex'), ...checked, features: [...features], addedAt: new Date(this.now()).toISOString() }
      return { repos: [...current, entry], result: { status: 'added', entry } }
    })
    if (outcome.status !== 'unchanged') this.emit()
    return { status: outcome.status, repo: publicRepo(outcome.entry) }
  }

  private withKey(key: string): CatalogEntry | undefined {
    return this.entries().find((entry) => {
      const own = this.keyOf(entry)
      return 'key' in own && own.key === key
    })
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.deps.logger?.error?.('dsh-repo: 仓库清单变更监听器出错：%s', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private checkUnique(key: string, current: readonly CatalogEntry[], self: string | undefined): void {
    const other = current.find((entry) => {
      if (entry.id === self) return false
      const own = this.keyOf(entry)
      return 'key' in own && own.key === key
    })
    if (other !== undefined) throw new RepoError('conflict', `${key} 已在仓库清单中（${other.url}）`)
  }

  /**
   * Real paths of a candidate's local sync directory, the mirror directory,
   * and every enabled local sync directory, read before the catalog changes so
   * the check itself stays synchronous.
   */
  private async realPaths(input: CheckedInput): Promise<Map<string, string>> {
    if (input.localSync?.enabled !== true) return new Map()
    const mirrors = this.deps.mirrorDir()
    const paths = [input.localSync.dir, ...mirrors === undefined ? [] : [mirrors], ...this.entries().flatMap(entry => entry.localSync?.enabled === true ? [entry.localSync.dir] : [])]
    return new Map(await Promise.all(paths.map(async path => [path, await realPathOf(path)] as const)))
  }

  /**
   * Refuse an enabled local sync directory that overlaps the mirror directory
   * or another enabled entry's directory.
   * @throws {RepoError} `conflict`.
   */
  private checkSyncDir(input: CheckedInput, current: readonly CatalogEntry[], self: string | undefined, real: ReadonlyMap<string, string>): void {
    if (input.localSync?.enabled !== true) return
    const { dir } = input.localSync
    const mirrors = this.deps.mirrorDir()
    if (mirrors !== undefined && overlaps(mirrors, dir, real)) throw new RepoError('conflict', `本地同步目录 ${dir} 与镜像目录 ${mirrors} 重叠，请换一个目录`)
    const other = current.find(entry => entry.id !== self && entry.localSync?.enabled === true && overlaps(entry.localSync.dir, dir, real))
    if (other !== undefined) throw new RepoError('conflict', `本地同步目录 ${dir} 与 ${other.url} 的本地同步目录 ${other.localSync?.dir ?? ''} 重叠，请换一个目录`)
  }
}
