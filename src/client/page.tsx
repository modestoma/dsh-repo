/**
 * 左侧栏「代码仓库」整页设置：主机与令牌、本地镜像、访问范围、模型工具、
 * 超时、列表与大小上限。主机、令牌和镜像目录的改动立即保存；其余
 * 运行时设置在页面底部统一保存，保存后对之后的调用立即生效。令牌值存入
 * DSH 凭据库，页面只显示是否已设置。
 *
 * @module dsh-repo/client/page
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ForgeKind, HostInfo, TokenStatus } from '../contract.ts'
import type { HostAddRequest, SettingsState } from '../settings/contract.ts'
import { addHost, clearHostToken, fetchState, messageOf, pickDirectory, removeHost, resetMirrorDir, resetSettings, saveHostToken, saveMirrorDir, saveSettings } from './api.ts'
import { displayNumber, fromDraft, NUMBER_FIELDS, sameDraft, storedNumber, toDraft, WRITE_MODES } from './form.ts'
import type { DraftField, NumberKey, SettingsDraft } from './form.ts'

/** Page title, shared with the sidebar row. */
export const PAGE_TITLE = '代码仓库'

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
 * Main-column page for the `main` slot: a full-height scroll region with a
 * centered column. The slot passes no owner props.
 * @returns the page.
 */
export function RepoSettingsPage(): JSX.Element {
  return (
    <section className="dr-page" aria-label={PAGE_TITLE}>
      <div className="dr-page__content">
        <SettingsPanel />
      </div>
    </section>
  )
}

/** Owner props of `plugins.bundle.config`: bundle configuration renders only `page`. */
export interface BundleConfigProps {
  readonly view: 'summary' | 'page'
}

/**
 * The Plugins page entry: points to the sidebar page, with a button that
 * opens it while the shell's layout service is available.
 * @param openPage - opens the sidebar page, or undefined when the shell cannot.
 * @returns the `plugins.bundle.config` component.
 */
export function bundlePointer(openPage: () => (() => void) | undefined): (props: BundleConfigProps) => JSX.Element | null {
  return function RepoBundlePointer({ view }: BundleConfigProps): JSX.Element | null {
    if (view !== 'page') return null
    const open = openPage()
    return (
      <div className="dr">
        <div className="dr__list">
          <div className="dr__row">
            <div className="dr__rowText">
              <div className="dr__rowLabel">dsh-repo 的设置在左侧栏「{PAGE_TITLE}」</div>
              <div className="dr__rowSummary">主机与令牌、访问范围、模型工具、超时、上限和本地镜像都在那里配置。</div>
            </div>
            {open === undefined ? null : <div className="dr__rowCtl"><button type="button" className="dr__btn" onClick={open}>打开设置</button></div>}
          </div>
        </div>
      </div>
    )
  }
}

