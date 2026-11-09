/**
 * Catalog entries: the stored form (validated when the settings file is read)
 * and the checks a submitted entry passes before it is stored. The checks that
 * need the host list, the other entries, or the file system live in
 * {@link ./catalog.ts}.
 *
 * @module dsh-repo/catalog/entry
 */

import { homedir } from 'node:os'
import { isAbsolute, parse } from 'node:path'
import { z } from 'zod'
import { expandHome } from '../config.ts'
import type { CatalogRepo, LocalSyncSpec, RepoAccess, RepoFeature } from '../contract.ts'
import { RepoError } from '../errors.ts'
import { isBranchName, requireBranch } from '../refs.ts'
import { isAcceptedGitUrl } from '../mirror/store.ts'
import { DEFAULT_SYNC_INTERVAL_MINUTES, MAX_REPO_FEATURES, SYNC_INTERVAL_BOUNDS } from '../settings/contract.ts'
import type { RepoInput } from '../settings/contract.ts'

/** A catalog entry as the settings file stores it. */
export interface CatalogEntry extends CatalogRepo {
  /** When the entry was added, ISO 8601. */
  readonly addedAt: string
}

/** Access levels from the least. */
export const ACCESS_ORDER: readonly RepoAccess[] = ['read', 'write', 'merge']

/** Feature ids: lowercase letters, digits, and `-`, starting with a letter. */
export const FEATURE_ID = /^[a-z][a-z0-9-]{0,39}$/

const localSyncSchema = z.object({
  enabled: z.boolean(),
  dir: z.string().min(1).refine(isAbsolute, '本地同步目录必须是绝对路径'),
  intervalMinutes: z.number().int().min(SYNC_INTERVAL_BOUNDS.min).max(SYNC_INTERVAL_BOUNDS.max),
}).strict()

/** Schema of one stored entry. */
export const catalogEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  url: z.string().min(1).refine(isAcceptedGitUrl, '只支持 https 地址、file URL 或绝对路径'),
  branch: z.string().refine(isBranchName, '分支名不合法').optional(),
  access: z.enum(['read', 'write', 'merge']),
  features: z.array(z.string().regex(FEATURE_ID)).max(MAX_REPO_FEATURES),
  localSync: localSyncSchema.optional(),
  addedAt: z.string(),
}).strict()

/**
 * Whether an access level allows what another level needs.
 * @param granted - the entry's access.
 * @param needed - what the call needs.
 * @returns whether `granted` is at least `needed`.
 */
export function allows(granted: RepoAccess, needed: RepoAccess): boolean {
  return ACCESS_ORDER.indexOf(granted) >= ACCESS_ORDER.indexOf(needed)
}

/**
 * Validate a feature registration.
 * @param feature - id, title, and description.
 * @returns the feature with trimmed texts.
 * @throws {RepoError} `invalid` naming the bad field.
 */
export function checkFeature(feature: RepoFeature): RepoFeature {
  if (!FEATURE_ID.test(feature.id)) throw new RepoError('invalid', `功能 id 只能是小写字母开头的小写字母、数字和 -，最长 40 个字符：${JSON.stringify(feature.id)}`)
  const title = feature.title.trim()
  if (title === '' || title.length > 20 || /[\u0000-\u001f\u007f]/.test(title)) throw new RepoError('invalid', `功能 ${feature.id} 的标题不能为空、超过 20 个字符或包含控制字符`)
  const description = feature.description?.trim()
  if (description !== undefined && (description.length > 200 || /[\u0000-\u001f\u007f]/.test(description))) throw new RepoError('invalid', `功能 ${feature.id} 的说明不能超过 200 个字符或包含控制字符`)
  return { id: feature.id, title, ...description === undefined || description === '' ? {} : { description } }
}

/**
 * Validate feature ids, dropping duplicates.
 * @param ids - feature ids.
 * @returns the distinct ids in the given order.
 * @throws {RepoError} `invalid` for a bad id or too many ids.
 */
export function checkFeatureIds(ids: readonly string[]): string[] {
  const distinct = [...new Set(ids)]
  const bad = distinct.find(id => !FEATURE_ID.test(id))
  if (bad !== undefined) throw new RepoError('invalid', `功能 id 不合法：${JSON.stringify(bad)}`)
  if (distinct.length > MAX_REPO_FEATURES) throw new RepoError('invalid', `一个仓库最多打开 ${MAX_REPO_FEATURES} 个功能`)
  return distinct
}

/**
 * Validate a local sync directory, expanding `~`.
 * @param raw - directory as entered.
 * @returns the absolute directory.
 * @throws {RepoError} `invalid` for an empty, relative, root, or home directory.
 */
function resolveSyncDir(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new RepoError('invalid', '本地同步目录不能为空或包含控制字符')
  if (!isAbsolute(trimmed) && trimmed !== '~' && !trimmed.startsWith('~/')) throw new RepoError('invalid', `本地同步目录必须是绝对路径：${trimmed}`)
  const dir = expandHome(trimmed)
  if (dir === parse(dir).root || dir === homedir()) throw new RepoError('invalid', `本地同步目录不能是根目录或用户主目录：${dir}`)
  return dir
}

/** A submitted entry after the checks that need nothing but the entry. */
export interface CheckedInput {
  readonly url: string
  readonly branch?: string
  readonly access: RepoAccess
  readonly features: readonly string[]
  readonly localSync?: LocalSyncSpec
}

/**
 * Validate a submitted entry, filling defaults.
 * @param input - fields from the settings page or a service call.
 * @returns the checked fields.
 * @throws {RepoError} `invalid` naming the bad field.
 */
export function checkInput(input: RepoInput): CheckedInput {
  const url = input.url.trim()
  if (!isAcceptedGitUrl(url)) throw new RepoError('invalid', `不支持的 git 地址：${input.url}（只支持 https 地址、file URL 或绝对路径；SSH 地址请改用仓库的 https 地址）`)
  const branch = input.branch?.trim()
  if (branch !== undefined && branch !== '') requireBranch(branch, '分支名')
  if (!ACCESS_ORDER.includes(input.access)) throw new RepoError('invalid', `权限只能是 ${ACCESS_ORDER.join('、')}：${String(input.access)}`)
  const features = checkFeatureIds(input.features)
  let localSync: LocalSyncSpec | undefined
  if (input.localSync !== undefined) {
    const { enabled } = input.localSync
    const intervalMinutes = input.localSync.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < SYNC_INTERVAL_BOUNDS.min || intervalMinutes > SYNC_INTERVAL_BOUNDS.max) {
      throw new RepoError('invalid', `同步间隔必须是 ${SYNC_INTERVAL_BOUNDS.min} 到 ${SYNC_INTERVAL_BOUNDS.max} 之间的整数分钟：${intervalMinutes}`)
    }
    if (enabled || input.localSync.dir.trim() !== '') localSync = { enabled, dir: resolveSyncDir(input.localSync.dir), intervalMinutes }
  }
  return {
    url,
    ...branch === undefined || branch === '' ? {} : { branch },
    access: input.access,
    features,
    ...localSync === undefined ? {} : { localSync },
  }
}

/**
 * The service view of a stored entry.
 * @param entry - stored entry.
 * @returns the entry without its bookkeeping fields.
 */
export function publicRepo(entry: CatalogEntry): CatalogRepo {
  return {
    id: entry.id,
    url: entry.url,
    ...entry.branch === undefined ? {} : { branch: entry.branch },
    access: entry.access,
    features: [...entry.features],
    ...entry.localSync === undefined ? {} : { localSync: { ...entry.localSync } },
  }
}
