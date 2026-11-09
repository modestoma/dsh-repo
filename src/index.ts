/**
 * dsh-repo —— DeepSeek Harness 代码仓库插件。
 *
 * 用 GitHub 官方 SDK（Octokit）和 GitLab 文档推荐的 GitBeaker 抹平
 * GitHub（含 GitHub Enterprise Server）与 GitLab（含自建实例）的差异。
 * 每个模型工具 `repo_<对象>_<动作>` 都对应一个 `dshRepos` 服务方法
 * `<对象><动作>`（类型见 `dsh-repo/contract`），两者走同一套校验、
 * 授权与审批。工作区是普通 git 克隆，经本机 127.0.0.1 上的 git 代理访问远端，
 * 工作区里不存放任何令牌。只有仓库清单中的仓库可以访问，每个仓库按清单里的
 * 权限（只读、可改代码、可合并）限制操作，并可把分支定时展开到本机目录
 * （本地同步）；其他插件可以登记按仓库开关的功能。Web 组合中另在左侧栏
 * 「代码仓库」提供整页设置（见 `dsh-repo/client`）。
 *
 * @module dsh-repo
 */

import { hostsFile, resolveConfig, syncIndexDir, syncsFile, watchesFile } from './config.ts'
import { forbiddenMirrorRoots } from './mirror/root.ts'
import { DshReposApi } from './api.ts'
import type { HostApproval, HostContext, SandboxConfiner, WorkingDirectoryService } from './host.ts'
import type { WatchDelivery } from './watch/delivery.ts'
import { HostStore } from './hosts.ts'
import { runCommand, runGit } from './mirror/git.ts'
import type { GitRunner } from './mirror/git.ts'
import { MirrorStore } from './mirror/store.ts'
import type { OperationDeps } from './operations.ts'
import { DSH_REPOS_SERVICE, RepoService } from './service.ts'
import type { ProviderFactory } from './service.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { createTools, toolOffered } from './tools.ts'
import { hostDelivery } from './watch/delivery.ts'
import { SyncStore } from './sync/store.ts'
import { LocalSyncer, syncRecords } from './sync/syncer.ts'
import { WatchStore } from './watch/store.ts'
import { ChangeWatcher } from './watch/watcher.ts'
import type { ParallelDispatch } from './events.ts'
import { WorkspaceManager } from './workspace/manager.ts'
import type { WorkspaceGit } from './workspace/manager.ts'
import { workspacePanel } from './workspace/panel.ts'
import { GitProxy } from './workspace/proxy.ts'
import type { WorkspaceRecord } from './workspace/registry.ts'
import { WorkspaceRegistry, workspacesFile } from './workspace/registry.ts'