function SettingsPanel(): JSX.Element {
  const [state, setState] = useState<SettingsState | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [draft, setDraft] = useState<SettingsDraft | undefined>()
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({})

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
        <PageHead />
        {loadError === undefined
          ? <div className="dr__loading">加载中…</div>
          : <div className="dr__notice dr__notice--error">{loadError} <button type="button" className="dr__btn dr__btn--ghost" onClick={() => { void reload() }}>重试</button></div>}
      </div>
    )
  }

  const saved = toDraft(state.settings)
  const current = draft ?? saved
  const dirty = !sameDraft(current, saved)
  const edit = (patch: Partial<SettingsDraft>): void => {
    setDraft({ ...current, ...patch })
    setErrors({})
  }
  const save = (): void => {
    const parsed = fromDraft(current)
    if (!parsed.ok) {
      setErrors(parsed.errors)
      setNotice({ kind: 'error', text: Object.values(parsed.errors).join('；') })
      return
    }
    void run(() => saveSettings(parsed.settings), '设置已保存，之后的调用立即生效').then((ok) => { if (ok) setDraft(undefined) })
  }
  const discard = (): void => {
    setDraft(undefined)
    setErrors({})
  }
  const resetAll = (): void => {
    if (!window.confirm('把访问范围、模型工具、超时和上限全部恢复默认？主机、令牌和镜像目录不受影响。')) return
    void run(resetSettings, '已全部恢复默认').then((ok) => { if (ok) discard() })
  }

  const defaults = toDraft(state.defaults)
  const numberRow = (key: NumberKey): JSX.Element => (
    <NumberRow key={key} field={key} value={current.numbers[key]} savedStored={storedNumber(state.settings, key)} defaultStored={storedNumber(state.defaults, key)} error={errors[key]} disabled={busy} onChange={(value) => { edit({ numbers: { ...current.numbers, [key]: value } }) }} />
  )

  return (
    <div className="dr">
      <PageHead />
      {notice === undefined ? null : <div className={`dr__notice dr__notice--${notice.kind}`} role="status">{notice.text}</div>}
      <HostsSection hosts={state.hosts} busy={busy} run={run} />
      <MirrorSection state={state} busy={busy} run={run} onError={(text) => { setNotice({ kind: 'error', text }) }} />

      <Section title="访问范围" foot="仓库范围同时约束模型工具、其他插件经 dshRepos 的调用、镜像和工作区。">
        <Row label="可访问的仓库" summary="每行一个，格式 主机/路径；末段 * 匹配一层，** 匹配任意多层（GitLab 子组）。留空 = 主机上令牌能访问的全部仓库。" error={errors.repos} changed={current.repos !== defaults.repos} block>
          <textarea className="dr__input dr__textarea dr__mono" spellCheck={false} rows={Math.min(8, Math.max(3, current.repos.split('\n').length + 1))} placeholder={'github.com/modestoma/*\ncode.example.com/team/**'} value={current.repos} disabled={busy} onChange={(event) => { edit({ repos: event.target.value }) }} />
        </Row>
        <Row label="其他主机上的仓库" summary={`不在上面主机列表里的仓库地址，是否允许不带凭据镜像（适合公开仓库）。推送始终需要已添加的主机。默认：${state.defaults.mirror.otherHosts ? '允许' : '不允许'}。`} changed={current.otherHosts !== defaults.otherHosts}>
          <Switch label="允许镜像其他主机上的仓库" checked={current.otherHosts} disabled={busy} onChange={(value) => { edit({ otherHosts: value }) }} />
        </Row>
      </Section>

      <Section title="模型工具" foot="改动保存后从模型的下一步开始生效，不用重启。">
        <Row label="提供代码仓库工具" summary="关闭后模型看不到任何 repo_* 工具，其他插件仍可使用 dshRepos 服务。" changed={current.enabled !== defaults.enabled}>
          <Switch label="提供代码仓库工具" checked={current.enabled} disabled={busy} onChange={(value) => { edit({ enabled: value }) }} />
        </Row>
        <Row label="写操作" summary={`创建或评论 issue、PR/MR 和推送工作区。默认：${WRITE_MODES.find(mode => mode.id === state.defaults.tools.writes)?.label ?? state.defaults.tools.writes}。`} changed={current.writes !== defaults.writes}>
          <select className="dr__input dr__select" aria-label="写操作" value={current.writes} disabled={busy || !current.enabled} onChange={(event) => { edit({ writes: event.target.value as SettingsDraft['writes'] }) }}>
            {WRITE_MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
          </select>
        </Row>
        <Row label="合并 PR/MR" summary="提供合并工具 repo_mr_merge，审批方式跟随上面的写操作。默认：不提供。" changed={current.merge !== defaults.merge}>
          <Switch label="提供合并工具" checked={current.merge} disabled={busy || !current.enabled || current.writes === 'off'} onChange={(value) => { edit({ merge: value }) }} />
        </Row>
        <Row label="署名" summary="非空时追加到模型写的 issue、PR/MR 正文和评论末尾（空一行），例如 _由 DSH 生成_。" error={errors.signature} changed={current.signature !== defaults.signature} block>
          <input className="dr__input" aria-label="署名" placeholder="不追加" value={current.signature} disabled={busy} onChange={(event) => { edit({ signature: event.target.value }) }} />
        </Row>
      </Section>

      <Section title="超时">
        {numberRow('timeoutMs')}
        {numberRow('gitTimeoutMs')}
      </Section>

      <Section title="列表与大小上限">
        {numberRow('perPage')}
        {numberRow('maxPerPage')}
        {numberRow('maxComments')}
        {numberRow('maxTreeEntries')}
        {numberRow('maxFileBytes')}
        {numberRow('maxDiffBytes')}
      </Section>

      <div className="dr__saveBar">
        <span className="dr__saveText">{dirty ? '有未保存的修改' : '访问范围、模型工具、超时和上限已保存'}</span>
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={resetAll}>全部恢复默认</button>
        <button type="button" className="dr__btn" disabled={busy || !dirty} onClick={discard}>放弃修改</button>
        <button type="button" className="dr__btn dr__btn--primary" disabled={busy || !dirty} onClick={save}>保存</button>
      </div>

      <p className="dr__secFoot">
        除 cordis.yml 中预置的主机外，以上设置都保存在 <span className="dr__mono">{state.file}</span>（只记录与默认不同的项），升级、卸载或重装插件都不会清空。
      </p>
    </div>
  )
}

