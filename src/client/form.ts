/**
 * 设置页运行时设置表单的纯逻辑：字段说明、显示单位换算、草稿与
 * {@link RepoSettingsWire} 互转和保存前的范围校验。不含 JSX，便于单测；
 * Host 保存时按同一套取值范围复核。
 *
 * @module dsh-repo/client/form
 */

import { MAX_REPO_PATTERNS, MAX_SIGNATURE_LENGTH, SETTING_BOUNDS } from '../settings/contract.ts'
import type { RepoSettingsWire, WatchAction, WatchEventKind } from '../settings/contract.ts'

/** Integer settings, named as in {@link SETTING_BOUNDS}. */
export type NumberKey = keyof typeof SETTING_BOUNDS

/** How one integer setting is shown. */
export interface NumberField {
  readonly key: NumberKey
  readonly label: string
  readonly summary: string
  /** Display unit next to the input. */
  readonly unit: string
  /** Stored units per displayed unit (1000 for 秒 over milliseconds, 1024 for KiB over bytes). */
  readonly scale: number
}

/** Every integer setting in page order. */
export const NUMBER_FIELDS: Readonly<Record<NumberKey, NumberField>> = {
  timeoutMs: { key: 'timeoutMs', label: '接口调用超时', summary: '一次 GitHub / GitLab 接口调用', unit: '秒', scale: 1000 },
  gitTimeoutMs: { key: 'gitTimeoutMs', label: 'git 命令超时', summary: '克隆、拉取、推送等一条 git 命令', unit: '秒', scale: 1000 },
  perPage: { key: 'perPage', label: '默认每页条数', summary: '模型没有指定条数时', unit: '条', scale: 1 },
  maxPerPage: { key: 'maxPerPage', label: '每页上限', summary: '模型一次最多能要的条数', unit: '条', scale: 1 },
  maxComments: { key: 'maxComments', label: '附带评论条数', summary: '读取 issue、PR/MR 时附带', unit: '条', scale: 1 },
  maxTreeEntries: { key: 'maxTreeEntries', label: '目录条目上限', summary: '列一个目录最多返回', unit: '个', scale: 1 },
  maxFileBytes: { key: 'maxFileBytes', label: '单文件上限', summary: '超出截断（镜像读取时拒绝）', unit: 'KiB', scale: 1024 },
  maxDiffBytes: { key: 'maxDiffBytes', label: 'diff 上限', summary: 'PR/MR 与工作区 diff，超出截断', unit: 'KiB', scale: 1024 },
  activeIntervalMs: { key: 'activeIntervalMs', label: '检查间隔', summary: 'PR/MR 有动态或 CI 运行中时', unit: '秒', scale: 1000 },
  quietIntervalMs: { key: 'quietIntervalMs', label: '安静时检查间隔', summary: '一段时间没有动态后放慢', unit: '分钟', scale: 60_000 },
  quietAfterMs: { key: 'quietAfterMs', label: '多久没动态算安静', summary: '之后按安静时的间隔检查', unit: '分钟', scale: 60_000 },
  batchMs: { key: 'batchMs', label: '合并通知窗口', summary: '这段时间内的动态合成一条；合并、关闭、停止跟踪立即通知', unit: '秒', scale: 1000 },
  idleDays: { key: 'idleDays', label: '无动态停止跟踪', summary: '停止时通知会话一次', unit: '天', scale: 1 },
  dailyWakeLimit: { key: 'dailyWakeLimit', label: '每天唤醒上限', summary: '每个 PR/MR；超出后动态只记入会话，不再唤醒', unit: '次', scale: 1 },
  maxWatches: { key: 'maxWatches', label: '同时跟踪上限', summary: '超出时结束最久没有动态的一个', unit: '个', scale: 1 },
}

