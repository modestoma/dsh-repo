/**
 * dsh-repo client half：左侧栏全局入口「代码仓库」+ 主区整页设置；
 * 「插件 → dsh-repo」页面只保留指向该入口的提示。
 *
 * 只依赖平台核心的 `slots` 服务与 react（bundle 里 react 走平台模块表，
 * 其余全部内联）；页面数据来自 Host 半侧的 `/dsh-repo/*` 路由。
 *
 * @module dsh-repo/client
 */

import { RepoPanelIcon } from './icon.tsx'
import { bundlePointer, PAGE_TITLE, RepoSettingsPage } from './page.tsx'
import { installStyles } from './styles.ts'

/** Slots runtime surface this bundle uses: list slots by `id`, keyed slots by `key`. */
export interface ClientSlots {
  inject(slot: string, contribution: () => unknown): void
  register(
    declaration: { name: string; id: string; order?: number; label?: () => string } | { name: string; key: string },
    component: (props: never) => unknown,
  ): () => void
}

/** The slice of the shell's `layout` service that opens a main panel. */
export interface PanelLayout {
  selectPanel(panelId: string): void
}

/** Client plugin context. */
export interface ClientContext {
  slots: ClientSlots
  effect?(callback: () => void | (() => void), label?: string): void
  get?(name: string): unknown
}

/** Cordis client plugin name. */
export const name = 'dsh-repo'

/** Required client services: the Slots registry is part of the web shell core. */
export const inject = ['slots']

/** Key of the Plugins page's `plugins.bundle.config` slot: this bundle's package name. */
export const BUNDLE_KEY = 'dsh-repo'

/**
 * Main panel id: the `sidebar.panellist` row id and the matching `main` slot
 * key. Must not change once released: DSH keys navigation state by it.
 */
export const PANEL_ID = 'dsh-repo'
/** Left-sidebar row order (dsh-channels 40, dsh-logalyze 45; Plugins is pinned last by the sidebar). */
export const PANEL_ORDER = 50

/**
 * Mount the left-sidebar entry, its main-column page, the Plugins page
 * pointer, and the stylesheet.
 * @param ctx - client plugin context carrying the slots registry.
 */
export function apply(ctx: ClientContext): void {
  if (typeof ctx.effect === 'function') ctx.effect(() => installStyles(), 'dsh-repo: settings styles')
  else installStyles()
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, RepoSettingsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => PAGE_TITLE,
  }, RepoPanelIcon))
  const openPage = (): (() => void) | undefined => {
    const layout = ctx.get?.('layout') as PanelLayout | undefined
    return layout === undefined ? undefined : () => { layout.selectPanel(PANEL_ID) }
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY }, bundlePointer(openPage)))
}
