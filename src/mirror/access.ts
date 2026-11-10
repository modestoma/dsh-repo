/**
 * The mirrors as the rest of the plugin reaches them: the chosen mirror
 * directory, which is checked against the forbidden roots and stored in the
 * settings file, and mirror fetches that require the address in the catalog
 * and hand git the host's token.
 *
 * @module dsh-repo/mirror/access
 */

import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import type { RepoCatalog } from '../catalog/catalog.ts'
import { RepoError } from '../errors.ts'
import type { HostRegistry } from '../forge/hosts.ts'
import type { HostLogger } from '../host.ts'
import type { MirrorSettings, MirrorUsage } from '../settings/contract.ts'
import type { SettingsStore } from '../settings/store.ts'
import { credentialEnvironment } from './git.ts'
import { checkMirrorDir } from './root.ts'
import type { MirrorState, MirrorStore } from './store.ts'

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
}

/** The mirror directory and catalog-checked mirror fetches. */
export class Mirrors {
  /** Local mirrors. */
  readonly store: MirrorStore
  /** Why the stored mirror directory is not in use, while it was rejected at construction. */
  private problem: string | undefined

  /**
   * A mirror directory stored in the settings file replaces the store's
   * starting root; one that breaks the rules is left unused and reported by
   * {@link settings} until it is replaced or cleared.
   * @param deps - mirror store, settings file, catalog, hosts, forbidden roots, and logger.
   */
  constructor(private readonly deps: MirrorsDeps) {
    this.store = deps.store
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
    const env = await this.auth(url)
    return await this.store.sync(url, options.branch, env, options.signal)
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
