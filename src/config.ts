/**
 * 插件配置：cordis.yml 中的 `config`，经 Standard Schema 在加载时校验。
 *
 * @module dsh-repo/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { ForgeKind } from './contract.ts'

/** Largest delay Node's `setTimeout` honors (2^31 − 1 ms). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Credential reference names: environment-variable style. */
export const TOKEN_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Repository pattern: `host[:port]/seg/…`, the last segment may be `*` (one level) or `**` (any depth). */
const REPO_PATTERN = /^[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._-]+)*(\/(\*|\*\*|[A-Za-z0-9._-]+))$/

/**
 * Normalize a host address to `https://host[:port][/path]` with a lowercase
 * host and no trailing slash.
 * @param value - candidate address.
 * @returns the normalized address, or undefined when it is not an `https`/`http` URL without credentials, query, or fragment.
 */
export function normalizeHostUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not a URL: refused.
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.host === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

const urlField = (label: string) => z.string().trim()
  .refine(value => normalizeHostUrl(value) !== undefined, `${label}不合法：填 https://主机[:端口][/路径]，不含用户名、查询参数或片段`)
  .transform(value => normalizeHostUrl(value) as string)

const hostSchema = z.object({
  kind: z.enum(['github', 'gitlab']),
  url: urlField('主机地址'),
  apiUrl: urlField('接口地址').optional(),
  tokenRef: z.string().trim().regex(TOKEN_REF_PATTERN, '令牌名称只能包含字母、数字和下划线，且不能以数字开头（它是凭据库中的键名，不是令牌本身）'),
  alias: z.string().trim().max(64).optional(),
}).strict().superRefine((host, issues) => {
  if (host.kind === 'gitlab' && host.apiUrl !== undefined) issues.addIssue({ code: 'custom', path: ['apiUrl'], message: 'apiUrl 只用于 GitHub；GitLab 的接口地址由 url 推出' })
})

const limitsSchema = z.object({
  perPage: z.number().int().min(1).max(100).default(30),
  maxPerPage: z.number().int().min(1).max(100).default(100),
  maxFileBytes: z.number().int().min(1).max(64 * 1024 * 1024).default(1024 * 1024),
  maxDiffBytes: z.number().int().min(1).max(64 * 1024 * 1024).default(512 * 1024),
  maxTreeEntries: z.number().int().min(1).max(100_000).default(1000),
  maxCommitFiles: z.number().int().min(1).max(1000).default(100),
  maxComments: z.number().int().min(1).max(100).default(50),
}).strict().superRefine((limits, issues) => {
  if (limits.perPage > limits.maxPerPage) issues.addIssue({ code: 'custom', path: ['perPage'], message: 'perPage 不能大于 maxPerPage' })
})

const mirrorSchema = z.object({
  /** Directory holding the mirrors (`~` expands to the home directory); default `$DSH_HOME/dsh-repo/mirrors`. */
  dir: z.string().trim().min(1, '镜像目录不能为空').optional(),
  /** Timeout of one git command (clone, fetch, worktree). */
  gitTimeoutMs: z.number().int().min(1000).max(MAX_TIMER_DELAY_MS).default(10 * 60 * 1000),
  /** Whether addresses on hosts outside `hosts` may be mirrored with the machine's own git credentials. */
  otherHosts: z.boolean().default(true),
}).strict()

const toolsSchema = z.object({
  enabled: z.boolean().default(true),
  /** `ask`: every write asks the user once; `allow`: writes run without asking; `off`: write tools are not registered. */
  writes: z.enum(['ask', 'allow', 'off']).default('ask'),
  /** Whether the merge tool is registered at all; it always follows `writes` for approval. */
  merge: z.boolean().default(false),
  /** Appended (after a blank line) to issue, change request, and comment bodies written through tools; empty = none. */
  signature: z.string().max(500).default(''),
}).strict()

