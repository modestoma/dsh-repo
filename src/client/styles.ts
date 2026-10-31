/**
 * 插件页设置样式。使用 DSH 语义 token（`--dsw-alias-*`）并带中性回退，
 * 随当前主题变化。
 *
 * @module dsh-repo/client/styles
 */

const STYLE_ATTRIBUTE = 'data-dsh-repo-css'

const CSS = `
.dr{--dr-fg:var(--dsw-alias-label-primary,#1f2328);--dr-fg2:var(--dsw-alias-label-secondary,#5c6169);--dr-fg3:var(--dsw-alias-label-tertiary,#8a8f98);--dr-dim:var(--dsw-alias-label-dimmed,#b0b4ba);--dr-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--dr-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--dr-accent:var(--dsw-alias-state-business-primary,#0a67d3);--dr-ok:var(--dsw-alias-state-success-primary,#0a7d33);--dr-warn:var(--dsw-alias-state-warn-primary,#a15c00);--dr-bad:var(--dsw-alias-state-error-primary,#c62828);--dr-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex;flex-direction:column;gap:18px;width:100%;color:var(--dr-fg);font-size:13px;line-height:20px}
.dr__mono{font-family:var(--dr-mono);font-size:12px}
.dr__pill{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;white-space:nowrap;color:var(--dr-fg3);background:color-mix(in srgb,currentColor 10%,transparent)}
.dr__pill--ok{color:var(--dr-ok)}
.dr__pill--warn{color:var(--dr-warn)}
.dr__pill--bad{color:var(--dr-bad)}
.dr__dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dr__sec{display:flex;flex-direction:column;gap:6px;margin:0}
.dr__secTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dr-fg3);letter-spacing:.02em}
.dr__secFoot{margin:0;color:var(--dr-fg3);font-size:12px;line-height:18px}
.dr__list{display:flex;flex-direction:column;border:1px solid var(--dr-line);border-radius:10px}
.dr__list>*+*{border-top:1px solid var(--dr-line)}
.dr__row{display:flex;align-items:flex-start;gap:16px;padding:11px 14px;min-height:28px}
.dr__rowText{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.dr__rowLabel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.dr__rowSummary{color:var(--dr-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dr__rowError{color:var(--dr-bad);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
.dr__rowCtl{flex:none;display:flex;align-items:center;gap:6px;justify-content:flex-end}
.dr__tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dr-fg2);background:var(--dr-hover)}
.dr__input{box-sizing:border-box;width:100%;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dr-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.dr__input:focus{border-color:var(--dr-accent)}
.dr__inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px}
.dr__inline .dr__input{flex:1 1 160px;width:auto}
.dr__addForm{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding:10px 14px}
.dr__field{display:flex;flex-direction:column;gap:2px;flex:1 1 140px;color:var(--dr-fg3);font-size:12px}
.dr__emptyRow{padding:11px 14px;color:var(--dr-fg3);font-size:12px}
.dr__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;border:1px solid var(--dr-line);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dr__btn:hover:not(:disabled){background:var(--dr-hover)}
.dr__btn:disabled{color:var(--dr-dim);cursor:default}
.dr__btn--ghost{border-color:transparent;color:var(--dr-fg2)}
.dr__btn--danger{color:var(--dr-bad)}
.dr__btn--end{height:30px}
.dr__btn:focus-visible{outline:2px solid var(--dr-accent);outline-offset:2px}
.dr__notice{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dr__notice--ok{color:var(--dr-ok);background:color-mix(in srgb,var(--dr-ok) 9%,transparent)}
.dr__notice--error{color:var(--dr-bad);background:color-mix(in srgb,var(--dr-bad) 8%,transparent)}
.dr__loading{padding:16px 0;color:var(--dr-fg3);font-size:12px}
`

/**
 * Install the stylesheet once.
 * @returns disposer removing it.
 */
export function installStyles(): () => void {
  const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}]`)
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = CSS
  document.head.append(element)
  return () => { element.remove() }
}
