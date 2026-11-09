/**
 * dsh-repo —— DeepSeek Harness 代码仓库插件。
 *
 * 用 GitHub 官方 SDK（Octokit）和 GitLab 文档推荐的 GitBeaker 抹平
 * GitHub（含 GitHub Enterprise Server）与 GitLab（含自建实例）的差异：
 * 对其他插件提供 `dshRepos` 服务（类型见 `dsh-repo/contract`），
 * 对模型提供代码、issue、PR/MR 工具，写操作逐次经用户审批。只有仓库清单中的
 * 仓库可以访问，每个仓库按清单里的权限（只读、可改代码、可合并）限制操作，
 * 并可把分支定时展开到本机目录（本地同步）；其他插件可以登记按仓库开关的功能。
 * Web 组合中另在左侧栏「代码仓库」提供整页设置（见 `dsh-repo/client`）。
 *
 * @module dsh-repo
 */

import { hostsFile, resolveConfig, syncIndexDir, syncsFile, watchesFile } from './config.ts'
import { forbiddenMirrorRoots } from './mirror/root.ts'
import type { HostApproval, HostContext, WorkingDirectoryService } from './host.ts'
import type { WatchDelivery } from './watch/delivery.ts'
import { HostStore } from './hosts.ts'
import { runGit } from './mirror/git.ts'
import type { GitRunner } from './mirror/git.ts'
import { MirrorStore } from './mirror/store.ts'
import { WorkspaceStore } from './mirror/workspace.ts'
import { DSH_REPOS_SERVICE, RepoService } from './service.ts'
import type { ProviderFactory } from './service.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { createTools, toolOffered } from './tools.ts'
import { hostDelivery } from './watch/delivery.ts'
import { SyncStore } from './sync/store.ts'
import { LocalSyncer, syncRecords } from './sync/syncer.ts'
import { WatchStore } from './watch/store.ts'
import { ChangeWatcher } from './watch/watcher.ts'
import { authorize } from './events.ts'
import type { ParallelDispatch } from './events.ts'

