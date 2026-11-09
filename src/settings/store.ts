/**
 * The settings file: hosts added at run time (next to the ones configured in
 * cordis.yml), the mirror directory, the repository catalog, and the run-time settings, kept in one
 * JSON file written to a temporary file, then renamed. Added hosts carry
 * tokens under generated credential references; settings are stored as the
 * fields that differ from the defaults.
 *
 * @module dsh-repo/settings/store
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { HostCreate } from '../contract.ts'
import { DEFAULT_SETTINGS, hostSpecSchema, normalizeHostUrl, repoSettingsSchema, settingsOverrides } from '../config.ts'
import type { HostSpec, RepoSettings } from '../config.ts'
import { RepoError } from '../errors.ts'
import { JsonFile } from '../files.ts'
import { catalogEntrySchema } from '../catalog/entry.ts'
import type { CatalogEntry } from '../catalog/entry.ts'
import type { HostLogger } from '../host.ts'

/** Longest accepted token; personal access tokens are far shorter. */
export const MAX_TOKEN_LENGTH = 4096

const fileSchema = z.object({
  hosts: z.array(hostSpecSchema).default([]),
  mirrorDir: z.string().min(1).refine(isAbsolute, '镜像目录必须是绝对路径').optional(),
  workspaceDir: z.string().min(1).refine(isAbsolute, '工作区目录必须是绝对路径').optional(),
  repos: z.array(catalogEntrySchema).default([]),
  settings: repoSettingsSchema.optional(),
}).strict()

/**
 * Settings earlier versions stored that the repository catalog replaced:
 * `settings.repos` (repository patterns), `settings.mirror.otherHosts`, and
 * `settings.tools.merge`. They are dropped when the file is read, reported,
 * and gone from the file after the next write.
 */
const RETIRED_SETTINGS: readonly (readonly [string, string])[] = [
  ['', 'repos'],
  ['mirror', 'otherHosts'],
  ['tools', 'merge'],
]

/** Remove {@link RETIRED_SETTINGS} from a parsed file in place; returns the dotted names removed. */
function dropRetired(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const settings = (raw as { settings?: unknown }).settings
  if (typeof settings !== 'object' || settings === null) return []
  const dropped: string[] = []
  for (const [group, key] of RETIRED_SETTINGS) {
    const holder = group === '' ? settings : (settings as Record<string, unknown>)[group]
    if (typeof holder !== 'object' || holder === null || !(key in holder)) continue
    delete (holder as Record<string, unknown>)[key]
    dropped.push(group === '' ? `settings.${key}` : `settings.${group}.${key}`)
  }
  return dropped
}

/** Everything the settings file holds. */
interface Stored {
  readonly hosts: readonly HostSpec[]
  readonly mirrorDir: string | undefined
  readonly workspaceDir: string | undefined
  readonly repos: readonly CatalogEntry[]
  readonly settings: RepoSettings
}

/**
 * Whether a token value can be handed to an SDK and to git: non-empty,
 * bounded, and free of control characters.
 * @param value - candidate token.
 * @returns whether it is accepted.
 */
export function isAcceptedToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Credential reference of an added host, derived from its address.
 * @param url - normalized host address.
 * @returns `DSH_REPO_HOST_<hash>`.
 */
export function addedTokenRef(url: string): string {
  return `DSH_REPO_HOST_${createHash('sha1').update(url).digest('hex').slice(0, 12).toUpperCase()}`
}

/** Configured and added hosts, the mirror and workspace directories, the repository catalog, and the run-time settings. */
export class SettingsStore {
  private readonly json: JsonFile<Stored>

  /**
   * Read the settings file. A missing file means no added hosts, no mirror
   * directory, an empty catalog, and default settings.
   * @param configured - hosts from cordis.yml.
   * @param file - absolute path of the settings file.
   * @param logger - reports retired settings dropped from the file.
   * @throws when the file exists but cannot be read or is invalid.
   */
  constructor(private readonly configured: readonly HostSpec[], readonly file: string, logger?: HostLogger) {
    this.json = new JsonFile<Stored>({
      file,
      label: '设置文件',
      schema: fileSchema.transform(content => ({
        hosts: content.hosts.filter(host => !configured.some(spec => spec.url === host.url)),
        mirrorDir: content.mirrorDir,
        workspaceDir: content.workspaceDir,
        repos: content.repos,
        settings: content.settings ?? DEFAULT_SETTINGS,
      })),
      empty: { hosts: [], mirrorDir: undefined, workspaceDir: undefined, repos: [], settings: DEFAULT_SETTINGS },
      invalid: 'fail',
      prepare: (raw) => {
        const dropped = dropRetired(raw)
        return dropped.length === 0 ? [] : [`${dropped.join('、')} 已由仓库清单取代，已忽略，下次保存时删除；可访问的仓库和每个仓库的权限请在「代码仓库 → 仓库」中配置`]
      },
      encode: (next) => {
        const overrides = settingsOverrides(next.settings)
        return {
          hosts: next.hosts,
          ...next.mirrorDir === undefined ? {} : { mirrorDir: next.mirrorDir },
          ...next.workspaceDir === undefined ? {} : { workspaceDir: next.workspaceDir },
          ...next.repos.length === 0 ? {} : { repos: next.repos },
          ...Object.keys(overrides).length === 0 ? {} : { settings: overrides },
        }
      },
      ...logger === undefined ? {} : { logger },
    })
  }

