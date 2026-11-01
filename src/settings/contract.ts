/**
 * 设置页与 Host 路由共用的路由常量、JSON 结构和运行时设置的取值范围。
 * 浏览器端 bundle 也会引入本文件，因此这里只放类型和常量。
 *
 * @module dsh-repo/settings/contract
 */

import type { ForgeKind, HostInfo, MirrorSettings } from '../contract.ts'

/** GET：{@link SettingsState}。 */
export const STATE_ROUTE = '/dsh-repo/state'
/** POST：body {@link HostAddRequest} 添加主机；DELETE：body `{ url }` 删除添加的主机。 */
export const HOSTS_ROUTE = '/dsh-repo/hosts'
/** PUT：body `{ url, value }` 保存主机令牌；DELETE：body `{ url }` 清除保存的令牌。 */
export const HOST_TOKEN_ROUTE = '/dsh-repo/host-token'
/** PUT：body `{ dir }` 选择镜像目录；DELETE：恢复默认目录。 */
export const MIRROR_ROUTE = '/dsh-repo/mirror'
/** PUT：body {@link RepoSettingsWire} 保存运行时设置；DELETE：全部恢复默认。 */
export const SETTINGS_ROUTE = '/dsh-repo/settings'
/** POST：打开宿主机的系统目录选择框，响应 {@link PickedDirectory}。 */
export const PICK_DIRECTORY_ROUTE = '/dsh-repo/pick-directory'
/** DELETE：body `{ id }` 停止跟踪一个 PR/MR。 */
export const WATCHES_ROUTE = '/dsh-repo/watches'

/** Largest delay Node's `setTimeout` honors (2^31 − 1 ms). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Inclusive range of each integer run-time setting, in stored units (milliseconds, bytes, items). */
export const SETTING_BOUNDS = {
  timeoutMs: { min: 1000, max: MAX_TIMER_DELAY_MS },
  gitTimeoutMs: { min: 1000, max: MAX_TIMER_DELAY_MS },
  perPage: { min: 1, max: 100 },
  maxPerPage: { min: 1, max: 100 },
  maxFileBytes: { min: 1, max: 64 * 1024 * 1024 },
  maxDiffBytes: { min: 1, max: 64 * 1024 * 1024 },
  maxTreeEntries: { min: 1, max: 100_000 },
  maxComments: { min: 1, max: 100 },
  activeIntervalMs: { min: 15_000, max: 3_600_000 },
  quietIntervalMs: { min: 60_000, max: 86_400_000 },
  quietAfterMs: { min: 60_000, max: 7 * 86_400_000 },
  batchMs: { min: 0, max: 3_600_000 },
  idleDays: { min: 1, max: 90 },
  dailyWakeLimit: { min: 1, max: 100 },
  maxWatches: { min: 1, max: 500 },
} as const satisfies Record<string, { readonly min: number; readonly max: number }>

/** Longest tool signature. */
export const MAX_SIGNATURE_LENGTH = 500
/** Most repository patterns. */
export const MAX_REPO_PATTERNS = 200

/** PR/MR activity a watch reports, named as in {@link WatchEventsWire}. */
export const WATCH_EVENT_KINDS = ['ciFailed', 'ciPassed', 'comment', 'changesRequested', 'approved', 'conflict', 'pushed', 'merged', 'closed', 'idle'] as const

/** One kind of PR/MR activity. */
export type WatchEventKind = typeof WATCH_EVENT_KINDS[number]

/** `wake`: start a turn of the Session; `note`: hand it to the Session without starting a turn; `off`: drop it. */
export type WatchAction = 'wake' | 'note' | 'off'

/** What a watch does with each kind of activity. */
export type WatchEventsWire = Record<WatchEventKind, WatchAction>

/** Complete run-time settings as sent to and from the settings page. */
export interface RepoSettingsWire {
  /** Reachable repository patterns; empty = every repository on the hosts. */
  repos: string[]
  timeoutMs: number
  limits: {
    perPage: number
    maxPerPage: number
    maxFileBytes: number
    maxDiffBytes: number
    maxTreeEntries: number
    maxComments: number
  }
  tools: {
    enabled: boolean
    writes: 'ask' | 'allow' | 'off'
    merge: boolean
    deleteSourceBranch: boolean
    signature: string
  }
  mirror: {
    gitTimeoutMs: number
    otherHosts: boolean
  }
  watch: {
    enabled: boolean
    activeIntervalMs: number
    quietIntervalMs: number
    quietAfterMs: number
    batchMs: number
    idleDays: number
    dailyWakeLimit: number
    maxWatches: number
    events: WatchEventsWire
  }
}

/** One watched PR/MR as the settings page lists it. */
export interface WatchInfo {
  /** Stable id: `host/path!number@session`. */
  id: string
  /** `host/path`. */
  repo: string
  number: number
  title: string
  webUrl: string
  /** Session the activity is delivered to. */
  session: string
  /** How the watch started: the PR/MR was opened or pushed to through the tools, or the model asked to watch it. */
  source: 'created' | 'pushed' | 'requested'
  startedAt: string
  lastActivityAt: string
  /** Consecutive failed polls or deliveries. */
  failures: number
  lastError?: string
  /** Activity waiting to be delivered. */
  pending: number
}

/** Body of a host addition. */
export interface HostAddRequest {
  /** Default `gitlab`. */
  kind?: ForgeKind
  url: string
  /** GitHub only: REST API base when it is not the default. */
  apiUrl?: string
  alias?: string
  token?: string
}

/** `GET /dsh-repo/state` response. */
export interface SettingsState {
  /** Configured hosts first, with token status — never token values. */
  hosts: readonly HostInfo[]
  mirror: MirrorSettings
  /** Run-time settings now in effect. */
  settings: RepoSettingsWire
  /** The value of each setting while nothing is stored. */
  defaults: RepoSettingsWire
  /** Absolute path of the settings file. */
  file: string
  /** Whether the Host can open a system directory dialog. */
  pickerAvailable: boolean
  /** Watched PRs/MRs, most recent activity first. */
  watches: readonly WatchInfo[]
  /** Whether this composition can start a turn of a Session, which PR/MR watching needs. */
  watchAvailable: boolean
}

/** `POST /dsh-repo/pick-directory` response: the chosen path, or null when cancelled. */
export interface PickedDirectory {
  ok: true
  path: string | null
}

/** Successful mutation response. */
export interface MutationOk {
  ok: true
  state: SettingsState
}

/** Failed request response. */
export interface MutationError {
  ok: false
  error: string
}
