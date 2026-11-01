/**
 * dsh-repo —— DeepSeek Harness 代码仓库插件。
 *
 * 用 GitHub 官方 SDK（Octokit）和 GitLab 文档推荐的 GitBeaker 抹平
 * GitHub（含 GitHub Enterprise Server）与 GitLab（含自建实例）的差异：
 * 对其他插件提供 `dshRepos` 服务（类型见 `dsh-repo/contract`），
 * 对模型提供代码、issue、PR/MR 工具，写操作逐次经用户审批。Web 组合中
 * 另在左侧栏「代码仓库」提供整页设置（见 `dsh-repo/client`）。
 *
 * @module dsh-repo
 */

import { defaultMirrorDir, hostsFile, resolveConfig } from './config.ts'
import type { HostApproval, HostContext, WorkingDirectoryService } from './host.ts'
import { HostStore } from './hosts.ts'
import { runGit } from './mirror/git.ts'
import type { GitRunner } from './mirror/git.ts'
import { MirrorStore } from './mirror/store.ts'
import { WorkspaceStore } from './mirror/workspace.ts'
import { DSH_REPOS_SERVICE, RepoService } from './service.ts'
import type { ProviderFactory } from './service.ts'
import { mountSettingsRoutes } from './settings/routes.ts'
import { createTools, toolOffered } from './tools.ts'
import type { CommitAuthor, CommitDetails, CommitTrailer, CommitTrailersEvent } from './contract.ts'
import { RepoError } from './errors.ts'

export type * from './contract.ts'
export type { HostSpec, RepoConfig, RepoLimits, RepoSettings, SettingsOverrides } from './config.ts'
export { DEFAULT_SETTINGS, apiBaseUrl, defaultMirrorDir, hostsFile, normalizeHostUrl, pluginConfigSchema, repoSettingsSchema, resolveConfig, resolveSettings, settingsOverrides } from './config.ts'
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
export { hostOf, matchesPattern, resolveTarget } from './target.ts'
export { createTools, toolOffered } from './tools.ts'
export { HOST_TOKEN_ROUTE, HOSTS_ROUTE, MIRROR_ROUTE, PICK_DIRECTORY_ROUTE, SETTINGS_ROUTE, SETTING_BOUNDS, STATE_ROUTE } from './settings/contract.ts'
export type { HostAddRequest, MutationError, MutationOk, PickedDirectory, RepoSettingsWire, SettingsState } from './settings/contract.ts'
export { hostDirectoryPicker } from './settings/directory-picker.ts'
export type { DirectoryPicker } from './settings/directory-picker.ts'
export { isSameOriginRequest, mountSettingsRoutes, registerSettingsRoutes, settingsState } from './settings/routes.ts'
export type { Declined, RepoTool, ToolAccess, ToolDeps } from './tools.ts'

/** Cordis event other plugins listen to for extra trailers and the author of a pushed commit; payload {@link CommitTrailersEvent}. */
export const COMMIT_TRAILERS_EVENT = 'repo/commit-trailers'

/**
 * Collect the trailers and the author the `repo/commit-trailers` listeners add.
 * @param ctx - plugin context; without `parallel` there are no listeners.
 * @param request - Session and workspace of the push.
 * @returns the trailers in the order they were added, and the author when a listener set one.
 * @throws {RepoError} `unavailable` naming the listener failures; `invalid` when more than one author was set.
 */
async function collectDetails(ctx: HostContext, request: { readonly session: string; readonly dir: string }): Promise<CommitDetails> {
  const trailers: CommitTrailer[] = []
  const authors: CommitAuthor[] = []
  let open = true
  const event: CommitTrailersEvent = {
    ...request,
    add: (token, value) => { if (open) trailers.push({ token, value }) },
    setAuthor: (name, email) => { if (open) authors.push({ name, email }) },
  }
  try {
    await ctx.parallel?.(COMMIT_TRAILERS_EVENT, event)
  } catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error]
    throw new RepoError('unavailable', `${COMMIT_TRAILERS_EVENT} 监听者出错，没有提交：${reasons.map(reason => reason instanceof Error ? reason.message : String(reason)).join('；')}`)
  } finally {
    open = false
  }
  if (authors.length > 1) throw new RepoError('invalid', `${COMMIT_TRAILERS_EVENT} 监听者设置了 ${authors.length} 个提交作者，只能有一个，没有提交：${authors.map(author => `${author.name} <${author.email}>`).join('、')}`)
  return { trailers, ...authors[0] === undefined ? {} : { author: authors[0] } }
}

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
}

/**
 * Provide the `dshRepos` service, mount the settings routes while the Host
 * serves the Web, and register the model tools, each offered only while at
 * least one host is configured or added and the current tool settings allow
 * it.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 * @throws when the configuration or the settings file is invalid.
 */
export function apply(ctx: HostContext, config?: unknown, options: RepoPluginOptions = {}): void {
  const resolved = resolveConfig(config)
  const env = options.env ?? process.env
  const hosts = new HostStore(resolved.hosts, hostsFile(resolved, env))
  const git = options.git ?? runGit
  const mirrors = new MirrorStore({
    git,
    root: hosts.mirrorDir() ?? defaultMirrorDir(env),
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
  const service = new RepoService({
    credentials: ctx.credentials,
    hosts,
    mirrors,
    workspaces,
    defaultMirrorDir: defaultMirrorDir(env),
    ...ctx.logger === undefined ? {} : { logger: ctx.logger },
    ...options.providerFactory === undefined ? {} : { factory: options.providerFactory },
  })
  ctx.provide?.(DSH_REPOS_SERVICE, service)
  mountSettingsRoutes(ctx, service)
  if (!service.configured) ctx.logger?.info?.('dsh-repo: 还没有主机，代码仓库工具在添加主机后提供')
  const tools = createTools({
    service,
    settings: () => service.settings.tools,
    approval: () => ctx.get?.('approval') as HostApproval | undefined,
    workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
    commitDetails: request => collectDetails(ctx, request),
  })
  for (const { definition, access } of tools) {
    ctx.effect(() => ctx.tools.register(definition, { when: () => service.configured && toolOffered(access, service.settings.tools) }), `dsh-repo: ${definition.name}`)
  }
}
