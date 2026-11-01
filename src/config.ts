/**
 * 插件配置：cordis.yml 中的 `config`（预置主机与设置文件位置），以及保存在
 * 设置文件、由设置页编辑的运行时设置，均经 Standard Schema 校验。
 *
 * @module dsh-repo/config
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { ForgeKind } from './contract.ts'
import { RepoError } from './errors.ts'
import { MAX_REPO_PATTERNS, MAX_SIGNATURE_LENGTH, SETTING_BOUNDS } from './settings/contract.ts'
import type { RepoSettingsWire } from './settings/contract.ts'


/** An integer setting within its {@link SETTING_BOUNDS}. */
function bounded(name: keyof typeof SETTING_BOUNDS) {
  const { min, max } = SETTING_BOUNDS[name]
  return z.number().int().min(min).max(max)
}

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
  /** Items per page when a list call names none. */
  perPage: bounded('perPage').default(30),
  /** Largest page a list call may ask for. */
  maxPerPage: bounded('maxPerPage').default(100),
  /** Cut of one file read through the API or the mirror. */
  maxFileBytes: bounded('maxFileBytes').default(1024 * 1024),
  /** Cut of a PR/MR or workspace diff. */
  maxDiffBytes: bounded('maxDiffBytes').default(512 * 1024),
  /** Most entries of one directory listing. */
  maxTreeEntries: bounded('maxTreeEntries').default(1000),
  /** Comments returned with one issue or PR/MR. */
  maxComments: bounded('maxComments').default(50),
}).strict().superRefine((limits, issues) => {
  if (limits.perPage > limits.maxPerPage) issues.addIssue({ code: 'custom', path: ['perPage'], message: '默认每页条数不能大于每页上限' })
})

const mirrorSchema = z.object({
  /** Timeout of one git command (clone, fetch, worktree, push). */
  gitTimeoutMs: bounded('gitTimeoutMs').default(10 * 60 * 1000),
  /** Whether addresses on hosts outside the host list may be mirrored with the machine's own git credentials. */
  otherHosts: z.boolean().default(true),
}).strict()

const toolsSchema = z.object({
  /** Whether model tools are offered at all; false leaves only the `dshRepos` service. */
  enabled: z.boolean().default(true),
  /** `ask`: every write asks the user once; `allow`: writes run without asking; `off`: write tools are not offered. */
  writes: z.enum(['ask', 'allow', 'off']).default('ask'),
  /** Whether the merge tool is offered; it always follows `writes` for approval. */
  merge: z.boolean().default(false),
  /** Whether PRs/MRs merged through the tools, and GitLab MRs opened through them (by any merge), drop their source branch. */
  deleteSourceBranch: z.boolean().default(true),
  /** Appended (after a blank line) to issue, change request, and comment bodies written through tools; empty = none. */
  signature: z.string().max(MAX_SIGNATURE_LENGTH).default(''),
}).strict()

const action = z.enum(['wake', 'note', 'off'])

const watchEventsSchema = z.object({
  /** CI of the current head failed. */
  ciFailed: action.default('wake'),
  /** CI of the current head passed. */
  ciPassed: action.default('note'),
  /** A comment, review comment, or commented review that the tools did not post. */
  comment: action.default('wake'),
  /** A review requested changes. */
  changesRequested: action.default('wake'),
  /** A review approved. */
  approved: action.default('note'),
  /** The PR/MR now conflicts with its target branch. */
  conflict: action.default('wake'),
  /** Someone else moved the head, i.e. pushed commits the tools did not push. */
  pushed: action.default('note'),
  /** Merged; the watch ends. */
  merged: action.default('wake'),
  /** Closed without merging; the watch ends. */
  closed: action.default('wake'),
  /** No activity for `idleDays`; the watch ends. */
  idle: action.default('wake'),
}).strict()

const watchSchema = z.object({
  /** Whether PRs/MRs opened or pushed to through the tools are watched, and `repo_mr_watch` is offered. */
  enabled: z.boolean().default(true),
  /** Poll interval while the PR/MR is active. */
  activeIntervalMs: bounded('activeIntervalMs').default(60_000),
  /** Poll interval after `quietAfterMs` without activity, unless CI is running. */
  quietIntervalMs: bounded('quietIntervalMs').default(600_000),
  /** Time without activity after which polling slows to `quietIntervalMs`. */
  quietAfterMs: bounded('quietAfterMs').default(3_600_000),
  /** How long activity is collected before one delivery; merge, close, and idle are delivered at once. */
  batchMs: bounded('batchMs').default(120_000),
  /** Days without activity after which the watch ends. */
  idleDays: bounded('idleDays').default(7),
  /** Turns one watch may start per day; later activity is handed over without starting a turn. Merge, close, and idle always start one. */
  dailyWakeLimit: bounded('dailyWakeLimit').default(10),
  /** Most PRs/MRs watched at once; starting another ends the one quiet longest. */
  maxWatches: bounded('maxWatches').default(50),
  events: watchEventsSchema.prefault({}),
}).strict()

/**
 * Standard Schema of the run-time settings kept in the settings file and
 * edited on the settings page. Every field has a default, so a partial
 * object (the stored overrides) parses to complete settings.
 */
export const repoSettingsSchema = z.object({
  /** Reachable repositories; empty = every repository on the hosts. */
  repos: z.array(z.string().trim().toLowerCase().regex(REPO_PATTERN, '仓库格式：主机/路径，末段可以是 *（一层）或 **（任意层），例如 github.com/modestoma/*')).max(MAX_REPO_PATTERNS).default([]),
  /** Deadline of one API call. */
  timeoutMs: bounded('timeoutMs').default(30_000),
  limits: limitsSchema.prefault({}),
  tools: toolsSchema.prefault({}),
  mirror: mirrorSchema.prefault({}),
  watch: watchSchema.prefault({}),
}).strict()