/** Every kind of PR/MR activity with its label, in page order. */
export const WATCH_EVENTS: readonly { readonly id: WatchEventKind; readonly label: string; readonly summary: string }[] = [
  { id: 'ciFailed', label: 'CI 失败', summary: '当前提交的检查或流水线失败' },
  { id: 'ciPassed', label: 'CI 通过', summary: '当前提交的检查或流水线全部通过' },
  { id: 'comment', label: '新评论', summary: '对话、代码行和评审评论；本插件自己发的评论不算' },
  { id: 'changesRequested', label: '要求修改', summary: '评审要求修改' },
  { id: 'approved', label: '批准', summary: '评审批准' },
  { id: 'conflict', label: '出现冲突', summary: '和目标分支冲突' },
  { id: 'pushed', label: '别人推送', summary: '源分支出现不是本插件推送的提交' },
  { id: 'merged', label: '已合并', summary: '之后停止跟踪' },
  { id: 'closed', label: '已关闭', summary: '未合并就关闭，之后停止跟踪' },
  { id: 'idle', label: '长期无动态', summary: '达到无动态天数，之后停止跟踪' },
]

/** Watch actions with their labels. */
export const WATCH_ACTIONS: readonly { readonly id: WatchAction; readonly label: string }[] = [
  { id: 'wake', label: '唤醒' },
  { id: 'note', label: '只记录' },
  { id: 'off', label: '忽略' },
]

/** Write-tool modes with their labels. */
export const WRITE_MODES: readonly { readonly id: RepoSettingsWire['tools']['writes']; readonly label: string }[] = [
  { id: 'ask', label: '每次审批' },
  { id: 'allow', label: '不审批' },
  { id: 'off', label: '关闭' },
]

/** Editable form of {@link RepoSettingsWire}: numbers as typed text in display units, repositories one per line. */
export interface SettingsDraft {
  readonly repos: string
  readonly numbers: Readonly<Record<NumberKey, string>>
  readonly enabled: boolean
  readonly writes: RepoSettingsWire['tools']['writes']
  readonly merge: boolean
  readonly deleteSourceBranch: boolean
  readonly signature: string
  readonly otherHosts: boolean
  readonly watchEnabled: boolean
  readonly watchEvents: Readonly<Record<WatchEventKind, WatchAction>>
}

/** Field of a rejected draft: an integer setting or the repository list. */
export type DraftField = NumberKey | 'repos' | 'signature'

/** Drop float noise from `stored / scale` (e.g. 0.30000000000000004). */
function tidy(value: number): number {
  return Number(value.toPrecision(12))
}

/**
 * The stored value of an integer setting.
 * @param settings - complete settings.
 * @param key - setting name.
 * @returns its value in stored units.
 */
export function storedNumber(settings: RepoSettingsWire, key: NumberKey): number {
  switch (key) {
    case 'timeoutMs': return settings.timeoutMs
    case 'gitTimeoutMs': return settings.mirror.gitTimeoutMs
    case 'perPage':
    case 'maxPerPage':
    case 'maxComments':
    case 'maxTreeEntries':
    case 'maxFileBytes':
    case 'maxDiffBytes':
      return settings.limits[key]
    case 'activeIntervalMs':
    case 'quietIntervalMs':
    case 'quietAfterMs':
    case 'batchMs':
    case 'idleDays':
    case 'dailyWakeLimit':
    case 'maxWatches':
      return settings.watch[key]
  }
}

/**
 * A stored value in display units with its unit.
 * @param key - setting name.
 * @param stored - value in stored units.
 * @returns text such as `30 秒`.
 */
export function displayNumber(key: NumberKey, stored: number): string {
  const field = NUMBER_FIELDS[key]
  return `${tidy(stored / field.scale)} ${field.unit}`
}

/**
 * The editable form of saved settings.
 * @param settings - complete settings.
 * @returns the draft.
 */
