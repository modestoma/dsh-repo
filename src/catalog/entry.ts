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
import type { BranchRules, CatalogRepo, LocalSyncSpec, RepoAccess, RepoFeature, RepoFeatureSwitch } from '../contract.ts'
import { RepoError } from '../errors.ts'
import { isBranchName, requireBranch } from '../refs.ts'
import { isAcceptedGitUrl } from '../mirror/store.ts'
import { DEFAULT_SYNC_INTERVAL_MINUTES, MAX_REPO_FEATURES, SYNC_INTERVAL_BOUNDS } from '../settings/contract.ts'
import { patternProblem, templateProblem } from '../settings/branch-names.ts'
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

const branchField = z.string().refine(isBranchName, '分支名不合法')

const localSyncSchema = z.object({
  enabled: z.boolean(),
  dir: z.string().min(1).refine(isAbsolute, '本地同步目录必须是绝对路径'),
  intervalMinutes: z.number().int().min(SYNC_INTERVAL_BOUNDS.min).max(SYNC_INTERVAL_BOUNDS.max),
  branch: branchField.optional(),
}).strict()

/** Schema of one stored entry. */
export const catalogEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  url: z.string().min(1).refine(isAcceptedGitUrl, '只支持 https 地址'),
  base: branchField.optional(),
  access: z.enum(['read', 'write', 'merge']),
  features: z.array(z.object({ id: z.string().regex(FEATURE_ID), branch: branchField.optional() }).strict()).max(MAX_REPO_FEATURES),
  localSync: localSyncSchema.optional(),
  branchRules: z.object({
    template: z.string().refine(value => templateProblem(value) === undefined, '分支命名模板不合法').optional(),
    pattern: z.string().refine(value => patternProblem(value) === undefined, '分支名规则不合法').optional(),
  }).strict().optional(),
  addedAt: z.string(),
}).strict()

/**
 * Rewrite catalog entries of earlier versions in place: one `branch` for
 * everything and features as bare ids. The entry's branch becomes its
 * baseline branch and the branch of each feature and of its local sync, so
 * every reader keeps the branch it used.
 * @param raw - parsed settings file.
 * @returns the addresses of the entries rewritten.
 */
export function upgradeLegacyEntries(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const repos = (raw as { repos?: unknown }).repos
  if (!Array.isArray(repos)) return []
  const upgraded: string[] = []
  for (const entry of repos as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const legacyFeatures = Array.isArray(record.features) && record.features.some(item => typeof item === 'string')
    if (!('branch' in record) && !legacyFeatures) continue
    const branch = typeof record.branch === 'string' ? record.branch : undefined
    delete record.branch
    if (branch !== undefined) record.base = branch
    if (Array.isArray(record.features)) {
      record.features = record.features.map(item => typeof item === 'string' ? { id: item, ...branch === undefined ? {} : { branch } } : item)
    }
    const sync = record.localSync
    if (branch !== undefined && typeof sync === 'object' && sync !== null && !('branch' in sync)) (sync as Record<string, unknown>).branch = branch
    upgraded.push(typeof record.url === 'string' ? record.url : '(无地址)')
  }
  return upgraded
}

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
 * Validate the features turned on, dropping later duplicates of an id.
 * @param switches - feature ids with their branches.
 * @returns the distinct switches in the given order, without empty branches.
 * @throws {RepoError} `invalid` for a bad id or branch, or too many features.
 */
export function checkFeatureSwitches(switches: readonly RepoFeatureSwitch[]): RepoFeatureSwitch[] {
  const distinct: RepoFeatureSwitch[] = []
  for (const item of switches) {
    if (!FEATURE_ID.test(item.id)) throw new RepoError('invalid', `功能 id 不合法：${JSON.stringify(item.id)}`)
    if (distinct.some(other => other.id === item.id)) continue
    const branch = optionalBranch(item.branch, `功能 ${item.id} 的分支`)
    distinct.push({ id: item.id, ...branch === undefined ? {} : { branch } })
  }
  if (distinct.length > MAX_REPO_FEATURES) throw new RepoError('invalid', `一个仓库最多打开 ${MAX_REPO_FEATURES} 个功能`)
  return distinct
}

/** A trimmed branch name, or undefined when missing or empty. */
function optionalBranch(value: string | undefined, label: string): string | undefined {
  const branch = value?.trim()
  if (branch === undefined || branch === '') return undefined
  requireBranch(branch, label)
  return branch
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
  readonly base?: string
  readonly access: RepoAccess
  readonly features: readonly RepoFeatureSwitch[]
  readonly localSync?: LocalSyncSpec
  readonly branchRules?: BranchRules
}

/**
 * Validate a submitted entry, filling defaults.
 * @param input - fields from the settings page or a service call.
 * @returns the checked fields.
 * @throws {RepoError} `invalid` naming the bad field.
 */
export function checkInput(input: RepoInput): CheckedInput {
  const url = input.url.trim()
  if (!isAcceptedGitUrl(url)) throw new RepoError('invalid', `不支持的 git 地址：${input.url}（只支持 https 地址；SSH 地址请改用仓库的 https 地址）`)
  const base = optionalBranch(input.base, '基线分支')
  if (!ACCESS_ORDER.includes(input.access)) throw new RepoError('invalid', `权限只能是 ${ACCESS_ORDER.join('、')}：${String(input.access)}`)
  const features = checkFeatureSwitches(input.features)
  let localSync: LocalSyncSpec | undefined
  if (input.localSync !== undefined) {
    const { enabled } = input.localSync
    const intervalMinutes = input.localSync.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < SYNC_INTERVAL_BOUNDS.min || intervalMinutes > SYNC_INTERVAL_BOUNDS.max) {
      throw new RepoError('invalid', `同步间隔必须是 ${SYNC_INTERVAL_BOUNDS.min} 到 ${SYNC_INTERVAL_BOUNDS.max} 之间的整数分钟：${intervalMinutes}`)
    }
    const branch = optionalBranch(input.localSync.branch, '本地同步分支')
    if (enabled || input.localSync.dir.trim() !== '') localSync = { enabled, dir: resolveSyncDir(input.localSync.dir), intervalMinutes, ...branch === undefined ? {} : { branch } }
  }
  const template = input.branchTemplate?.trim() ?? ''
  const pattern = input.branchPattern?.trim() ?? ''
  const templateIssue = template === '' ? undefined : templateProblem(template)
  if (templateIssue !== undefined) throw new RepoError('invalid', templateIssue)
  const patternIssue = patternProblem(pattern)
  if (patternIssue !== undefined) throw new RepoError('invalid', patternIssue)
  const branchRules: BranchRules = { ...template === '' ? {} : { template }, ...pattern === '' ? {} : { pattern } }
  return {
    url,
    ...base === undefined ? {} : { base },
    access: input.access,
    features,
    ...localSync === undefined ? {} : { localSync },
    ...Object.keys(branchRules).length === 0 ? {} : { branchRules },
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
    ...entry.base === undefined ? {} : { base: entry.base },
    access: entry.access,
    features: entry.features.map(item => ({ ...item })),
    ...entry.localSync === undefined ? {} : { localSync: { ...entry.localSync } },
    ...entry.branchRules === undefined ? {} : { branchRules: { ...entry.branchRules } },
  }
}
