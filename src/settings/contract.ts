/**
 * 插件页设置与 Host 路由共用的路由常量和 JSON 结构。浏览器端 bundle 也会
 * 引入本文件，因此这里只放类型和常量。
 *
 * @module dsh-repo/settings/contract
 */

import type { ForgeKind, HostInfo } from '../contract.ts'

/** GET：{@link SettingsState}。 */
export const STATE_ROUTE = '/dsh-repo/state'
/** POST：body {@link HostAddRequest} 添加主机；DELETE：body `{ url }` 删除添加的主机。 */
export const HOSTS_ROUTE = '/dsh-repo/hosts'
/** PUT：body `{ url, value }` 保存主机令牌；DELETE：body `{ url }` 清除保存的令牌。 */
export const HOST_TOKEN_ROUTE = '/dsh-repo/host-token'

/** Body of a host addition. */
export interface HostAddRequest {
  /** Default `gitlab`. */
  kind?: ForgeKind
  url: string
  alias?: string
  token?: string
}

/** `GET /dsh-repo/state` response. */
export interface SettingsState {
  /** Configured hosts first, with token status — never token values. */
  hosts: readonly HostInfo[]
  /** Absolute directory of the local mirrors. */
  mirrorDir: string
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
