/**
 * dsh-repo client half：在「插件 → dsh-repo」页面注册主机与令牌设置。
 *
 * 只依赖平台核心的 `slots` 服务与 react（bundle 里 react 走平台模块表，
 * 其余全部内联）；页面数据来自 Host 半侧的 `/dsh-repo/*` 路由。
 *
 * @module dsh-repo/client
 */

import { HostsSettings } from './page.tsx'
import { installStyles } from './styles.ts'

/** Slots runtime surface this bundle uses: keyed slots by `key`. */
export interface ClientSlots {
  inject(slot: string, contribution: () => unknown): void
  register(declaration: { name: string; key: string }, component: (props: never) => unknown): () => void
}

/** Client plugin context. */
export interface ClientContext {
  slots: ClientSlots
  effect?(callback: () => void | (() => void), label?: string): void
}

/** Cordis client plugin name. */
export const name = 'dsh-repo'

/** Required client services: the Slots registry is part of the web shell core. */
export const inject = ['slots']

/** Key of the Plugins page's `plugins.bundle.config` slot: this bundle's package name. */
export const BUNDLE_KEY = 'dsh-repo'

/**
 * Register the settings on this bundle's Plugins page, and the stylesheet.
 * @param ctx - client plugin context carrying the slots registry.
 */
export function apply(ctx: ClientContext): void {
  if (typeof ctx.effect === 'function') ctx.effect(() => installStyles(), 'dsh-repo: settings styles')
  else installStyles()
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY }, HostsSettings))
}