/** Complete run-time settings. */
export type RepoSettings = z.output<typeof repoSettingsSchema>

/** Compile-time check that the page's wire type and the schema stay identical. */
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
const settingsWireMatches: Same<RepoSettings, RepoSettingsWire> = true
void settingsWireMatches

/** Stored form of {@link RepoSettings}: only the fields that differ from the defaults. */
export type SettingsOverrides = z.input<typeof repoSettingsSchema>

/** Settings used while nothing is stored. */
export const DEFAULT_SETTINGS: RepoSettings = repoSettingsSchema.parse({})

/**
 * Validate settings, filling every missing field with its default.
 * @param input - complete settings or stored overrides.
 * @returns the validated settings.
 * @throws {RepoError} `invalid` with every issue in the message.
 */
export function resolveSettings(input: unknown): RepoSettings {
  const parsed = repoSettingsSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new RepoError('invalid', `设置不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
}

function changedFields<T extends object>(value: T, base: T): Partial<T> | undefined {
  const changed: Partial<T> = {}
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (JSON.stringify(value[key]) !== JSON.stringify(base[key])) changed[key] = value[key]
  }
  return Object.keys(changed).length === 0 ? undefined : changed
}

/**
 * The fields of complete settings that differ from the defaults, so later
 * default changes reach every field the user never set.
 * @param settings - validated settings.
 * @returns the overrides to store; empty when everything is default.
 */
export function settingsOverrides(settings: RepoSettings): SettingsOverrides {
  const limits = changedFields(settings.limits, DEFAULT_SETTINGS.limits)
  const tools = changedFields(settings.tools, DEFAULT_SETTINGS.tools)
  const mirror = changedFields(settings.mirror, DEFAULT_SETTINGS.mirror)
  const events = changedFields(settings.watch.events, DEFAULT_SETTINGS.watch.events)
  const { events: _events, ...watchFields } = settings.watch
  const { events: _defaultEvents, ...defaultWatchFields } = DEFAULT_SETTINGS.watch
  const changedWatch = changedFields(watchFields, defaultWatchFields)
  const watch = changedWatch === undefined && events === undefined ? undefined : { ...changedWatch, ...events === undefined ? {} : { events } }
  return {
    ...settings.repos.length === 0 ? {} : { repos: settings.repos },
    ...settings.timeoutMs === DEFAULT_SETTINGS.timeoutMs ? {} : { timeoutMs: settings.timeoutMs },
    ...limits === undefined ? {} : { limits },
    ...tools === undefined ? {} : { tools },
    ...mirror === undefined ? {} : { mirror },
    ...watch === undefined ? {} : { watch },
  }
}

/**
 * Standard Schema of the cordis.yml `config` block. Only hosts provisioned
 * with the profile and the settings file location live here; everything else
 * is a run-time setting ({@link repoSettingsSchema}).
 */
export const pluginConfigSchema = z.object({
  hosts: z.array(hostSchema).default([]).superRefine((hosts, issues) => {
    const seen = new Set<string>()
    for (const [index, host] of hosts.entries()) {
      if (seen.has(host.url)) issues.addIssue({ code: 'custom', path: [index, 'url'], message: `重复的主机地址：${host.url}` })
      seen.add(host.url)
    }
  }),
  /** Settings file holding added hosts, the mirror directory, and the run-time settings; default `$DSH_HOME/dsh-repo/hosts.json`. */
  hostsFile: z.string().trim().min(1, '设置文件路径不能为空').optional(),
}).strict().prefault({})

/** Validated configuration. */
export type RepoConfig = z.output<typeof pluginConfigSchema>

/** One host: configured in cordis.yml or added at run time. */
export type HostSpec = RepoConfig['hosts'][number]

/** Schema of one host, shared by the configuration and the settings file. */
export const hostSpecSchema = hostSchema

/** Size and paging limits. */
export type RepoLimits = RepoSettings['limits']

/** PR/MR watch settings. */
export type WatchSettings = RepoSettings['watch']

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
 * The mirror directory used until one is chosen at run time.
 * @param env - process environment.
 * @returns `$DSH_HOME/dsh-repo/mirrors`.
 */
export function defaultMirrorDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'dsh-repo', 'mirrors')
}

/**
 * The file watched PRs/MRs are kept in: `watches.json` next to the settings file.
 * @param settingsFile - absolute path of the settings file.
 * @returns absolute path.
 */
export function watchesFile(settingsFile: string): string {
  return join(dirname(settingsFile), 'watches.json')
}

/**
 * The file local syncs are kept in: `syncs.json` next to the settings file.
 * @param settingsFile - absolute path of the settings file.
 * @returns absolute path.
 */
export function syncsFile(settingsFile: string): string {
  return join(dirname(settingsFile), 'syncs.json')
}

/**
 * The directory holding each local sync's git index: `syncs/` next to the settings file.
 * @param settingsFile - absolute path of the settings file.
 * @returns absolute path.
 */
export function syncIndexDir(settingsFile: string): string {
  return join(dirname(settingsFile), 'syncs')
}

/**
 * The settings file a configuration implies.
 * @param config - validated configuration.
 * @param env - process environment.
 * @returns absolute path.
 */
export function hostsFile(config: RepoConfig, env: NodeJS.ProcessEnv = process.env): string {
  return config.hostsFile === undefined ? join(resolveDshHome(env), 'dsh-repo', 'hosts.json') : expandHome(config.hostsFile)
}