/** Standard Schema of the `config` block. */
export const pluginConfigSchema = z.object({
  hosts: z.array(hostSchema).default([]).superRefine((hosts, issues) => {
    const seen = new Set<string>()
    for (const [index, host] of hosts.entries()) {
      if (seen.has(host.url)) issues.addIssue({ code: 'custom', path: [index, 'url'], message: `重复的主机地址：${host.url}` })
      seen.add(host.url)
    }
  }),
  /** Reachable repositories; omitted or empty = every repository on the configured hosts. */
  repos: z.array(z.string().trim().toLowerCase().regex(REPO_PATTERN, '仓库格式：主机/路径，末段可以是 *（一层）或 **（任意层），例如 github.com/modestoma/*')).default([]),
  timeoutMs: z.number().int().min(1000).max(MAX_TIMER_DELAY_MS).default(30_000),
  limits: limitsSchema.default({ perPage: 30, maxPerPage: 100, maxFileBytes: 1024 * 1024, maxDiffBytes: 512 * 1024, maxTreeEntries: 1000, maxCommitFiles: 100, maxComments: 50 }),
  tools: toolsSchema.default({ enabled: true, writes: 'ask', merge: false, signature: '' }),
  mirror: mirrorSchema.default({ gitTimeoutMs: 10 * 60 * 1000, otherHosts: true }),
  /** File holding hosts added at run time; default `$DSH_HOME/dsh-repo/hosts.json`. */
  hostsFile: z.string().trim().min(1, '主机文件路径不能为空').optional(),
}).strict().default({
  hosts: [],
  repos: [],
  timeoutMs: 30_000,
  limits: { perPage: 30, maxPerPage: 100, maxFileBytes: 1024 * 1024, maxDiffBytes: 512 * 1024, maxTreeEntries: 1000, maxCommitFiles: 100, maxComments: 50 },
  tools: { enabled: true, writes: 'ask', merge: false, signature: '' },
  mirror: { gitTimeoutMs: 10 * 60 * 1000, otherHosts: true },
})

/** Validated configuration. */
export type RepoConfig = z.output<typeof pluginConfigSchema>

/** One host: configured in cordis.yml or added at run time. */
export type HostSpec = RepoConfig['hosts'][number]

/** Schema of one host, shared by the configuration and the added-hosts file. */
export const hostSpecSchema = hostSchema

/** Size and paging limits. */
export type RepoLimits = RepoConfig['limits']

/**
 * Validate a raw `config` block.
 * @param config - loader input; undefined uses every default.
 * @returns the validated configuration.
 * @throws when the configuration is invalid, with every issue in the message.
 */
export function resolveConfig(config: unknown): RepoConfig {
  const parsed = pluginConfigSchema.safeParse(config)
  if (parsed.success) return parsed.data
  throw new Error(`dsh-repo 配置不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
}

/**
 * The REST API base URL of a host.
 * @param host - configured host.
 * @returns `https://api.github.com` for github.com, `<url>/api/v3` for GitHub Enterprise Server, and the host URL itself for GitLab (GitBeaker appends `/api/v4`).
 */
export function apiBaseUrl(host: { readonly kind: ForgeKind; readonly url: string; readonly apiUrl?: string | undefined }): string {
  if (host.kind === 'gitlab') return host.url
  if (host.apiUrl !== undefined) return host.apiUrl
  return new URL(host.url).host === 'github.com' ? 'https://api.github.com' : `${host.url}/api/v3`
}

/**
 * `$DSH_HOME`, defaulting to `~/.dsh`.
 * @param env - process environment.
 * @returns the DSH home directory.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Expand `~` and make a configured path absolute.
 * @param path - configured path.
 * @returns absolute path.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

/**
 * The mirror directory a configuration implies.
 * @param config - validated configuration.
 * @param env - process environment.
 * @returns absolute directory.
 */
export function mirrorDir(config: RepoConfig, env: NodeJS.ProcessEnv = process.env): string {
  return config.mirror.dir === undefined ? join(resolveDshHome(env), 'dsh-repo', 'mirrors') : expandHome(config.mirror.dir)
}

/**
 * The added-hosts file a configuration implies.
 * @param config - validated configuration.
 * @param env - process environment.
 * @returns absolute path.
 */
export function hostsFile(config: RepoConfig, env: NodeJS.ProcessEnv = process.env): string {
  return config.hostsFile === undefined ? join(resolveDshHome(env), 'dsh-repo', 'hosts.json') : expandHome(config.hostsFile)
}