function PageHead(): JSX.Element {
  return (
    <header className="dr__head">
      <h1 className="dr__title">{PAGE_TITLE}</h1>
      <p className="dr__subtitle">dsh-repo 连接 GitHub 与 GitLab：为模型提供代码、issue、PR/MR 工具，并为其他插件维护本地镜像和可写工作区。</p>
    </header>
  )
}

function Section({ title, foot, children }: { title: string; foot?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="dr__sec">
      <h2 className="dr__secTitle">{title}</h2>
      <div className="dr__list">{children}</div>
      {foot === undefined ? null : <p className="dr__secFoot">{foot}</p>}
    </section>
  )
}

interface RowProps {
  label: string
  summary: string
  error?: string | undefined
  /** Whether the value differs from the default. */
  changed?: boolean
  /** Put the control under the text instead of beside it. */
  block?: boolean
  children: ReactNode
}

function Row({ label, summary, error, changed, block, children }: RowProps): JSX.Element {
  const text = (
    <div className="dr__rowText">
      <div className="dr__rowLabel"><span>{label}</span>{changed === true ? <span className="dr__tag">非默认</span> : null}</div>
      <div className="dr__rowSummary">{summary}</div>
      {error === undefined ? null : <div className="dr__rowError">{error}</div>}
      {block === true ? <div className="dr__inline">{children}</div> : null}
    </div>
  )
  return (
    <div className="dr__row">
      {text}
      {block === true ? null : <div className="dr__rowCtl">{children}</div>}
    </div>
  )
}

function NumberRow({ field, value, savedStored, defaultStored, error, disabled, onChange }: {
  field: NumberKey
  value: string
  savedStored: number
  defaultStored: number
  error: string | undefined
  disabled: boolean
  onChange: (value: string) => void
}): JSX.Element {
  const spec = NUMBER_FIELDS[field]
  return (
    <Row label={spec.label} summary={`${spec.summary}默认：${displayNumber(field, defaultStored)}。`} error={error} changed={savedStored !== defaultStored}>
      <span className="dr__number">
        <input className="dr__input dr__mono" inputMode="decimal" aria-label={spec.label} aria-invalid={error === undefined ? undefined : true} value={value} disabled={disabled} onChange={(event) => { onChange(event.target.value) }} />
        <span className="dr__unit">{spec.unit}</span>
      </span>
    </Row>
  )
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return <button type="button" role="switch" className="dr__switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => { onChange(!checked) }} />
}

type Run = (action: () => Promise<SettingsState>, success: string) => Promise<boolean>

