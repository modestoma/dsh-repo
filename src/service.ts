/**
 * The repository engine behind the `dshRepos` service, the tools, the
 * watcher, the local syncs, and the settings page. It builds and holds its
 * parts:
 *
 * - {@link RepoService.settings}: run-time settings and the workspace directory;
 * - {@link RepoService.hosts}: hosts, their tokens, and their providers;
 * - {@link RepoService.catalog}: the repositories dsh-repo may reach;
 * - {@link RepoService.mirrors}: the mirror directory and catalog-checked mirror fetches;
 * - {@link RepoService.forge}: code host API calls, checked against the catalog.
 *
 * Tokens are read through `ctx.credentials` and settings from the settings
 * file's store on every request, so a rotated token or a saved setting takes
 * effect without a reload.
 *
 * @module dsh-repo/service
 */

import { RepoCatalog } from './catalog/catalog.ts'
import { Forge } from './forge/forge.ts'
import { HostRegistry } from './forge/hosts.ts'
import type { ProviderFactory } from './forge/hosts.ts'
import type { HostCredentials, HostLogger } from './host.ts'
import { Mirrors } from './mirror/access.ts'
import type { MirrorStore } from './mirror/store.ts'
import { RuntimeSettings } from './settings/runtime.ts'
import type { SettingsStore } from './settings/store.ts'

/** Name the service is provided under. */
export const DSH_REPOS_SERVICE = 'dshRepos'

/** Collaborators of the service. */
export interface RepoServiceDeps {
  /** DSH credential store; tokens are resolved per request. */
  readonly credentials: HostCredentials
  /** Settings file: hosts, catalog, directories, and run-time settings. */
  readonly store: SettingsStore
  /** Local mirrors. */
  readonly mirrorStore: MirrorStore
  readonly factory?: ProviderFactory
  /** Roots the mirror directory may not be or lie in; see `forbiddenMirrorRoots`. */
  readonly forbiddenMirrorRoots: readonly string[]
  /** Reports throwing change listeners and a rejected stored mirror directory. */
  readonly logger?: HostLogger
}

/** The repository engine's parts, wired together. */
export class RepoService {
  readonly settings: RuntimeSettings
  readonly hosts: HostRegistry
  readonly catalog: RepoCatalog
  readonly mirrors: Mirrors
  readonly forge: Forge

  /** @param deps - credential store, settings file, mirror store, forbidden mirror roots, provider factory, and logger. */
  constructor(deps: RepoServiceDeps) {
    const logger = deps.logger === undefined ? {} : { logger: deps.logger }
    this.settings = new RuntimeSettings(deps.store)
    this.hosts = new HostRegistry({ credentials: deps.credentials, store: deps.store, ...deps.factory === undefined ? {} : { factory: deps.factory }, ...logger })
    // Registered first, so providers carry the new API deadline before any other listener runs.
    this.settings.onChange(async () => { this.hosts.resetProviders() })
    this.catalog = new RepoCatalog({ store: deps.store, mirrorDir: () => deps.mirrorStore.root, ...logger })
    this.mirrors = new Mirrors({ store: deps.mirrorStore, settings: deps.store, catalog: this.catalog, hosts: this.hosts, forbiddenRoots: deps.forbiddenMirrorRoots, ...logger })
    this.forge = new Forge({ hosts: this.hosts, catalog: this.catalog, settings: () => this.settings.current })
  }
}