export type * from './contract.ts'
export type { HostSpec, RepoConfig, RepoLimits, RepoSettings, SettingsOverrides } from './config.ts'
export { DEFAULT_SETTINGS, apiBaseUrl, hostsFile, normalizeHostUrl, pluginConfigSchema, repoSettingsSchema, resolveConfig, resolveSettings, settingsOverrides } from './config.ts'
export { MIRROR_DIR_UNSET, checkMirrorDir, forbiddenMirrorRoots } from './mirror/root.ts'
export { RepoError, toRepoError } from './errors.ts'
export { HostStore, addedTokenRef, isAcceptedToken } from './hosts.ts'
export { GitError, credentialEnvironment, runGit } from './mirror/git.ts'
export type { GitRunOptions, GitRunner } from './mirror/git.ts'
export { MirrorStore, isAcceptedGitUrl, mirrorPath } from './mirror/store.ts'
export type { MirrorLimits, MirrorStoreDeps } from './mirror/store.ts'
export { WorkspaceStore, forgetAbandonedWorkspaces } from './mirror/workspace.ts'
export type { PushRequest, WorkspaceLimits, WorkspaceStoreDeps } from './mirror/workspace.ts'
export { DSH_REPOS_SERVICE, RepoService, defaultProviderFactory } from './service.ts'
export type { ProviderFactory, RepoServiceDeps } from './service.ts'
export { GithubProvider } from './providers/github.ts'
export { GitlabProvider } from './providers/gitlab.ts'
export type { Provider } from './providers/types.ts'
export { hostOf, resolveTarget } from './target.ts'
export { RepoCatalog, accessLabel, catalogKey } from './catalog/catalog.ts'
export type { CatalogDeps } from './catalog/catalog.ts'
export { ACCESS_ORDER, allows, catalogEntrySchema, checkFeature, checkInput, publicRepo } from './catalog/entry.ts'
export type { CatalogEntry, CheckedInput } from './catalog/entry.ts'
export { overlaps, realPathOf, within } from './paths.ts'
export { createTools, toolOffered } from './tools.ts'
export { HOST_TOKEN_ROUTE, HOSTS_ROUTE, MIRROR_ROUTE, PICK_DIRECTORY_ROUTE, SETTINGS_ROUTE, SETTING_BOUNDS, STATE_ROUTE } from './settings/contract.ts'
export type { HostAddRequest, MutationError, MutationOk, PickedDirectory, RepoSettingsWire, SettingsState } from './settings/contract.ts'
export { hostDirectoryPicker } from './settings/directory-picker.ts'
export type { DirectoryPicker } from './settings/directory-picker.ts'
export { isSameOriginRequest, mountSettingsRoutes, registerSettingsRoutes, settingsState } from './settings/routes.ts'
export type { Declined, RepoTool, ToolAccess, ToolDeps, WatchHooks } from './tools.ts'
export { ACTIVITY_SOURCE, RESOLVE_AGENT_EVENT, activityMessage, hostDelivery } from './watch/delivery.ts'
export type { DeliveryOutcome, WatchDelivery } from './watch/delivery.ts'
export { WatchStore } from './watch/store.ts'
export { SyncStore } from './sync/store.ts'
export type { SyncProgress } from './sync/store.ts'
export { LocalSyncer, RETRY_MS, syncRecords } from './sync/syncer.ts'
export type { SyncerDeps, SyncRecord, SyncService } from './sync/syncer.ts'
export { measureMirrors, treeSize } from './mirror/usage.ts'
export type { OriginReader } from './mirror/usage.ts'
export { ChangeWatcher } from './watch/watcher.ts'
export type { TrackRequest, WatcherDeps, WatchService } from './watch/watcher.ts'
export { detect, renderMessage, watchId } from './watch/activity.ts'
export type { WatchCursor, WatchEvent, WatchMessage, WatchRecord, WatchSource } from './watch/activity.ts'
export { WATCH_EVENT_KINDS, WATCHES_ROUTE } from './settings/contract.ts'
export type { WatchAction, WatchEventKind, WatchInfo } from './settings/contract.ts'
export type { ActivityItem, ActivityRequest, ChangeActivity } from './providers/types.ts'
export type { SyncList, WatchList } from './settings/routes.ts'
export { repoRows } from './settings/routes.ts'
export { ACCESS_LEVELS, DEFAULT_SYNC_INTERVAL_MINUTES, MAX_REPO_FEATURES, MAX_REPOS, MIRROR_USAGE_ROUTE, REPO_SYNC_ROUTE, REPOS_ROUTE, SYNC_INTERVAL_BOUNDS } from './settings/contract.ts'
export type { LocalSyncStatus, MirrorUsage, MirrorUsageEntry, RepoInput, RepoRow } from './settings/contract.ts'
export { syncIndexDir, syncsFile } from './config.ts'

export { ACCESS_AUTHORIZE_EVENT, COMMIT_TRAILERS_EVENT, authorize, collectDetails } from './events.ts'
export type { ParallelDispatch } from './events.ts'

/** Cordis plugin name. */
export const name = 'dsh-repo'

/** Host services the plugin needs before `apply()`. */
export const inject = ['tools', 'credentials'] as const

/** Standard Schema the loader validates `config` with before `apply()`. */
export { pluginConfigSchema as Config } from './config.ts'

/** Direct-invocation options (tests and embedding hosts). */
export interface RepoPluginOptions {
  /** Substitute the per-host providers. */
  readonly providerFactory?: ProviderFactory
  /** Substitute the git executable. */
  readonly git?: GitRunner
  /** Environment `$DSH_HOME` is read from; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Substitute the roots the mirror directory may not lie in; default `forbiddenMirrorRoots(env)`. */
  readonly forbiddenMirrorRoots?: readonly string[]
  /** Substitute how activity reaches Sessions. */
  readonly delivery?: WatchDelivery
}

