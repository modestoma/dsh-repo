/**
 * dsh-repo —— DeepSeek Harness 代码仓库插件。
 *
 * 用 GitHub 官方 SDK（Octokit）和 GitLab 文档推荐的 GitBeaker 抹平
 * GitHub（含 GitHub Enterprise Server）与 GitLab（含自建实例）的差异：
 * 对其他插件提供 `dshRepos` 服务（类型见 `dsh-repo/contract`），
 * 对模型提供代码、issue、PR/MR 工具，写操作逐次经用户审批。
 *
 * @module dsh-repo
 */

import { hostsFile, mirrorDir, resolveConfig } from './config.ts'
import type { HostApproval, HostContext } from './host.ts'
import { HostStore } from './hosts.ts'
import { runGit } from './mirror/git.ts'
import type { GitRunner } from './mirror/git.ts'
import { MirrorStore } from './mirror/store.ts'
import { DSH_REPOS_SERVICE, RepoService } from './service.ts'
import type { ProviderFactory } from './service.ts'
import { createTools } from './tools.ts'

export type * from './contract.ts'
export type { HostSpec, RepoConfig, RepoLimits } from './config.ts'
export { apiBaseUrl, hostsFile, mirrorDir, normalizeHostUrl, pluginConfigSchema, resolveConfig } from './config.ts'
export { RepoError, toRepoError } from './errors.ts'
export { HostStore, addedTokenRef, isAcceptedToken } from './hosts.ts'
export { GitError, credentialEnvironment, runGit } from './mirror/git.ts'
export type { GitRunOptions, GitRunner } from './mirror/git.ts'
export { MirrorStore, isAcceptedGitUrl, mirrorPath } from './mirror/store.ts'
export { DSH_REPOS_SERVICE, RepoService, defaultProviderFactory } from './service.ts'
export type { ProviderFactory, RepoServiceDeps } from './service.ts'
export { GithubProvider } from './providers/github.ts'
export { GitlabProvider } from './providers/gitlab.ts'
export type { Provider } from './providers/types.ts'
export { hostOf, matchesPattern, resolveTarget } from './target.ts'
export { createTools } from './tools.ts'
export type { Declined, ToolDeps } from './tools.ts'

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
 * Provide the `dshRepos` service and register the model tools, which are
 * offered only while at least one host is configured or added.
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
    root: mirrorDir(resolved, env),
    timeoutMs: resolved.mirror.gitTimeoutMs,
    maxFileBytes: resolved.limits.maxFileBytes,
    maxTreeEntries: resolved.limits.maxTreeEntries,
  })
  const service = new RepoService(resolved, {
    credentials: ctx.credentials,
    hosts,
    mirrors,
    ...options.providerFactory === undefined ? {} : { factory: options.providerFactory },
  })
  ctx.provide?.(DSH_REPOS_SERVICE, service)
  if (!resolved.tools.enabled) return
  if (!service.configured) ctx.logger?.info?.('dsh-repo: 还没有主机，代码仓库工具在添加主机后提供')
  for (const definition of createTools({ service, config: resolved, approval: () => ctx.get?.('approval') as HostApproval | undefined })) {
    ctx.effect(() => ctx.tools.register(definition, { when: () => service.configured }), `dsh-repo: ${definition.name}`)
  }
}
