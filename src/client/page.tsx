/**
 * 「插件 → dsh-repo」页面的主机与令牌设置。添加、删除主机和保存、清除令牌
 * 立即生效；令牌值存入 DSH 凭据库，页面只显示是否已设置。
 *
 * @module dsh-repo/client/page
 */

import { useCallback, useEffect, useState } from 'react'
import type { ForgeKind, TokenStatus } from '../contract.ts'
import type { HostAddRequest, SettingsState } from '../settings/contract.ts'
import { addHost, clearHostToken, fetchState, messageOf, removeHost, saveHostToken } from './api.ts'

/** Owner props of `plugins.bundle.config`: bundle configuration renders only `page`. */
export interface BundleConfigProps {
  readonly view: 'summary' | 'page'
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

/** Credential store layers of `@deepseek-ai/dsh-credentials-local` other than its own file. */
const TOKEN_SOURCES: Readonly<Record<string, string>> = { 'env': '启动环境变量', 'project-env': '项目 .env', 'user-env': '$DSH_HOME/.env' }

const HOST_KINDS: readonly { id: ForgeKind; label: string }[] = [
  { id: 'gitlab', label: 'GitLab' },
  { id: 'github', label: 'GitHub' },
]

function tokenPill(token: TokenStatus): JSX.Element {
  if (token.error !== undefined) return <span className="dr__pill dr__pill--bad"><span className="dr__dot" />无法读取</span>
  if (!token.configured) return <span className="dr__pill dr__pill--warn"><span className="dr__dot" />未设置令牌</span>
  const source = token.source === undefined || token.source === 'file' ? undefined : TOKEN_SOURCES[token.source] ?? token.source
  return <span className="dr__pill dr__pill--ok"><span className="dr__dot" />已设置{source === undefined ? '' : `（来自${source}）`}</span>
}

/**
 * Hosts with their tokens, plus the form adding one.
 * @param props - the Plugins page's view request.
 * @returns the settings, or null for a view other than `page`.
 */
export function HostsSettings({ view }: BundleConfigProps): JSX.Element | null {
  if (view !== 'page') return null
  return <HostsPanel />
}

function HostsPanel(): JSX.Element {
  const [state, setState] = useState<SettingsState | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [kind, setKind] = useState<ForgeKind>('gitlab')
  const [url, setUrl] = useState('')
  const [alias, setAlias] = useState('')
  const [token, setToken] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    try {
      setState(await fetchState())
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const run = async (action: () => Promise<SettingsState>, success: string): Promise<boolean> => {
    setBusy(true)
    setNotice(undefined)
    try {
      setState(await action())
      setNotice({ kind: 'ok', text: success })
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      // A failed change can still have taken partial effect (host added, token not stored).
      void reload()
      return false
    } finally {
      setBusy(false)
    }
  }

  if (state === undefined) {
    return (
      <div className="dr">
        {loadError === undefined
          ? <div className="dr__loading">加载中…</div>
          : <div className="dr__notice dr__notice--error">{loadError} <button type="button" className="dr__btn dr__btn--ghost" onClick={() => { void reload() }}>重试</button></div>}
      </div>
    )
  }

  const complete = url.trim() !== '' && alias.trim() !== '' && token.trim() !== ''
  const add = (): void => {
    if (!complete || busy) return
    const host: HostAddRequest = { kind, url: url.trim(), alias: alias.trim(), token: token.trim() }
    void run(() => addHost(host), `已添加 ${host.url}`).then((ok) => {
      if (!ok) return
      setUrl('')
      setAlias('')
      setToken('')
    })
  }
  const save = (address: string): void => {
    const value = values[address]?.trim() ?? ''
    if (value === '' || busy) return
    void run(() => saveHostToken(address, value), `已保存 ${address} 的令牌`).then((ok) => {
      if (ok) setValues(current => ({ ...current, [address]: '' }))
    })
  }
  const submitOnEnter = (event: { key: string }): void => { if (event.key === 'Enter') add() }

  return (
    <div className="dr">
      {notice === undefined ? null : <div className={`dr__notice dr__notice--${notice.kind}`} role="status">{notice.text}</div>}
      <section className="dr__sec">
        <h2 className="dr__secTitle">主机与访问令牌</h2>
        <div className="dr__list">
          {state.hosts.length === 0 ? <div className="dr__emptyRow">还没有主机。在下面填入 GitLab 或 GitHub 地址、别名和令牌后，代码仓库工具和私有仓库镜像才能使用。</div> : null}
          {state.hosts.map((host) => {
            const value = values[host.url] ?? ''
            return (
              <div key={host.url} className="dr__row">
                <div className="dr__rowText">
                  <div className="dr__rowLabel">
                    <span>{host.alias ?? host.url}</span>
                    <span className="dr__tag">{host.kind === 'github' ? 'GitHub' : 'GitLab'}</span>
                    {host.origin === 'config' ? <span className="dr__tag">cordis.yml</span> : null}
                    {tokenPill(host.token)}
                  </div>
                  {host.alias === undefined ? null : <div className="dr__rowSummary dr__mono">{host.url}</div>}
                  {host.token.error === undefined ? null : <div className="dr__rowError">{host.token.error}</div>}
                  {host.token.writable
                    ? (
                        <div className="dr__inline">
                          <input className="dr__input dr__mono" type="password" autoComplete="new-password" spellCheck={false} aria-label={`${host.alias ?? host.url} 的令牌`} placeholder={host.token.configured ? '输入新令牌以替换' : '粘贴令牌'} value={value} onChange={(event) => { setValues({ ...values, [host.url]: event.target.value }) }} onKeyDown={(event) => { if (event.key === 'Enter') save(host.url) }} />
                          <button type="button" className="dr__btn" disabled={busy || value.trim() === ''} onClick={() => { save(host.url) }}>保存令牌</button>
                          {host.token.configured && host.token.source === 'file' ? <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={() => { void run(() => clearHostToken(host.url), `已清除 ${host.url} 保存的令牌`) }}>清除</button> : null}
                        </div>
                      )
                    : null}
                </div>
                <div className="dr__rowCtl">
                  {host.origin === 'added' ? <button type="button" className="dr__btn dr__btn--danger" disabled={busy} onClick={() => { void run(() => removeHost(host.url), `已删除 ${host.url}`) }}>删除</button> : null}
                </div>
              </div>
            )
          })}
          <div className="dr__addForm">
            <label className="dr__field">类型<select className="dr__input" value={kind} onChange={(event) => { setKind(event.target.value as ForgeKind) }}>{HOST_KINDS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label className="dr__field">地址<input className="dr__input" placeholder={kind === 'github' ? 'https://github.com' : 'https://gitlab.example.com'} value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label>
            <label className="dr__field">别名<input className="dr__input" placeholder="例如 公司 GitLab" value={alias} onChange={(event) => { setAlias(event.target.value) }} onKeyDown={submitOnEnter} /></label>
            <label className="dr__field">令牌<input className="dr__input dr__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder="粘贴个人访问令牌" value={token} onChange={(event) => { setToken(event.target.value) }} onKeyDown={submitOnEnter} /></label>
            <button type="button" className="dr__btn dr__btn--end" disabled={busy || !complete} onClick={add}>添加</button>
          </div>
        </div>
        <p className="dr__secFoot">添加、删除和保存令牌立即生效。该主机下的 https 仓库地址使用对应令牌，ssh 地址和其他主机使用本机已有的 git 凭据。GitLab 只读镜像需要 read_repository 权限，issue、合并请求和提交需要 api 权限；GitHub 需要 Contents、Issues 与 Pull requests 权限，只读时给只读即可。令牌保存在 DSH 凭据库（默认 $DSH_HOME/.credentials.yaml，仅本机用户可读）。cordis.yml 中配置的主机不能在这里删除，只能更新令牌。</p>
      </section>
      <section className="dr__sec">
        <h2 className="dr__secTitle">本地镜像</h2>
        <div className="dr__list"><div className="dr__row"><div className="dr__rowText"><div className="dr__rowLabel dr__mono">{state.mirrorDir}</div><div className="dr__rowSummary">代码仓库的只读本地副本（只 fetch，不检出），需要读取仓库文件或按提交建只读快照的插件经它取代码，不必每次走主机接口。目录在 DSH 主目录下，不在插件安装目录里，升级、卸载或重装插件都不会清空；默认位置一般不用改，确需改到别处时在 cordis.yml 的 <span className="dr__mono">mirror.dir</span> 中设置。</div></div></div></div>
      </section>
    </div>
  )
}
