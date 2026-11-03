/**
 * 左侧栏「代码仓库」行的装饰图标；行本身负责可访问名称（列表注册的 label）。
 *
 * @module dsh-repo/client/icon
 */

/** Owner share of `sidebar.panellist`: requested square edge and selection state. */
export interface RepoPanelIconProps {
  readonly size: number
  readonly active: boolean
}

/**
 * Branch glyph drawn in `currentColor`, so it follows the row's text color.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function RepoPanelIcon({ size }: RepoPanelIconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10" />
      <path d="M18 9c0 4-4 5-8.5 6.2A3 3 0 0 0 6 17" />
    </svg>
  )
}
