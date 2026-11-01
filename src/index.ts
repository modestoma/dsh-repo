/**
 * dsh-repo —— DeepSeek Harness 代码仓库插件。
 *
 * 用 GitHub 官方 SDK（Octokit）和 GitLab 文档推荐的 GitBeaker 抹平
 * GitHub（含 GitHub Enterprise Server）与 GitLab（含自建实例）的差异：
 * 对其他插件提供 `dshRepos` 服务（类型见 `dsh-repo/contract`），
 * 对模型提供代码、issue、PR/MR 工具，写操作逐次经用户审批。Web 组合中
 * 另在「插件 → dsh-repo」页面提供主机与令牌设置（见 `dsh-repo/client`）。
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
import { createTools } from './tools.ts'
import type { CommitTrailer, CommitTrailersEvent } from './contract.ts'
import { RepoError } from './errors.ts'

export type * from './contract.ts'
export type { HostSpec, RepoConfig, RepoLimits } from './config.ts'
export { apiBaseUrl, defaultMirrorDir, hostsFile, normalizeHostUrl, pluginConfigSchema, resolveConfig } from './config.ts'
export { RepoError, toRepoError } from './errors.ts'
export { HostStore, addedTokenRef, isAcceptedToken } from './hosts.ts'
export { GitError, credentialEnvironment, runGit } from './mirror/git.ts'
export type { GitRunOptions, GitRunner } from './mirror/git.ts'
export { MirrorStore, isAcceptedGitUrl, mirrorPath } from './mirror/store.ts'
export { WorkspaceStore, forgetAbandonedWorkspaces } from './mirror/workspace.ts'
export type { PushRequest, WorkspaceStoreDeps } from './mirror/workspace.ts'
export { DSH_REPOS_SERVICE, RepoService, defaultProviderFactory } from './service.ts'
export type { ProviderFactory, RepoServiceDeps } from './service.ts'
export { GithubProvider } from './providers/github.ts'
export { GitlabProvider } from './providers/gitlab.ts'
export type { Provider } from './providers/types.ts'
export { hostOf, matchesPattern, resolveTarget } from './target.ts'
export { createTools } from './tools.ts'
export { HOST_TOKEN_ROUTE, HOSTS_ROUTE, MIRROR_ROUTE, PICK_DIRECTORY_ROUTE, STATE_ROUTE } from './settings/contract.ts'
export type { HostAddRequest, MutationError, MutationOk, PickedDirectory, SettingsState } from './settings/contract.ts'
export { hostDirectoryPicker } from './settings/directory-picker.ts'
export type { DirectoryPicker } from './settings/directory-picker.ts'
export { isSameOriginRequest, mountSettingsRoutes, registerSettingsRoutes, settingsState } from './settings/routes.ts'
export type { Declined, ToolDeps } from './tools.ts'

/** Cordis event other plugins listen to for extra trailers of a pushed commit; payload {@link CommitTrailersEvent}. */
export const COMMIT_TRAILERS_EVENT = 'repo/commit-trailers'

/**
 * Collect the trailers the `repo/commit-trailers` listeners add.
 * @param ctx - plugin context; without `parallel` there are no listeners.
 * @param request - Session and workspace of the push.
 * @returns the trailers in the order they were added.
 * @throws {RepoError} `unavailable` naming the listener failures.
 */
async function collectTrailers(ctx: HostContext, request: { readonly session: string; readonly dir: string }): Promise<CommitTrailer[]> {
  const trailers: CommitTrailer[] = []
  let open = true
  const event: CommitTrailersEvent = { ...request, add: (token, value) => { if (open) trailers.push({ token, value }) } }
  try {
    await ctx.parallel?.(COMMIT_TRAILERS_EVENT, event)
  } catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error]
    throw new RepoError('unavailable', `${COMMIT_TRAILERS_EVENT} 监听者出错，没有提交：${reasons.map(reason => reason instanceof Error ? reason.message : String(reason)).join('；')}`)
  } finally {
    open = false
  }
  return trailers
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
 * serves the Web, and register the model tools, which are offered only while
 * at least one host is configured or added.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 * @throws when the configuration or the added-hosts file is invalid.
 */
export function apply(ctx: HostContext, config?: unknown, options: RepoPluginOptions = {}): void {
  const resolved = resolveConfig(config)
  const env = options.env ?? process.env
  const hosts = new HostStore(resolved.hosts, hostsFile(resolved, env))
  const mirrors = new MirrorStore({
    git: options.git ?? runGit,
    root: hosts.mirrorDir() ?? defaultMirrorDir(env),
    timeoutMs: resolved.mirror.gitTimeoutMs,
    maxFileBytes: resolved.limits.maxFileBytes,
    maxTreeEntries: resolved.limits.maxTreeEntries,
  })
  const git = options.git ?? runGit
  const workspaces = new WorkspaceStore({ git, mirrors, timeoutMs: resolved.mirror.gitTimeoutMs, maxDiffBytes: resolved.limits.maxDiffBytes })
  const service = new RepoService(resolved, {
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
  if (!resolved.tools.enabled) return
  if (!service.configured) ctx.logger?.info?.('dsh-repo: 还没有主机，代码仓库工具在添加主机后提供')
  const tools = createTools({
    service,
    config: resolved,
    approval: () => ctx.get?.('approval') as HostApproval | undefined,
    workingDirectory: () => ctx.get?.('workingDirectory') as WorkingDirectoryService | undefined,
    commitTrailers: request => collectTrailers(ctx, request),
  })
  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition, { when: () => service.configured }), `dsh-repo: ${definition.name}`)
  }
}
