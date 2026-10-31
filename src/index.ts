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

import { resolveConfig } from './config.ts'
import type { HostApproval, HostContext } from './host.ts'
import { DSH_REPOS_SERVICE, RepoService } from './service.ts'
import type { ProviderFactory } from './service.ts'
import { createTools } from './tools.ts'

export type * from './contract.ts'
export type { HostSpec, RepoConfig, RepoLimits } from './config.ts'
export { apiBaseUrl, normalizeHostUrl, pluginConfigSchema, resolveConfig } from './config.ts'
export { RepoError, toRepoError } from './errors.ts'
export { DSH_REPOS_SERVICE, RepoService, defaultProviderFactory } from './service.ts'
export type { ProviderFactory } from './service.ts'
export { GithubProvider } from './providers/github.ts'
export { GitlabProvider } from './providers/gitlab.ts'
export type { Provider } from './providers/types.ts'
export { matchesPattern, resolveTarget } from './target.ts'
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
}

/**
 * Provide the `dshRepos` service and register the model tools.
 * @param ctx - plugin context.
 * @param config - loader-validated configuration.
 * @param options - test seams.
 */
export function apply(ctx: HostContext, config?: unknown, options: RepoPluginOptions = {}): void {
  const resolved = resolveConfig(config)
  const service = new RepoService(resolved, ctx.credentials, options.providerFactory)
  ctx.provide?.(DSH_REPOS_SERVICE, service)
  if (!resolved.tools.enabled) return
  if (!service.configured) {
    ctx.logger?.warn?.('dsh-repo: 没有配置 hosts，代码仓库工具未注册')
    return
  }
  for (const definition of createTools({ service, config: resolved, approval: () => ctx.get?.('approval') as HostApproval | undefined })) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-repo: ${definition.name}`)
  }
}