export type * from './contract.ts'
export type { HostSpec, RepoConfig, RepoLimits, RepoSettings, SettingsOverrides } from './config.ts'
export { DEFAULT_SETTINGS, apiBaseUrl, hostsFile, normalizeHostUrl, pluginConfigSchema, repoSettingsSchema, resolveConfig, resolveSettings, settingsOverrides } from './config.ts'
export { MIRROR_DIR_UNSET, checkMirrorDir, forbiddenMirrorRoots } from './mirror/root.ts'
export { RepoError, toRepoError } from './errors.ts'
export { HostStore, addedTokenRef, isAcceptedToken } from './hosts.ts'
export { GitError, credentialEnvironment, runCommand, runGit } from './mirror/git.ts'
export type { GitRunOptions, GitRunner } from './mirror/git.ts'
export { MirrorStore, isAcceptedGitUrl, mirrorPath } from './mirror/store.ts'
export type { MirrorLimits, MirrorSnapshot, MirrorState, MirrorStoreDeps } from './mirror/store.ts'
export { DSH_REPOS_SERVICE, RepoService, defaultProviderFactory } from './service.ts'
export type { ProviderFactory, RepoServiceDeps } from './service.ts'
export { DshReposApi } from './api.ts'
export type { ApiDeps } from './api.ts'
export { DeclinedError, OPERATIONS, execute, operationOf } from './operations.ts'
export type { Caller, Operation, OperationDeps, Prompt, WatchHooks } from './operations.ts'
export { WorkspaceManager, proxyUrl, workspaceInfo } from './workspace/manager.ts'
export type { WorkspaceGit, WorkspaceManagerDeps } from './workspace/manager.ts'
export { WorkspaceRegistry, workspacesFile } from './workspace/registry.ts'
export type { WorkspaceRecord } from './workspace/registry.ts'
export { GitProxy } from './workspace/proxy.ts'
export type { GitProxyDeps } from './workspace/proxy.ts'
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
export type { HostAddRequest, MirrorSettings, MutationError, MutationOk, PickedDirectory, RepoSettingsWire, SettingsState } from './settings/contract.ts'
export { hostDirectoryPicker } from './settings/directory-picker.ts'
export type { DirectoryPicker } from './settings/directory-picker.ts'
export { isSameOriginRequest, mountSettingsRoutes, registerSettingsRoutes, settingsState } from './settings/routes.ts'
export type { Declined, RepoTool, ToolAccess } from './tools.ts'
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
export type { WorkspacePanel } from './workspace/panel.ts'
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
 * Provide the `dshRepos` service, start the local git proxy, the PR/MR
 * watcher, and the catalog's local syncs, mount the settings routes while the
 * Host serves the Web, and register the model tools, each offered only while
 * the catalog holds a repository whose access the tool needs and the current
 * tool settings allow it (`repo_mr_watch` also needs watching to be active).
 * Writes made for a Session go through the `access/authorize` listeners first,
 * and commits made by `workspacePush` collect `repo/commit-trailers` (see
 * `dsh-repo/events`).
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
  const mirrors = new MirrorStore({ git, root: undefined, limits: () => ({ timeoutMs: hosts.settings().mirror.gitTimeoutMs }) })
  const parallel: ParallelDispatch | undefined = ctx.parallel === undefined ? undefined : (name, ...args) => ctx.parallel!(name, ...args)
  const service = new RepoService({
    credentials: ctx.credentials,
    hosts,
    mirrors,
    forbiddenMirrorRoots: options.forbiddenMirrorRoots ?? forbiddenMirrorRoots(env),
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
    ...options.providerFactory === undefined ? {} : { factory: options.providerFactory },
  })
  const watcher = new ChangeWatcher({
    service,
    store: new WatchStore(watchesFile(hosts.file), ctx.logger),
    settings: () => service.settings.watch,
    delivery: options.delivery ?? hostDelivery(ctx),
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })
  const registry = new WorkspaceRegistry(workspacesFile(hosts.file), ctx.logger)
  const proxy = new GitProxy({
    service,
    registry,
    ...parallel === undefined ? {} : { parallel },
    onPushed: (record, branches) => { void watchPushed(service, watcher, record, branches) },
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })
  const workspaceGit: WorkspaceGit = async (dir, args, runOptions) => {
    const sandbox = ctx.get?.('sandbox') as SandboxConfiner | undefined
    if (sandbox === undefined) return await git(args, { cwd: dir, ...runOptions })
    const confined = await sandbox.confine(['git', ...args], { mode: 'workspace-write', workspaceRoot: dir }, runOptions.signal)
    return await runCommand(confined.argv, { cwd: dir, ...runOptions })
  }
  const workspaces = new WorkspaceManager({
    service,
    registry,
    git,
    workspaceGit,
    proxy: () => proxy.port === undefined ? undefined : { port: proxy.port },
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
  })
  const startProxy = async (): Promise<void> => {
    const configured = service.settings.workspace.proxyPort
    const saved = registry.port()
    let port: number
    try {
      port = await proxy.start(configured !== 0 ? configured : saved ?? 0)
    } catch (error) {
      if (configured !== 0) throw new Error(`本机 git 代理无法监听设置的端口 ${configured}：${error instanceof Error ? error.message : String(error)}`)
      port = await proxy.start(0)
    }
    if (saved !== undefined && saved !== port) await workspaces.moveProxy(port, saved)
    if (saved !== port) await registry.setPort(port)
    ctx.logger?.info?.('dsh-repo: 本机 git 代理监听 127.0.0.1:%d', port)
  }
  ctx.effect(() => {
    startProxy().catch((error: unknown) => { ctx.logger?.error?.('dsh-repo: %s', error instanceof Error ? error.message : String(error)) })
    const unlisten = service.onSettingsChange(async (next, previous) => {
      // Also when the proxy is not where the settings want it, so saving again retries a port that failed earlier.
      const wanted = next.workspace.proxyPort
      if (wanted !== previous.workspace.proxyPort || proxy.port === undefined || (wanted !== 0 && proxy.port !== wanted)) await startProxy()
    })
    return () => {
      unlisten()
      void proxy.stop()
    }
  }, 'dsh-repo: local git proxy')
  const operations: OperationDeps = {
    service,
    workspaces,
    approval: () => ctx.get?.('approval') as HostApproval | undefined,
    workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
    ...parallel === undefined ? {} : { parallel },
    watch: watcher,
  }
  ctx.provide?.(DSH_REPOS_SERVICE, new DshReposApi({ ...operations, proxyPort: () => proxy.port }))
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
  mountSettingsRoutes(ctx, service, watcher, syncer, workspacePanel(service, workspaces, () => proxy.port))
  if (service.catalog.entries().length === 0) ctx.logger?.info?.('dsh-repo: 仓库清单为空，代码仓库工具在「代码仓库 → 仓库」添加仓库后提供')
  for (const { definition, access } of createTools(operations)) {
    ctx.effect(() => ctx.tools.register(definition, {
      when: () => toolOffered(access, service.settings.tools, service.catalog.highestAccess()) && (access !== 'watch' || watcher.active),
    }), `dsh-repo: ${definition.name}`)
  }
}

/** Watch the open requests from branches a workspace of a Session pushed through the proxy; best effort. */
async function watchPushed(service: RepoService, watcher: ChangeWatcher, record: WorkspaceRecord, branches: readonly string[]): Promise<void> {
  if (record.session === undefined || !watcher.active || !service.gitHost(record.repo)) return
  for (const branch of branches) {
    try {
      const open = await service.listChanges(record.repo, { state: 'open', sourceBranch: branch, perPage: 20 })
      for (const mr of open.items) await watcher.track({ repo: record.repo, change: mr, session: record.session, source: 'pushed', pushed: mr.headSha })
    } catch {
      // Watching is a convenience: the push succeeded, and the model can still watch with repo_mr_watch.
    }
  }
}