export function toDraft(settings: RepoSettingsWire): SettingsDraft {
  const numbers = {} as Record<NumberKey, string>
  for (const key of Object.keys(NUMBER_FIELDS) as NumberKey[]) numbers[key] = String(tidy(storedNumber(settings, key) / NUMBER_FIELDS[key].scale))
  return {
    repos: settings.repos.join('\n'),
    numbers,
    enabled: settings.tools.enabled,
    writes: settings.tools.writes,
    merge: settings.tools.merge,
    deleteSourceBranch: settings.tools.deleteSourceBranch,
    signature: settings.tools.signature,
    otherHosts: settings.mirror.otherHosts,
    watchEnabled: settings.watch.enabled,
    watchEvents: { ...settings.watch.events },
  }
}

/**
 * Whether two drafts would save the same settings.
 * @param a - one draft.
 * @param b - the other draft.
 * @returns whether they are equal.
 */
export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function parseNumber(key: NumberKey, text: string): { ok: true; value: number } | { ok: false; message: string } {
  const field = NUMBER_FIELDS[key]
  const { min, max } = SETTING_BOUNDS[key]
  const range = `须在 ${displayNumber(key, min)} 到 ${displayNumber(key, max)} 之间`
  const trimmed = text.trim()
  const shown = Number(trimmed)
  if (trimmed === '' || !Number.isFinite(shown)) return { ok: false, message: `${field.label}要填数字，${range}` }
  const value = Math.round(shown * field.scale)
  if (value < min || value > max) return { ok: false, message: `${field.label}${range}` }
  return { ok: true, value }
}

/**
 * Turn a draft into settings, checking every range the Host checks.
 * @param draft - the form.
 * @returns the settings, or a message for each rejected field.
 */
export function fromDraft(draft: SettingsDraft): { ok: true; settings: RepoSettingsWire } | { ok: false; errors: Partial<Record<DraftField, string>> } {
  const errors: Partial<Record<DraftField, string>> = {}
  const numbers = {} as Record<NumberKey, number>
  for (const key of Object.keys(NUMBER_FIELDS) as NumberKey[]) {
    const parsed = parseNumber(key, draft.numbers[key])
    if (parsed.ok) numbers[key] = parsed.value
    else errors[key] = parsed.message
  }
  if (errors.perPage === undefined && errors.maxPerPage === undefined && numbers.perPage > numbers.maxPerPage) errors.perPage = '默认每页条数不能大于每页上限'
  const repos = [...new Set(draft.repos.split('\n').map(line => line.trim().toLowerCase()).filter(line => line !== ''))]
  if (repos.length > MAX_REPO_PATTERNS) errors.repos = `最多 ${MAX_REPO_PATTERNS} 条`
  if (draft.signature.length > MAX_SIGNATURE_LENGTH) errors.signature = `签名最多 ${MAX_SIGNATURE_LENGTH} 个字符`
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    settings: {
      repos,
      timeoutMs: numbers.timeoutMs,
      limits: {
        perPage: numbers.perPage,
        maxPerPage: numbers.maxPerPage,
        maxFileBytes: numbers.maxFileBytes,
        maxDiffBytes: numbers.maxDiffBytes,
        maxTreeEntries: numbers.maxTreeEntries,
        maxComments: numbers.maxComments,
      },
      tools: { enabled: draft.enabled, writes: draft.writes, merge: draft.merge, deleteSourceBranch: draft.deleteSourceBranch, signature: draft.signature },
      mirror: { gitTimeoutMs: numbers.gitTimeoutMs, otherHosts: draft.otherHosts },
      watch: {
        enabled: draft.watchEnabled,
        activeIntervalMs: numbers.activeIntervalMs,
        quietIntervalMs: numbers.quietIntervalMs,
        quietAfterMs: numbers.quietAfterMs,
        batchMs: numbers.batchMs,
        idleDays: numbers.idleDays,
        dailyWakeLimit: numbers.dailyWakeLimit,
        maxWatches: numbers.maxWatches,
        events: { ...draft.watchEvents },
      },
    },
  }
}
