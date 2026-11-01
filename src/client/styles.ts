/**
 * 设置页样式。使用 DSH 语义 token（`--dsw-alias-*`）并带中性回退，
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
.dr__row{display:flex;align-items:center;gap:16px;padding:10px 14px;min-height:28px}
.dr__rowText{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.dr__rowLabel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.dr__rowSummary{color:var(--dr-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dr__rowError{color:var(--dr-bad);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
.dr__rowCtl{flex:none;display:flex;align-items:center;gap:8px;justify-content:flex-end;min-height:28px}
.dr__tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dr-fg2);background:var(--dr-hover)}
.dr__input{box-sizing:border-box;width:100%;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dr-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.dr__input:focus{border-color:var(--dr-accent)}
.dr__inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:6px}
.dr__inline .dr__input{flex:1 1 160px;width:auto}
.dr__addForm{display:flex;flex-direction:column;gap:10px;padding:12px 14px;background:color-mix(in srgb,var(--dr-hover) 50%,transparent)}
.dr__field{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--dr-fg3);font-size:12px}
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
.dr-page{width:100%;height:100%;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;background:var(--dsw-alias-bg-base,#fff)}
.dr-page__content{box-sizing:border-box;max-width:816px;margin:0 auto;padding:calc(18px + var(--dsh-frame-top-clearance,0px)) clamp(16px,4vw,48px) 48px}
.dr__head{display:flex;flex-direction:column;gap:2px}
.dr__title{margin:0;font-size:20px;font-weight:600;line-height:28px;letter-spacing:.01em}
.dr__subtitle{margin:0;color:var(--dr-fg3);font-size:12px;line-height:18px}
.dr__textarea{height:auto;padding:6px 10px;line-height:20px;resize:vertical}
.dr__select{width:auto;min-width:168px}
.dr__number{display:inline-flex;align-items:center;gap:6px}
.dr__number .dr__input{width:112px;text-align:right}
.dr__input[aria-invalid="true"]{border-color:var(--dr-bad)}
.dr__input:disabled{color:var(--dr-dim)}
.dr__unit{min-width:28px;color:var(--dr-fg3);font-size:12px}
.dr__switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:0;border-radius:10px;background:var(--dr-dim);cursor:pointer;transition:background .15s}
.dr__switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
.dr__switch[aria-checked="true"]{background:var(--dr-accent)}
.dr__switch[aria-checked="true"]::after{transform:translateX(14px)}
.dr__switch:disabled{opacity:.5;cursor:default}
.dr__switch:focus-visible{outline:2px solid var(--dr-accent);outline-offset:2px}
.dr__saveBar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--dr-line);background:var(--dsw-alias-bg-base,#fff)}
.dr__saveText{flex:1 1 auto;color:var(--dr-fg3);font-size:12px}
.dr__btn--primary{border-color:var(--dr-accent);background:var(--dr-accent);color:#fff}
.dr__btn--primary:hover:not(:disabled){background:color-mix(in srgb,var(--dr-accent) 88%,#000)}
.dr__btn--primary:disabled{border-color:var(--dr-line);background:transparent}
.dr__tabs{display:flex;gap:2px;border-bottom:1px solid var(--dr-line);overflow-x:auto}
.dr__tab{position:relative;height:34px;padding:0 12px;border:0;background:transparent;color:var(--dr-fg2);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.dr__tab:hover{color:var(--dr-fg)}
.dr__tab[aria-selected="true"]{color:var(--dr-fg);font-weight:600}
.dr__tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:2px;border-radius:1px;background:var(--dr-accent)}
.dr__tab:focus-visible,.dr__segItem:focus-visible,.dr__link:focus-visible{outline:2px solid var(--dr-accent);outline-offset:2px}
.dr__seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--dr-line);border-radius:8px}
.dr__segItem{height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dr-fg2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dr__segItem[aria-checked="true"]{background:var(--dr-hover);color:var(--dr-fg);font-weight:600}
.dr__segItem:disabled{color:var(--dr-dim);cursor:default}
.dr__link{padding:0;border:0;background:transparent;color:var(--dr-accent);font:inherit;font-size:13px;cursor:pointer}
.dr__link:disabled{color:var(--dr-dim);cursor:default}
.dr__link--small{font-size:12px;white-space:nowrap}
.dr__strong{font-weight:600}
.dr__row--block{flex-direction:column;align-items:stretch;gap:8px}
.dr__row--top{align-items:flex-start}
.dr__field>.dr__seg{align-self:flex-start}
.dr__row--block>.dr__rowCtl{width:100%;justify-content:stretch}
.dr__row--block>.dr__rowCtl>*{flex:1 1 auto}
.dr__row--block .dr__inline{padding-top:0;width:100%}
.dr__input--wide{width:220px}
.dr__addRow{padding:10px 14px}
.dr__formGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
.dr__field--full{grid-column:1/-1}
.dr__formActions{display:flex;justify-content:flex-end;gap:8px}
.dr__help{color:var(--dr-fg3);font-size:12px;line-height:18px}
.dr__watch{display:flex;align-items:center;gap:12px;padding:5px 8px 5px 14px;min-height:28px;font-size:12px;line-height:18px}
.dr__watchName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dr-fg)}
.dr__watchName a{color:inherit;text-decoration:none}
.dr__watchName a:hover{text-decoration:underline}
.dr__watchMeta{flex:none;color:var(--dr-fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.dr__watchMeta--session{width:88px;overflow:hidden;text-overflow:ellipsis}
.dr__watchMeta--time{width:72px;text-align:right}
.dr__help summary{cursor:pointer;width:max-content}
.dr__help p{margin:6px 0 0}
.dr__footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--dr-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
@media (max-width:560px){.dr__row{flex-direction:column;gap:8px}.dr__rowCtl{justify-content:flex-start}.dr__formGrid{grid-template-columns:minmax(0,1fr)}.dr__watchMeta--session{display:none}}
@media (prefers-reduced-motion:reduce){.dr__switch,.dr__switch::after{transition:none}}
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