/**
 * Provide the `dshRepos` service, start the PR/MR watcher and the catalog's
 * local syncs, mount the settings routes while the Host serves the Web, and
 * register the model tools, each offered only while the catalog holds a
 * repository whose access the tool needs and the current tool settings allow
 * it (`repo_mr_watch` also needs watching to be active). Writes made for a
 * Session go through the `access/authorize` listeners first, and pushes
 * collect `repo/commit-trailers` (see `dsh-repo/events`).
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 * @throws when the configuration or the settings file is invalid.
 */
export function apply(ctx: HostContext, config?: unknown, options: RepoPluginOptions = {}): void {
  const resolved = resolveConfig(config)
  const env = options.env ?? process.env
  const hosts = new HostStore(resolved.hosts, hostsFile(resolved, env), ctx.logger)
  const git = options.git ?? runGit
  const mirrors = new MirrorStore({
    git,
    root: undefined,
    limits: () => {
      const { mirror, limits } = hosts.settings()
      return { timeoutMs: mirror.gitTimeoutMs, maxFileBytes: limits.maxFileBytes, maxTreeEntries: limits.maxTreeEntries }
    },
  })
  const workspaces = new WorkspaceStore({
    git,
    mirrors,
    limits: () => {
      const { mirror, limits } = hosts.settings()
      return { timeoutMs: mirror.gitTimeoutMs, maxDiffBytes: limits.maxDiffBytes }
    },
  })
  const parallel: ParallelDispatch | undefined = ctx.parallel === undefined ? undefined : (name, ...args) => ctx.parallel!(name, ...args)
  const service = new RepoService({
    credentials: ctx.credentials,
    hosts,
    mirrors,
    workspaces,
    forbiddenMirrorRoots: options.forbiddenMirrorRoots ?? forbiddenMirrorRoots(env),
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
    ...parallel === undefined ? {} : { parallel },
    ...options.providerFactory === undefined ? {} : { factory: options.providerFactory },
  })
  ctx.provide?.(DSH_REPOS_SERVICE, service)
  const watcher = new ChangeWatcher({
    service,
    store: new WatchStore(watchesFile(hosts.file), ctx.logger),
    settings: () => service.settings.watch,
    delivery: options.delivery ?? hostDelivery(ctx),
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })
  ctx.effect(() => {
    watcher.start()
    return () => { void watcher.stop() }
  }, 'dsh-repo: PR/MR watcher')
  const syncer = new LocalSyncer({
    service,
    records: () => syncRecords(service.catalog.entries()),
    ids: () => new Set(service.catalog.entries().map(entry => entry.id)),
    git,
    store: new SyncStore(syncsFile(hosts.file), ctx.logger),
    indexDir: syncIndexDir(hosts.file),
    timeoutMs: () => service.settings.mirror.gitTimeoutMs,
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })
  ctx.effect(() => {
    syncer.start()
    const unlisten = service.onReposChange(() => { syncer.reconcile() })
    return () => {
      unlisten()
      void syncer.stop()
    }
  }, 'dsh-repo: local syncs')
  mountSettingsRoutes(ctx, service, watcher, syncer)
  if (service.catalog.entries().length === 0) ctx.logger?.info?.('dsh-repo: 仓库清单为空，代码仓库工具在「代码仓库 → 仓库」添加仓库后提供')
  const tools = createTools({
    service,
    settings: () => service.settings.tools,
    approval: () => ctx.get?.('approval') as HostApproval | undefined,
    workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
    authorize: event => authorize(parallel, event),
    allowed: (repo, level) => { service.catalog.require(repo, level) },
    watch: watcher,
  })
  for (const { definition, access } of tools) {
    ctx.effect(() => ctx.tools.register(definition, {
      when: () => toolOffered(access, service.settings.tools, service.catalog.highestAccess()) && (access !== 'watch' || watcher.active),
    }), `dsh-repo: ${definition.name}`)
  }
}