function HostsSection({ hosts, busy, run }: { hosts: readonly HostInfo[]; busy: boolean; run: Run }): JSX.Element {
  const [kind, setKind] = useState<ForgeKind>('gitlab')
  const [url, setUrl] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [alias, setAlias] = useState('')
  const [token, setToken] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})

  const complete = url.trim() !== '' && alias.trim() !== '' && token.trim() !== ''
  const add = (): void => {
    if (!complete || busy) return
    const host: HostAddRequest = { kind, url: url.trim(), alias: alias.trim(), token: token.trim(), ...kind === 'github' && apiUrl.trim() !== '' ? { apiUrl: apiUrl.trim() } : {} }
    void run(() => addHost(host), `已添加 ${host.url}`).then((ok) => {
      if (!ok) return
      setUrl('')
      setApiUrl('')
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
    <Section title="主机与访问令牌" foot="添加、删除主机和保存令牌立即生效。GitLab 只读镜像需要 read_repository 权限，推送需要 write_repository，issue 和合并请求需要 api 权限；GitHub 需要 Contents、Issues 与 Pull requests 权限，只读时给只读即可。令牌保存在 DSH 凭据库（默认 $DSH_HOME/.credentials.yaml，仅本机用户可读）。cordis.yml 中预置的主机只能在这里更新令牌。">
      {hosts.length === 0 ? <div className="dr__emptyRow">还没有主机。在下面填入 GitLab 或 GitHub 地址、别名和令牌后，代码仓库工具和私有仓库镜像才能使用。</div> : null}
      {hosts.map((host) => {
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
              {host.apiUrl === undefined ? null : <div className="dr__rowSummary">接口地址 <span className="dr__mono">{host.apiUrl}</span></div>}
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
        {kind === 'github' ? <label className="dr__field">接口地址（可选）<input className="dr__input" placeholder="默认 api.github.com 或 地址/api/v3" value={apiUrl} onChange={(event) => { setApiUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label> : null}
        <label className="dr__field">别名<input className="dr__input" placeholder="例如 公司 GitLab" value={alias} onChange={(event) => { setAlias(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">令牌<input className="dr__input dr__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder="粘贴个人访问令牌" value={token} onChange={(event) => { setToken(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <button type="button" className="dr__btn dr__btn--end" disabled={busy || !complete} onClick={add}>添加</button>
      </div>
    </Section>
  )
}

function MirrorSection({ state, busy, run, onError }: { state: SettingsState; busy: boolean; run: Run; onError: (text: string) => void }): JSX.Element {
  const [mirrorDraft, setMirrorDraft] = useState<string | undefined>()
  const mirrorValue = mirrorDraft ?? state.mirror.dir
  const saveMirror = (): void => {
    const dir = mirrorValue.trim()
    if (dir === '' || dir === state.mirror.dir || busy) return
    void run(() => saveMirrorDir(dir), `镜像目录已改为 ${dir}`).then((ok) => { if (ok) setMirrorDraft(undefined) })
  }
  const choose = (): void => {
    void pickDirectory().then((path) => { if (path !== null) setMirrorDraft(path) }, (error: unknown) => { onError(messageOf(error)) })
  }
  return (
    <Section title="本地镜像" foot="代码仓库的只读本地副本（只 fetch，不检出），需要读取仓库文件或按提交建只读快照的插件经它取代码。改目录立即保存；旧目录里的镜像不会搬过去，也不会删除，之后在新目录重新克隆。">
      <div className="dr__row">
        <div className="dr__rowText">
          <div className="dr__rowLabel"><span>镜像目录</span>{state.mirror.dir === state.mirror.defaultDir ? <span className="dr__tag">默认</span> : <span className="dr__tag">非默认</span>}</div>
          <div className="dr__rowSummary">默认：<span className="dr__mono">{state.mirror.defaultDir}</span></div>
          <div className="dr__inline">
            <input className="dr__input dr__mono" spellCheck={false} aria-label="镜像目录" placeholder={state.mirror.defaultDir} value={mirrorValue} onChange={(event) => { setMirrorDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') saveMirror() }} />
            {state.pickerAvailable ? <button type="button" className="dr__btn" disabled={busy} onClick={choose}>选择…</button> : null}
            <button type="button" className="dr__btn" disabled={busy || mirrorValue.trim() === '' || mirrorValue.trim() === state.mirror.dir} onClick={saveMirror}>保存</button>
            {state.mirror.dir === state.mirror.defaultDir ? null : <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={() => { void run(resetMirrorDir, '已恢复默认镜像目录').then((ok) => { if (ok) setMirrorDraft(undefined) }) }}>恢复默认</button>}
          </div>
        </div>
      </div>
    </Section>
  )
}