  private get stored(): Stored {
    return this.json.value
  }

  /** @returns the mirror directory stored in the settings file, or undefined while none is chosen. */
  mirrorDir(): string | undefined {
    return this.stored.mirrorDir
  }

  /**
   * Persist the mirror directory, or clear the choice.
   * @param dir - absolute directory, or undefined.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  setMirrorDir(dir: string | undefined): Promise<void> {
    return this.json.update(current => ({ value: { ...current, mirrorDir: dir }, result: undefined }))
  }

  /** @returns the directory the settings page creates workspaces in, or undefined while none is chosen. */
  workspaceDir(): string | undefined {
    return this.stored.workspaceDir
  }

  /**
   * Persist the workspace directory, or clear the choice.
   * @param dir - absolute directory, or undefined.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  setWorkspaceDir(dir: string | undefined): Promise<void> {
    return this.json.update(current => ({ value: { ...current, workspaceDir: dir }, result: undefined }))
  }

  /** @returns the repository catalog in order. */
  repos(): readonly CatalogEntry[] {
    return this.stored.repos
  }

  /**
   * Persist a change of the repository catalog. `change` sees the catalog
   * after every change queued before it.
   * @param change - returns the catalog to store and the caller's result.
   * @returns the result of `change`.
   * @throws {RepoError} `unavailable` when the file cannot be written; whatever `change` throws. Nothing changes then.
   */
  updateRepos<T>(change: (current: readonly CatalogEntry[]) => { readonly repos: readonly CatalogEntry[]; readonly result: T }): Promise<T> {
    return this.json.update((current) => {
      const { repos, result } = change(current.repos)
      return { value: { ...current, repos }, result }
    })
  }

  /** @returns the run-time settings now in effect. */
  settings(): RepoSettings {
    return this.stored.settings
  }

  /**
   * Persist the run-time settings; they take effect for every later call.
   * @param settings - validated settings.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  setSettings(settings: RepoSettings): Promise<void> {
    return this.json.update(current => ({ value: { ...current, settings }, result: undefined }))
  }

  /** @returns every host, configured ones first. */
  all(): readonly HostSpec[] {
    return [...this.configured, ...this.stored.hosts]
  }

  /**
   * Whether a host was added at run time.
   * @param url - normalized host address.
   * @returns whether it is an added host.
   */
  isAdded(url: string): boolean {
    return this.stored.hosts.some(host => host.url === url)
  }

  /**
   * The host with an address, after normalizing it.
   * @param url - host address.
   * @returns the host.
   * @throws {RepoError} `not-found` when no host has that address.
   */
  find(url: string): HostSpec {
    const normalized = normalizeHostUrl(url.trim()) ?? url
    const host = this.all().find(spec => spec.url === normalized)
    if (host === undefined) throw new RepoError('not-found', `没有地址为 ${url} 的主机`)
    return host
  }

  /**
   * Add and persist a host.
   * @param create - kind, address, API address, and alias.
   * @returns the stored host.
   * @throws {RepoError} `invalid` for a bad address, API address, or alias, `conflict` when the address is taken, `unavailable` when the file cannot be written.
   */
  add(create: HostCreate): Promise<HostSpec> {
    return this.json.update((current) => {
      const host = this.newHost(create)
      return { value: { ...current, hosts: [...current.hosts, host] }, result: host }
    })
  }

  /** Validate a new host against the hosts now known. */
  private newHost(create: HostCreate): HostSpec {
    const url = normalizeHostUrl(create.url.trim())
    if (url === undefined) throw new RepoError('invalid', `主机地址不合法：${create.url}（填 https://主机[:端口][/路径]，不含用户名、查询参数或片段）`)
    const alias = create.alias?.trim()
    if (alias !== undefined && (alias.length > 64 || /[\u0000-\u001f\u007f]/.test(alias))) throw new RepoError('invalid', '别名不能超过 64 个字符或包含控制字符')
    const kind = create.kind ?? 'gitlab'
    const apiInput = create.apiUrl?.trim()
    let apiUrl: string | undefined
    if (apiInput !== undefined && apiInput !== '') {
      if (kind !== 'github') throw new RepoError('invalid', '接口地址只用于 GitHub；GitLab 的接口地址由主机地址推出')
      apiUrl = normalizeHostUrl(apiInput)
      if (apiUrl === undefined) throw new RepoError('invalid', `接口地址不合法：${apiInput}（填 https://主机[:端口][/路径]，不含用户名、查询参数或片段）`)
    }
    if (this.all().some(host => host.url === url)) throw new RepoError('conflict', `主机 ${url} 已存在`)
    return { kind, url, ...apiUrl === undefined ? {} : { apiUrl }, tokenRef: addedTokenRef(url), ...alias === undefined || alias === '' ? {} : { alias } }
  }

  /**
   * Remove and persist an added host.
   * @param url - host address.
   * @returns the removed host.
   * @throws {RepoError} `not-found`, `forbidden` for a configured host, `unavailable` when the file cannot be written.
   */
  remove(url: string): Promise<HostSpec> {
    return this.json.update((current) => {
      const host = this.find(url)
      if (!this.isAdded(host.url)) throw new RepoError('forbidden', `${host.url} 配置在 cordis.yml 中，不能在运行时删除`)
      return { value: { ...current, hosts: current.hosts.filter(spec => spec.url !== host.url) }, result: host }
    })
  }
}
