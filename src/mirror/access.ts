/**
 * The mirrors as the rest of the plugin reaches them: the chosen mirror
 * directory, which is checked against the forbidden roots and stored in the
 * settings file, mirror fetches that require the address in the catalog and
 * hand git the host's token, and the state of each catalog address's latest
 * fetch since the plugin started or the mirror directory changed.
 *
 * @module dsh-repo/mirror/access
 */

import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import type { RepoCatalog } from '../catalog/catalog.ts'
import { RepoError } from '../errors.ts'
import type { HostRegistry } from '../forge/hosts.ts'
import type { HostLogger } from '../host.ts'
import type { MirrorSettings, MirrorStatus, MirrorUsage } from '../settings/contract.ts'
import type { SettingsStore } from '../settings/store.ts'
import { credentialEnvironment } from './git.ts'
import { checkMirrorDir } from './root.ts'
import type { MirrorState, MirrorStore } from './store.ts'

/** A branch a repository is required to have, with what it is for. */
export interface RequiredBranch {
  readonly name: string
  /** Field the branch was entered in, for the message, e.g. `基线分支`. */
  readonly label: string
}

/** Collaborators of {@link Mirrors}. */
export interface MirrorsDeps {
  /** Local mirrors. */
  readonly store: MirrorStore
  /** Settings file holding the chosen mirror directory. */
  readonly settings: SettingsStore
  readonly catalog: RepoCatalog
  readonly hosts: HostRegistry
  /**
   * Roots the mirror directory may not be or lie in; see `forbiddenMirrorRoots`.
   * The stored choice is checked against them at construction and every new
   * choice before it is saved.
   */
  readonly forbiddenRoots: readonly string[]
  readonly logger?: HostLogger
  /** Current time; tests substitute it. */
  readonly now?: () => number
}

/** The mirror directory and catalog-checked mirror fetches. */
export class Mirrors {
  /** Local mirrors. */
  readonly store: MirrorStore
  /** Why the stored mirror directory is not in use, while it was rejected at construction. */
  private problem: string | undefined
  /** How the latest finished fetch of each catalog address ended (`ready` or `failed`), keyed by the address as the catalog stores it. */
  private readonly settled = new Map<string, MirrorStatus>()
  /** Fetches running for each catalog address, keyed like {@link settled}. */
  private readonly running = new Map<string, number>()
  /** Background fetches running, keyed like {@link settled}, with the {@link generation} they started in. */
  private readonly background = new Map<string, { readonly generation: number; readonly done: Promise<void> }>()
  /** Incremented when the mirror directory changes, so fetches begun for the previous directory neither report a state nor stand in for a fetch of the new one. */
  private generation = 0
  private readonly now: () => number

  /**
   * A mirror directory stored in the settings file replaces the store's
   * starting root; one that breaks the rules is left unused and reported by
   * {@link settings} until it is replaced or cleared.
   * @param deps - mirror store, settings file, catalog, hosts, forbidden roots, and logger.
   */
  constructor(private readonly deps: MirrorsDeps) {
    this.store = deps.store
    this.now = deps.now ?? Date.now
    const stored = deps.settings.mirrorDir()
    if (stored === undefined) return
    try {
      this.store.setRoot(checkMirrorDir(stored, deps.forbiddenRoots))
    } catch (error) {
      this.store.setRoot(undefined)
      this.problem = `设置文件里的镜像目录不可用，镜像操作已停用：${error instanceof Error ? error.message : String(error)}`
      deps.logger?.error?.('dsh-repo: %s', this.problem)
    }
  }

  /** @returns the mirror directory in use, and why the stored one is not, if it was rejected. */
  settings(): MirrorSettings {
    return { dir: this.store.root, ...this.problem === undefined ? {} : { problem: this.problem } }
  }

  /**
   * Choose the mirror directory, creating it, or clear the choice.
   * @param dir - absolute directory, or undefined to clear it.
   * @returns the mirror settings now in effect.
   * @throws {RepoError} `invalid` for a forbidden, unwritable, or uncreatable directory, `unavailable` when the settings file cannot be written.
   */
  async setDir(dir: string | undefined): Promise<MirrorSettings> {
    const target = dir === undefined ? undefined : checkMirrorDir(dir, this.deps.forbiddenRoots)
    if (target !== undefined) {
      try {
        await mkdir(target, { recursive: true })
        await access(target, constants.W_OK)
      } catch (error) {
        throw new RepoError('invalid', `无法创建或写入镜像目录 ${target}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.deps.settings.setMirrorDir(target)
    this.store.setRoot(target)
    this.problem = undefined
    // Mirrors in the new directory are cloned afresh, so earlier states say nothing about them.
    this.generation += 1
    this.settled.clear()
    this.running.clear()
    this.deps.hosts.notify({ kind: 'mirror', dir: target })
    return this.settings()
  }

  /**
   * Disk usage of the current mirror directory.
   * @returns each mirror with its address and last fetch, the snapshots, and the totals.
   * @throws {RepoError} `unavailable` when the directory cannot be read.
   */
  async usage(): Promise<MirrorUsage> {
    return await this.store.usage()
  }

  /**
   * Clone or fetch the mirror of a catalog address and resolve a branch head.
   * @param url - catalog address.
   * @param options - branch (default: the remote's default branch) and cancellation.
   * @returns the mirror state.
   * @throws {RepoError} `not-allowed` outside the catalog, `unavailable` while no mirror directory is set, and the mirror's failures.
   */
  async sync(url: string, options: { readonly branch?: string; readonly signal?: AbortSignal } = {}): Promise<MirrorState> {
    const generation = this.generation
    this.running.set(url, (this.running.get(url) ?? 0) + 1)
    try {
      const env = await this.auth(url)
      const state = await this.store.sync(url, options.branch, env, options.signal)
      if (generation === this.generation) this.settled.set(url, { state: 'ready', fetchedAt: new Date(this.now()).toISOString() })
      return state
    } catch (error) {
      if (generation === this.generation) this.record(url, error, options.signal)
      throw error
    } finally {
      if (generation === this.generation) {
        const left = (this.running.get(url) ?? 1) - 1
        if (left > 0) this.running.set(url, left)
        else this.running.delete(url)
      }
    }
  }

  /** Record how a fetch of `url` ended after it threw; a fetch running beside it records its own outcome. */
  private record(url: string, error: unknown, signal: AbortSignal | undefined): void {
    const code = error instanceof RepoError ? error.code : undefined
    if (code === 'not-found') {
      // The fetch succeeded; the requested branch or commit is what is missing.
      this.settled.set(url, { state: 'ready', fetchedAt: new Date(this.now()).toISOString() })
    } else if (signal?.aborted !== true && code !== 'not-allowed') {
      // A cancelled call, or an address outside the catalog, says nothing about the mirror.
      const fetchedAt = this.settled.get(url)?.fetchedAt
      this.settled.set(url, { state: 'failed', ...fetchedAt === undefined ? {} : { fetchedAt }, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The fetch state of a catalog address: `fetching` while any fetch of it runs, else how the latest finished fetch ended.
   * @param url - address as the catalog stores it.
   * @returns the state with the time of the last successful fetch, or undefined before the first fetch since the plugin started or the mirror directory changed.
   */
  status(url: string): MirrorStatus | undefined {
    const last = this.settled.get(url)
    if (!this.running.has(url)) return last
    return { state: 'fetching', ...last?.fetchedAt === undefined ? {} : { fetchedAt: last.fetchedAt } }
  }

  /**
   * Fetch a catalog address in the background; a fetch already running in the background for the current mirror directory is not started again.
   * @param url - address as the catalog stores it.
   * @returns when the fetch ended; its failure is recorded in {@link status}, never thrown.
   */
  prefetch(url: string): Promise<void> {
    const running = this.background.get(url)
    if (running !== undefined && running.generation === this.generation) return running.done
    const entry = {
      generation: this.generation,
      done: this.sync(url).then(() => undefined, (error: unknown) => {
        this.deps.logger?.warn?.('dsh-repo: 后台拉取 %s 失败：%s', url, error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (this.background.get(url) === entry) this.background.delete(url)
      }),
    }
    this.background.set(url, entry)
    return entry.done
  }

  /**
   * Check that a repository on a configured host can be reached with its host's token and has the given branches.
   * Contacts the remote with the API deadline; the catalog is not consulted, so a repository can be checked before it is added.
   * @param url - accepted git address.
   * @param branches - branches the repository must have.
   * @param signal - cancellation.
   * @throws {RepoError} `invalid` naming the first missing branch, `not-allowed` without a configured host, `unauthenticated` when the host's token is unset, `unavailable` when the remote cannot be reached or refuses the token.
   */
  async checkRemote(url: string, branches: readonly RequiredBranch[], signal?: AbortSignal): Promise<void> {
    const credentials = await this.deps.hosts.gitCredentials(url)
    const env = credentialEnvironment(credentials.hostUrl, credentials.username, credentials.token)
    const remote = await this.store.remoteBranches(url, env, this.deps.settings.settings().timeoutMs, signal)
    const missing = branches.find(branch => !remote.branches.includes(branch.name))
    if (missing !== undefined) throw new RepoError('invalid', `${url} 没有分支 ${missing.name}（${missing.label}）`)
  }

  /**
   * The branches a catalog address's mirror holds, without contacting the remote.
   * @param url - address as the catalog stores it.
   * @returns the sorted branches and the default branch; no branches before the first fetch.
   * @throws {RepoError} `unavailable` while no mirror directory is set or git fails.
   */
  async branches(url: string): Promise<{ readonly branches: readonly string[]; readonly defaultBranch?: string }> {
    return await this.store.localBranches(url)
  }

  /**
   * Environment of a mirror's network commands: the host's token, handed to
   * git through a credential helper that only this command sees.
   * @param url - accepted git address.
   * @param push - whether the command writes, which needs `write` access.
   * @returns the environment.
   * @throws {RepoError} `invalid` for an unsupported address, `not-allowed` outside the catalog or below the access the command needs, `unauthenticated` when the host's token is unset.
   */
  async auth(url: string, push = false): Promise<Record<string, string>> {
    this.store.dirOf(url)
    this.deps.catalog.require(url, push ? 'write' : 'read')
    const credentials = await this.deps.hosts.gitCredentials(url)
    return credentialEnvironment(credentials.hostUrl, credentials.username, credentials.token)
  }
}
