/**
 * 左侧栏「代码仓库」整页设置，分六个标签页：主机（主机与令牌）、仓库（仓库
 * 清单：每个仓库的分支、权限、其他插件登记的功能开关和本地同步）、工作区（dsh-repo
 * 建的所有工作区：分支、未提交和未推送的改动、PR/MR，新建、在此新建会话、删除）、
 * 模型工具、MR 跟踪（各类动态的处理方式、检查频率、正在跟踪的 PR/MR）、高级（超时、
 * 上限、工作区目录、代理端口、提交身份、镜像目录、镜像占用）。主机、令牌、仓库清单、工作区、工作区目录、镜像目录和停止跟踪的改动立即保存；其余运行时设置有改动时出现底部保存条，保存后对之后的调用立即生效。
 * 令牌值存入 DSH 凭据库，页面只显示是否已设置。
 *
 * @module dsh-repo/client/page
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ForgeKind, HostInfo, RepoAccess, RepoFeature, TokenStatus } from '../contract.ts'
import { ACCESS_LEVELS, DEFAULT_SYNC_INTERVAL_MINUTES } from '../settings/contract.ts'
import type { HostAddRequest, LocalSyncStatus, MirrorUsage, RepoInput, RepoRow, SettingsState, WatchInfo, WorkspaceRow } from '../settings/contract.ts'
import { addHost, addRepo, clearHostToken, clearWorkspaceDir, createWorkspace, fetchMirrorUsage, fetchState, fetchWorkspaces, messageOf, pickDirectory, removeHost, removeRepo, removeWorkspace, clearMirrorDir, RequestError, resetSettings, saveHostToken, saveMirrorDir, saveSettings, saveWorkspaceDir, stopWatch, syncRepo, updateRepo } from './api.ts'
import { formatBytes, formatInterval, fromDraft, intervalHoursText, NUMBER_FIELDS, parseIntervalHours, sameDraft, toDraft, WATCH_ACTIONS, WATCH_EVENTS, WRITE_MODES } from './form.ts'
import type { DraftField, NumberKey, SettingsDraft } from './form.ts'
import { useWorkspaceOpener } from './navigation.ts'

/** Page title, shared with the sidebar row. */
export const PAGE_TITLE = '代码仓库'

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

type TabId = 'hosts' | 'repos' | 'workspaces' | 'tools' | 'watch' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'hosts', label: '主机' },
  { id: 'repos', label: '仓库' },
  { id: 'workspaces', label: '工作区' },
  { id: 'tools', label: '模型工具' },
  { id: 'watch', label: 'MR 跟踪' },
  { id: 'advanced', label: '高级' },
]

const WATCH_SOURCES: Readonly<Record<WatchInfo['source'], string>> = { created: '创建', pushed: '推送', requested: '要求跟踪' }

/** Relative time such as `3 分钟前`. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

/** Relative future time such as `3 小时后`. */
function until(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  if (seconds < 60) return '即将'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟后`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时后`
  return `${Math.floor(seconds / 86_400)} 天后`
}

/** How often the page refreshes while a local sync is queued or running. */
const SYNC_POLL_MS = 2000

/** Credential store layers of `@deepseek-ai/dsh-credentials-local` other than its own file. */
const TOKEN_SOURCES: Readonly<Record<string, string>> = { 'env': '启动环境变量', 'project-env': '项目 .env', 'user-env': '$DSH_HOME/.env' }

const HOST_KINDS: readonly { id: ForgeKind; label: string }[] = [
  { id: 'gitlab', label: 'GitLab' },
  { id: 'github', label: 'GitHub' },
]

function tokenPill(token: TokenStatus): JSX.Element {
  if (token.error !== undefined) return <span className="dr__pill dr__pill--bad"><span className="dr__dot" />令牌无法读取</span>
  if (!token.configured) return <span className="dr__pill dr__pill--warn"><span className="dr__dot" />未设置令牌</span>
  const source = token.source === undefined || token.source === 'file' ? undefined : TOKEN_SOURCES[token.source] ?? token.source
  return <span className="dr__pill dr__pill--ok"><span className="dr__dot" />{source === undefined ? '令牌已设置' : `令牌来自${source}`}</span>
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
              <div className="dr__rowLabel">设置在左侧栏「{PAGE_TITLE}」</div>
              <div className="dr__rowSummary">主机与令牌、仓库清单（权限、功能、本地同步）、工作区、模型工具、MR 跟踪、超时与上限、本地镜像都在那里配置。</div>
            </div>
            {open === undefined ? null : <div className="dr__rowCtl"><button type="button" className="dr__btn" onClick={open}>打开设置</button></div>}
          </div>
        </div>
      </div>
    )
  }
}

/** Run a change; `success` is the notice after it, or derives the notice from the new state. */
type Run = (action: () => Promise<SettingsState>, success: string | ((state: SettingsState) => Notice)) => Promise<boolean>

function SettingsPanel(): JSX.Element {
  const [state, setState] = useState<SettingsState | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [tab, setTab] = useState<TabId>('hosts')
  const [draft, setDraft] = useState<SettingsDraft | undefined>()
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({})
  /** Catalog entry the 「工作区」 tab opens its creation form for. */
  const [createFor, setCreateFor] = useState<string | undefined>()

  const reload = useCallback(async () => {
    try {
      setState(await fetchState())
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const syncing = tab === 'repos' && !busy && state?.repos.some(repo => repo.sync !== undefined && repo.sync.state !== 'idle') === true
  useEffect(() => {
    if (!syncing) return undefined
    const timer = setTimeout(() => { void reload() }, SYNC_POLL_MS)
    return () => { clearTimeout(timer) }
  }, [syncing, state, reload])

  const run: Run = async (action, success) => {
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await action()
      setState(next)
      setNotice(typeof success === 'string' ? { kind: 'ok', text: success } : success(next))
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
  const defaults = toDraft(state.defaults)
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
    void run(() => saveSettings(parsed.settings), '已保存，之后的调用立即生效').then((ok) => { if (ok) setDraft(undefined) })
  }
  const discard = (): void => {
    setDraft(undefined)
    setErrors({})
  }
  const resetAll = (): void => {
    if (!window.confirm('把模型工具、MR 跟踪、超时和上限全部恢复默认？主机、令牌、仓库清单、镜像目录和正在跟踪的 PR/MR 不受影响。')) return
    void run(resetSettings, '已全部恢复默认').then((ok) => { if (ok) discard() })
  }
  const form = { current, defaults, errors, busy, edit }
  const showError = (text: string): void => { setNotice({ kind: 'error', text }) }

  return (
    <div className="dr">
      <PageHead />
      <nav className="dr__tabs" role="tablist" aria-label="设置分组">
        {TABS.map(item => (
          <button key={item.id} type="button" role="tab" className="dr__tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>
        ))}
      </nav>
      {notice === undefined ? null : <div className={`dr__notice dr__notice--${notice.kind}`} role="status">{notice.text}</div>}

      {tab === 'hosts' ? <HostsTab hosts={state.hosts} busy={busy} run={run} /> : null}
      {tab === 'repos' ? <ReposTab state={state} busy={busy} run={run} onError={showError} onCreateWorkspace={(id) => { setCreateFor(id); setTab('workspaces') }} /> : null}
      {tab === 'workspaces' ? <WorkspacesTab state={state} createFor={createFor} onCreateForm={setCreateFor} onNotice={setNotice} onOpenAdvanced={() => { setTab('advanced') }} /> : null}
      {tab === 'tools' ? <ToolsTab {...form} /> : null}
      {tab === 'watch'
        ? (
            <>
              {state.watchAvailable || !current.watchEnabled ? null : <div className="dr__notice dr__notice--error">当前 DSH 组合不能唤醒会话，PR/MR 跟踪不可用。</div>}
              <WatchTab {...form} />
              <WatchList watches={state.watches} busy={busy} run={run} />
            </>
          )
        : null}
      {tab === 'advanced'
        ? (
            <>
              <AdvancedTab {...form} />
              <WorkspaceSettings form={form} state={state} run={run} onError={showError} />
              <MirrorSection state={state} busy={busy} run={run} onError={showError} />
              <MirrorUsageSection mirrorDir={state.mirror.dir} />
              <div className="dr__footer">
                <span>设置文件 <span className="dr__mono">{state.file}</span>，重装插件不会清空。</span>
                <button type="button" className="dr__link" disabled={busy} onClick={resetAll}>全部恢复默认</button>
              </div>
            </>
          )
        : null}

      {dirty
        ? (
            <div className="dr__saveBar">
              <span className="dr__saveText">有未保存的修改</span>
              <button type="button" className="dr__btn" disabled={busy} onClick={discard}>放弃</button>
              <button type="button" className="dr__btn dr__btn--primary" disabled={busy} onClick={save}>保存</button>
            </div>
          )
        : null}
    </div>
  )
}

function PageHead(): JSX.Element {
  return (
    <header className="dr__head">
      <h1 className="dr__title">{PAGE_TITLE}</h1>
      <p className="dr__subtitle">连接 GitHub 与 GitLab，为模型和其他插件提供代码、issue 与 PR/MR。</p>
    </header>
  )
}

function Section({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="dr__sec">
      {title === undefined ? null : <h2 className="dr__secTitle">{title}</h2>}
      <div className="dr__list">{children}</div>
    </section>
  )
}

function Row({ label, summary, error, block, children }: { label: ReactNode; summary?: string; error?: string | undefined; block?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div className={`dr__row${block === true ? ' dr__row--block' : ''}`}>
      <div className="dr__rowText">
        <div className="dr__rowLabel">{label}</div>
        {summary === undefined ? null : <div className="dr__rowSummary">{summary}</div>}
        {error === undefined ? null : <div className="dr__rowError">{error}</div>}
      </div>
      <div className="dr__rowCtl">{children}</div>
    </div>
  )
}

/** Small link restoring one field; shown only while the field differs from its default. */
function ResetLink({ shown, busy, onReset }: { shown: boolean; busy: boolean; onReset: () => void }): JSX.Element | null {
  if (!shown) return null
  return <button type="button" className="dr__link dr__link--small" disabled={busy} onClick={onReset}>恢复默认</button>
}

interface FormProps {
  current: SettingsDraft
  defaults: SettingsDraft
  errors: Partial<Record<DraftField, string>>
  busy: boolean
  edit: (patch: Partial<SettingsDraft>) => void
}

function ToolsTab({ current, defaults, errors, busy, edit }: FormProps): JSX.Element {
  const off = !current.enabled
  return (
    <Section>
      <Row label="提供代码仓库工具" summary="关闭后模型看不到 repo_* 工具，其他插件不受影响。">
        <Switch label="提供代码仓库工具" checked={current.enabled} disabled={busy} onChange={(value) => { edit({ enabled: value }) }} />
      </Row>
      <Row label="写操作" summary="创建、修改、评论 issue 与 PR/MR，推送工作区，合并 PR/MR；只对仓库清单中权限允许的仓库生效。关闭后一律拒绝，包括工作区里的 git push 和其他插件的调用。">
        <ResetLink shown={current.writes !== defaults.writes} busy={busy} onReset={() => { edit({ writes: defaults.writes }) }} />
        <Segmented label="写操作" value={current.writes} options={WRITE_MODES} disabled={busy || off} onChange={(value) => { edit({ writes: value }) }} />
      </Row>
      <Row label="合并后删除源分支" summary="GitLab 新建的 MR 勾选「合并后删除源分支」，用工具合并时也一并删除；fork、默认和受保护分支不删。">
        <ResetLink shown={current.deleteSourceBranch !== defaults.deleteSourceBranch} busy={busy} onReset={() => { edit({ deleteSourceBranch: defaults.deleteSourceBranch }) }} />
        <Switch label="合并后删除源分支" checked={current.deleteSourceBranch} disabled={busy || off || current.writes === 'off'} onChange={(value) => { edit({ deleteSourceBranch: value }) }} />
      </Row>
      <Row label="署名" summary="追加到模型写的正文和评论末尾。" error={errors.signature}>
        <input className="dr__input dr__input--wide" aria-label="署名" placeholder="不追加" value={current.signature} disabled={busy || off || current.writes === 'off'} onChange={(event) => { edit({ signature: event.target.value }) }} />
      </Row>
    </Section>
  )
}

function NumberRow({ field: key, current, defaults, errors, busy, edit, disabled }: FormProps & { field: NumberKey; disabled?: boolean }): JSX.Element {
  const spec = NUMBER_FIELDS[key]
  const changed = current.numbers[key].trim() !== defaults.numbers[key]
  return (
    <Row label={spec.label} summary={spec.summary} error={errors[key]}>
      <ResetLink shown={changed} busy={busy} onReset={() => { edit({ numbers: { ...current.numbers, [key]: defaults.numbers[key] } }) }} />
      <span className="dr__number">
        <input className="dr__input dr__mono" inputMode="decimal" aria-label={spec.label} aria-invalid={errors[key] === undefined ? undefined : true} placeholder={defaults.numbers[key]} value={current.numbers[key]} disabled={busy || disabled === true} onChange={(event) => { edit({ numbers: { ...current.numbers, [key]: event.target.value } }) }} />
        <span className="dr__unit">{spec.unit}</span>
      </span>
    </Row>
  )
}

function WatchTab(form: FormProps): JSX.Element {
  const { current, defaults, busy, edit } = form
  const off = !current.watchEnabled
  return (
    <>
      <Section>
        <Row label="跟踪 PR/MR" summary="通过工具创建、推送或要求跟踪的 PR/MR，把 CI、评论、评审和合并结果送回发起它的会话。">
          <ResetLink shown={current.watchEnabled !== defaults.watchEnabled} busy={busy} onReset={() => { edit({ watchEnabled: defaults.watchEnabled }) }} />
          <Switch label="跟踪 PR/MR" checked={current.watchEnabled} disabled={busy} onChange={(value) => { edit({ watchEnabled: value }) }} />
        </Row>
      </Section>
      <Section title="各类动态">
        {WATCH_EVENTS.map(event => (
          <Row key={event.id} label={event.label} summary={event.summary}>
            <ResetLink shown={current.watchEvents[event.id] !== defaults.watchEvents[event.id]} busy={busy} onReset={() => { edit({ watchEvents: { ...current.watchEvents, [event.id]: defaults.watchEvents[event.id] } }) }} />
            <Segmented label={event.label} value={current.watchEvents[event.id]} options={WATCH_ACTIONS} disabled={busy || off} onChange={(value) => { edit({ watchEvents: { ...current.watchEvents, [event.id]: value } }) }} />
          </Row>
        ))}
      </Section>
      <p className="dr__secFoot">唤醒：开始会话的一轮回复；只记录：会话正在运行时加入上下文，否则随下一次唤醒一起送达；忽略：不通知。评论内容只作为信息交给模型，不能授予权限。</p>
      <Section title="频率与上限">
        {(['activeIntervalMs', 'quietAfterMs', 'quietIntervalMs', 'batchMs', 'idleDays', 'dailyWakeLimit', 'maxWatches'] as const).map(key => <NumberRow key={key} field={key} {...form} disabled={off} />)}
      </Section>
    </>
  )
}

function WatchList({ watches, busy, run }: { watches: readonly WatchInfo[]; busy: boolean; run: Run }): JSX.Element {
  const now = Date.now()
  return (
    <Section title={`正在跟踪（${watches.length}）`}>
      {watches.length === 0 ? <div className="dr__emptyRow">没有正在跟踪的 PR/MR。</div> : null}
      {watches.map(watch => (
        <div key={watch.id} className="dr__watch">
          <span className="dr__watchName" title={`${watch.repo} #${watch.number} ${watch.title}`}>
            <a href={watch.webUrl} target="_blank" rel="noreferrer">{watch.repo} #{watch.number}</a> {watch.title}
          </span>
          <span className="dr__watchMeta dr__watchMeta--session dr__mono" title={`会话 ${watch.session}`}>{watch.session.slice(0, 8)}</span>
          <span className="dr__watchMeta">{WATCH_SOURCES[watch.source]}</span>
          {watch.pending > 0 ? <span className="dr__pill">{watch.pending} 条待送达</span> : null}
          {watch.failures >= 3 ? <span className="dr__pill dr__pill--bad" title={watch.lastError}><span className="dr__dot" />连续失败 {watch.failures} 次</span> : null}
          <span className="dr__watchMeta dr__watchMeta--time" title={`最近动态 ${watch.lastActivityAt}`}>{ago(watch.lastActivityAt, now)}</span>
          <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={() => { void run(() => stopWatch(watch.id), `已停止跟踪 ${watch.repo} #${watch.number}`) }}>停止</button>
        </div>
      ))}
    </Section>
  )
}

function AdvancedTab(form: FormProps): JSX.Element {
  const numberRow = (key: NumberKey): JSX.Element => <NumberRow key={key} field={key} {...form} />
  return (
    <>
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
        {numberRow('maxLogBytes')}
        {numberRow('maxCiFailures')}
      </Section>
    </>
  )
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return <button type="button" role="switch" className="dr__switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => { onChange(!checked) }} />
}

function Segmented<T extends string>({ label, value, options, disabled, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; disabled: boolean; onChange: (value: T) => void }): JSX.Element {
  return (
    <span className="dr__seg" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button key={option.id} type="button" role="radio" className="dr__segItem" aria-checked={value === option.id} disabled={disabled} onClick={() => { onChange(option.id) }}>{option.label}</button>
      ))}
    </span>
  )
}

function HostsTab({ hosts, busy, run }: { hosts: readonly HostInfo[]; busy: boolean; run: Run }): JSX.Element {
  const [adding, setAdding] = useState(false)
  return (
    <>
      <Section>
        {hosts.length === 0 && !adding ? <div className="dr__emptyRow">还没有主机。添加 GitLab 或 GitHub 主机和令牌后，代码仓库工具和私有仓库镜像才能使用。</div> : null}
        {hosts.map(host => <HostRow key={host.url} host={host} busy={busy} run={run} />)}
        {adding
          ? <AddHostForm busy={busy} run={run} onDone={() => { setAdding(false) }} />
          : <div className="dr__addRow"><button type="button" className="dr__link" disabled={busy} onClick={() => { setAdding(true) }}>＋ 添加主机</button></div>}
      </Section>
      <details className="dr__help">
        <summary>令牌需要哪些权限？</summary>
        <p>GitLab：只读镜像需要 read_repository，推送需要 write_repository，issue 和合并请求需要 api。GitHub：Contents、Issues、Pull requests，只读使用给只读即可。令牌保存在 DSH 凭据库（默认 $DSH_HOME/.credentials.yaml，仅本机用户可读）。标为 cordis.yml 的主机由 profile 预置，只能更换令牌。</p>
      </details>
    </>
  )
}

function HostRow({ host, busy, run }: { host: HostInfo; busy: boolean; run: Run }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const name = host.alias ?? host.url
  const showInput = host.token.writable && (editing || !host.token.configured)
  const save = (): void => {
    if (value.trim() === '' || busy) return
    void run(() => saveHostToken(host.url, value.trim()), `已保存 ${name} 的令牌`).then((ok) => {
      if (!ok) return
      setValue('')
      setEditing(false)
    })
  }
  return (
    <div className="dr__row dr__row--top">
      <div className="dr__rowText">
        <div className="dr__rowLabel">
          <span className="dr__strong">{name}</span>
          <span className="dr__tag">{host.kind === 'github' ? 'GitHub' : 'GitLab'}</span>
          {host.origin === 'config' ? <span className="dr__tag">cordis.yml</span> : null}
          {tokenPill(host.token)}
        </div>
        <div className="dr__rowSummary dr__mono">{host.alias === undefined ? null : host.url}{host.apiUrl === undefined ? null : `${host.alias === undefined ? '' : ' · '}接口 ${host.apiUrl}`}</div>
        {host.token.error === undefined ? null : <div className="dr__rowError">{host.token.error}</div>}
        {showInput
          ? (
              <div className="dr__inline">
                <input className="dr__input dr__mono" type="password" autoComplete="new-password" spellCheck={false} aria-label={`${name} 的令牌`} placeholder={host.token.configured ? '新令牌' : '粘贴令牌'} value={value} onChange={(event) => { setValue(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setEditing(false) }} />
                <button type="button" className="dr__btn" disabled={busy || value.trim() === ''} onClick={save}>保存</button>
                {editing ? <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={() => { setEditing(false); setValue('') }}>取消</button> : null}
              </div>
            )
          : null}
      </div>
      <div className="dr__rowCtl">
        {host.token.writable && host.token.configured && !editing ? <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={() => { setEditing(true) }}>更换令牌</button> : null}
        {host.token.configured && host.token.source === 'file' && !editing ? <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={() => { void run(() => clearHostToken(host.url), `已清除 ${name} 的令牌`) }}>清除令牌</button> : null}
        {host.origin === 'added' ? <button type="button" className="dr__btn dr__btn--ghost dr__btn--danger" disabled={busy} onClick={() => { if (window.confirm(`删除主机 ${name} 及其保存的令牌？`)) void run(() => removeHost(host.url), `已删除 ${name}`) }}>删除</button> : null}
      </div>
    </div>
  )
}

function AddHostForm({ busy, run, onDone }: { busy: boolean; run: Run; onDone: () => void }): JSX.Element {
  const [kind, setKind] = useState<ForgeKind>('gitlab')
  const [url, setUrl] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [alias, setAlias] = useState('')
  const [token, setToken] = useState('')
  const complete = url.trim() !== '' && alias.trim() !== '' && token.trim() !== ''
  const add = (): void => {
    if (!complete || busy) return
    const host: HostAddRequest = { kind, url: url.trim(), alias: alias.trim(), token: token.trim(), ...kind === 'github' && apiUrl.trim() !== '' ? { apiUrl: apiUrl.trim() } : {} }
    void run(() => addHost(host), `已添加 ${host.alias ?? host.url}`).then((ok) => { if (ok) onDone() })
  }
  const submitOnEnter = (event: { key: string }): void => { if (event.key === 'Enter') add() }
  return (
    <div className="dr__addForm">
      <div className="dr__formGrid">
        <label className="dr__field">类型
          <Segmented label="类型" value={kind} options={HOST_KINDS} disabled={busy} onChange={setKind} />
        </label>
        <label className="dr__field">别名<input className="dr__input" placeholder="例如 公司 GitLab" value={alias} onChange={(event) => { setAlias(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">地址<input className="dr__input" placeholder={kind === 'github' ? 'https://github.com' : 'https://gitlab.example.com'} value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">令牌<input className="dr__input dr__mono" type="password" autoComplete="new-password" spellCheck={false} placeholder="个人访问令牌" value={token} onChange={(event) => { setToken(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        {kind === 'github' ? <label className="dr__field dr__field--full">接口地址（可选，GitHub Enterprise 非默认时填写）<input className="dr__input" placeholder="默认 api.github.com 或 地址/api/v3" value={apiUrl} onChange={(event) => { setApiUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label> : null}
      </div>
      <div className="dr__formActions">
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={onDone}>取消</button>
        <button type="button" className="dr__btn dr__btn--primary" disabled={busy || !complete} onClick={add}>添加</button>
      </div>
    </div>
  )
}

function MirrorSection({ state, busy, run, onError }: { state: SettingsState; busy: boolean; run: Run; onError: (text: string) => void }): JSX.Element {
  const [mirrorDraft, setMirrorDraft] = useState<string | undefined>()
  const current = state.mirror.dir ?? ''
  const mirrorValue = mirrorDraft ?? current
  const saveMirror = (): void => {
    const dir = mirrorValue.trim()
    if (dir === '' || dir === current || busy) return
    void run(() => saveMirrorDir(dir), `镜像目录已改为 ${dir}`).then((ok) => { if (ok) setMirrorDraft(undefined) })
  }
  const choose = (): void => {
    void pickDirectory().then((path) => { if (path !== null) setMirrorDraft(path) }, (error: unknown) => { onError(messageOf(error)) })
  }
  const changed = mirrorValue.trim() !== '' && mirrorValue.trim() !== current
  return (
    <Section title="本地镜像">
      <Row label="镜像目录" summary="仓库只读本地副本所在的目录，没有默认值：未设置时拉取仓库、代码快照、工作区和本地同步都不可用。不能在 DSH 主目录或 /tmp 下，也不要放在 Agent 可写的目录里。改目录立即保存，旧镜像不搬也不删。" block>
        {state.mirror.dir === undefined ? <div className="dr__rowError">{state.mirror.problem ?? '镜像目录未设置。'}</div> : null}
        <div className="dr__inline">
          <input className="dr__input dr__mono" spellCheck={false} aria-label="镜像目录" placeholder="例如 /srv/dsh-repo/mirrors" value={mirrorValue} onChange={(event) => { setMirrorDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') saveMirror() }} />
          {state.pickerAvailable ? <button type="button" className="dr__btn" disabled={busy} onClick={choose}>选择…</button> : null}
          {changed ? <button type="button" className="dr__btn dr__btn--primary" disabled={busy} onClick={saveMirror}>保存</button> : null}
          {state.mirror.dir === undefined || changed ? null : <button type="button" className="dr__link dr__link--small" disabled={busy} onClick={() => { void run(clearMirrorDir, '已清除镜像目录').then((ok) => { if (ok) setMirrorDraft(undefined) }) }}>清除</button>}
        </div>
      </Row>
    </Section>
  )
}

/** Notice after a change that may have synced: the repository's sync failure, or `success`. */
function repoNotice(match: (repo: RepoRow) => boolean, success: string): (state: SettingsState) => Notice {
  return (state) => {
    const repo = state.repos.find(match)
    return repo?.sync?.error === undefined ? { kind: 'ok', text: success } : { kind: 'error', text: `已保存，但本地同步失败：${repo.sync.error}` }
  }
}

function accessText(access: RepoAccess): string {
  return ACCESS_LEVELS.find(level => level.id === access)?.label ?? access
}

function ReposTab({ state, busy, run, onError, onCreateWorkspace }: { state: SettingsState; busy: boolean; run: Run; onError: (text: string) => void; onCreateWorkspace: (id: string) => void }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | undefined>()
  const now = Date.now()
  const form = { features: state.features, picker: state.pickerAvailable, busy, onError }
  return (
    <>
      <Section>
        {state.repos.length === 0 && !adding
          ? <div className="dr__emptyRow">{state.hosts.length === 0 ? '还没有主机。先在「主机」中添加 GitLab 或 GitHub 主机和令牌，再把要用的仓库加到这里。' : '仓库清单为空。只有加入清单的仓库才能被模型工具和其他插件访问。'}</div>
          : null}
        {state.repos.map(repo => repo.id === editing
          ? <RepoForm key={repo.id} repo={repo} {...form} onCancel={() => { setEditing(undefined) }} onSubmit={(input) => { void run(() => updateRepo(repo.id, input), repoNotice(item => item.id === repo.id, '已保存')).then((ok) => { if (ok) setEditing(undefined) }) }} />
          : <RepoListRow key={repo.id} repo={repo} features={state.features} now={now} busy={busy} run={run} onEdit={() => { setEditing(repo.id) }} {...state.workspace.available && canWorkIn(repo) ? { onCreateWorkspace: () => { onCreateWorkspace(repo.id) } } : {}} />)}
        {adding
          ? <RepoForm {...form} onCancel={() => { setAdding(false) }} onSubmit={(input) => { void run(() => addRepo(input), repoNotice(item => item.url === input.url.trim(), '已加入仓库清单')).then((ok) => { if (ok) setAdding(false) }) }} />
          : <div className="dr__addRow"><button type="button" className="dr__link" disabled={busy} onClick={() => { setAdding(true) }}>＋ 添加仓库</button></div>}
      </Section>
      <p className="dr__secFoot">清单外的仓库一律不能访问。权限：只读可以读代码、issue、PR/MR 和 CI，也可以在本机检出工作区；可改代码另外可以推送工作区、创建和评论 issue 与 PR/MR、重试或取消 CI、删除已合并的分支；可合并另外可以合并 PR/MR。功能开关由其他插件登记，例如日志分析插件用它决定分析哪些仓库。本地同步把分支最新提交定时展开到本机目录（只有普通文件，没有 .git）：只写入有变化的文件，删除分支上已删除的文件，本地改过的文件恢复成仓库里的版本；第一次同步要求目录不存在或为空；关闭或删除不会删除目录里的文件。</p>
    </>
  )
}

function syncPill(sync: LocalSyncStatus): JSX.Element {
  if (sync.state === 'running') return <span className="dr__pill dr__pill--ok"><span className="dr__dot" />同步中</span>
  if (sync.state === 'queued') return <span className="dr__pill"><span className="dr__dot" />排队中</span>
  if (sync.error !== undefined) return <span className="dr__pill dr__pill--bad"><span className="dr__dot" />同步失败</span>
  if (sync.commit === undefined) return <span className="dr__pill dr__pill--warn"><span className="dr__dot" />还没同步</span>
  return <span className="dr__pill dr__pill--ok"><span className="dr__dot" />已同步</span>
}

/** Whether the page offers 「新建工作区」 for a catalog repository: it can be reached and its access allows pushing. */
function canWorkIn(repo: RepoRow): boolean {
  return repo.problem === undefined && repo.access !== 'read'
}

function RepoListRow({ repo, features, now, busy, run, onEdit, onCreateWorkspace }: { repo: RepoRow; features: readonly RepoFeature[]; now: number; busy: boolean; run: Run; onEdit: () => void; onCreateWorkspace?: () => void }): JSX.Element {
  const titles = repo.features.map(id => features.find(feature => feature.id === id)?.title ?? id)
  const sync = repo.sync
  const parts: string[] = []
  if (repo.localSync?.enabled === true) {
    parts.push(`每 ${formatInterval(repo.localSync.intervalMinutes)}`)
    if (sync?.syncedAt !== undefined) parts.push(`上次 ${ago(sync.syncedAt, now)}${sync.commit === undefined ? '' : `（${sync.syncedBranch ?? ''} ${sync.commit.slice(0, 8)}）`}`)
    if (sync?.nextAt !== undefined) parts.push(`下次 ${until(sync.nextAt, now)}`)
  }
  const name = repo.key ?? repo.url
  return (
    <div className="dr__row dr__row--top">
      <div className="dr__rowText">
        <div className="dr__rowLabel">
          <span className="dr__strong dr__mono" title={repo.url}>{name}</span>
          <span className="dr__tag">{repo.branch ?? '默认分支'}</span>
          <span className="dr__tag">{accessText(repo.access)}</span>
          {titles.map(title => <span key={title} className="dr__tag">{title}</span>)}
          {sync === undefined ? null : syncPill(sync)}
        </div>
        {repo.localSync?.enabled === true ? <div className="dr__rowSummary"><span className="dr__mono">本地同步 → {repo.localSync.dir}</span>{parts.length === 0 ? null : ` · ${parts.join(' · ')}`}</div> : null}
        {repo.problem === undefined ? null : <div className="dr__rowError">{repo.problem}</div>}
        {sync?.error === undefined ? null : <div className="dr__rowError">{sync.error}</div>}
      </div>
      <div className="dr__rowCtl">
        {onCreateWorkspace === undefined ? null : <button type="button" className="dr__btn" disabled={busy} onClick={onCreateWorkspace}>新建工作区</button>}
        {sync === undefined ? null : <button type="button" className="dr__btn" disabled={busy || sync.state !== 'idle'} onClick={() => { void run(() => syncRepo(repo.id), repoNotice(item => item.id === repo.id, `已同步 ${name}`)) }}>立即同步</button>}
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={onEdit}>编辑</button>
        <button type="button" className="dr__btn dr__btn--ghost dr__btn--danger" disabled={busy} onClick={() => { if (window.confirm(`把 ${name} 移出仓库清单？之后模型工具和其他插件都不能再访问它${repo.localSync?.enabled === true ? `；本地同步目录 ${repo.localSync.dir} 里的文件会保留` : ''}。`)) void run(() => removeRepo(repo.id), `已把 ${name} 移出仓库清单`) }}>删除</button>
      </div>
    </div>
  )
}

function RepoForm({ repo, features, picker, busy, onError, onCancel, onSubmit }: { repo?: RepoRow; features: readonly RepoFeature[]; picker: boolean; busy: boolean; onError: (text: string) => void; onCancel: () => void; onSubmit: (input: RepoInput) => void }): JSX.Element {
  const [url, setUrl] = useState(repo?.url ?? '')
  const [branch, setBranch] = useState(repo?.branch ?? '')
  const [access, setAccess] = useState<RepoAccess>(repo?.access ?? 'read')
  const [enabled, setEnabled] = useState<readonly string[]>(repo?.features ?? [])
  const [syncOn, setSyncOn] = useState(repo?.localSync?.enabled ?? false)
  const [dir, setDir] = useState(repo?.localSync?.dir ?? '')
  const [hours, setHours] = useState(intervalHoursText(repo?.localSync?.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES))
  const [error, setError] = useState<string | undefined>()
  // Features turned on by a plugin that is not loaded now stay listed so saving keeps them.
  const shown = [...features, ...enabled.filter(id => !features.some(feature => feature.id === id)).map(id => ({ id, title: id, description: '登记这个功能的插件当前没有加载' }))]
  const complete = url.trim() !== '' && (!syncOn || dir.trim() !== '')
  const toggle = (id: string, on: boolean): void => { setEnabled(on ? [...enabled, id] : enabled.filter(item => item !== id)) }
  const submit = (): void => {
    if (!complete || busy) return
    const interval = parseIntervalHours(hours)
    if (syncOn && !interval.ok) {
      setError(interval.message)
      return
    }
    setError(undefined)
    const keepSync = syncOn || dir.trim() !== ''
    onSubmit({
      url: url.trim(),
      branch: branch.trim(),
      access,
      features: [...enabled],
      ...keepSync ? { localSync: { enabled: syncOn, dir: dir.trim(), ...interval.ok ? { intervalMinutes: interval.minutes } : {} } } : {},
    })
  }
  const choose = (): void => {
    void pickDirectory().then((path) => { if (path !== null) setDir(path) }, (failure: unknown) => { onError(messageOf(failure)) })
  }
  const submitOnEnter = (event: { key: string }): void => { if (event.key === 'Enter') submit() }
  return (
    <div className="dr__addForm">
      <div className="dr__formGrid">
        <label className="dr__field dr__field--full">仓库地址<input className="dr__input dr__mono" spellCheck={false} placeholder="https://gitlab.example.com/team/order-service.git" value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">分支（可选）<input className="dr__input dr__mono" spellCheck={false} placeholder="默认分支" value={branch} onChange={(event) => { setBranch(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">权限
          <Segmented label="权限" value={access} options={ACCESS_LEVELS} disabled={busy} onChange={setAccess} />
        </label>
      </div>
      <div className="dr__list">
        {shown.map(feature => (
          <Row key={feature.id} label={feature.title} {...feature.description === undefined ? {} : { summary: feature.description }}>
            <Switch label={feature.title} checked={enabled.includes(feature.id)} disabled={busy} onChange={(on) => { toggle(feature.id, on) }} />
          </Row>
        ))}
        <Row label="本地同步" summary="把分支最新提交定时展开到本机目录。">
          <Switch label="本地同步" checked={syncOn} disabled={busy} onChange={setSyncOn} />
        </Row>
      </div>
      {syncOn
        ? (
            <div className="dr__formGrid">
              <div className="dr__field">本地目录
                <div className="dr__inline dr__inline--flush">
                  <input className="dr__input dr__mono" spellCheck={false} aria-label="本地目录" placeholder="/绝对路径/目录，不存在会自动创建" value={dir} onChange={(event) => { setDir(event.target.value) }} onKeyDown={submitOnEnter} />
                  {picker ? <button type="button" className="dr__btn" disabled={busy} onClick={choose}>选择…</button> : null}
                </div>
              </div>
              <label className="dr__field">同步间隔（小时）<input className="dr__input dr__mono" inputMode="decimal" aria-invalid={error === undefined ? undefined : true} value={hours} onChange={(event) => { setHours(event.target.value); setError(undefined) }} onKeyDown={submitOnEnter} /></label>
            </div>
          )
        : null}
      {error === undefined ? null : <div className="dr__rowError">{error}</div>}
      <div className="dr__formActions">
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="dr__btn dr__btn--primary" disabled={busy || !complete} onClick={submit}>{busy ? '保存中…' : repo === undefined ? '添加' : '保存'}</button>
      </div>
    </div>
  )
}

function MirrorUsageSection({ mirrorDir }: { mirrorDir: string | undefined }): JSX.Element {
  const [usage, setUsage] = useState<MirrorUsage | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const load = useCallback(async () => {
    if (mirrorDir === undefined) {
      setUsage(undefined)
      setError('镜像目录未设置，没有可统计的内容。')
      return
    }
    setLoading(true)
    try {
      setUsage(await fetchMirrorUsage())
      setError(undefined)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setLoading(false)
    }
  }, [mirrorDir])
  useEffect(() => { void load() }, [load])
  const now = Date.now()
  return (
    <section className="dr__sec">
      <div className="dr__secHead">
        <h2 className="dr__secTitle">镜像占用{usage === undefined ? '' : `（合计 ${formatBytes(usage.totalBytes)}）`}</h2>
        <button type="button" className="dr__link dr__link--small" disabled={loading} onClick={() => { void load() }}>{loading ? '统计中…' : '重新统计'}</button>
      </div>
      <div className="dr__list">
        {error === undefined ? null : <div className="dr__emptyRow dr__rowError">{error}</div>}
        {usage === undefined && error === undefined ? <div className="dr__emptyRow">统计中…</div> : null}
        {usage !== undefined && usage.mirrors.length === 0 ? <div className="dr__emptyRow">镜像目录里还没有仓库。</div> : null}
        {usage?.mirrors.map(mirror => (
          <div key={mirror.path} className="dr__watch">
            <span className="dr__watchName dr__mono" title={mirror.url ?? mirror.path}>{mirror.path}</span>
            {mirror.fetchedAt === undefined ? null : <span className="dr__watchMeta dr__watchMeta--time" title={`最近拉取 ${mirror.fetchedAt}`}>{ago(mirror.fetchedAt, now)}</span>}
            <span className="dr__watchMeta dr__watchMeta--size">{formatBytes(mirror.bytes)}</span>
          </div>
        ))}
      </div>
      {usage === undefined ? null : <p className="dr__secFoot">快照 {formatBytes(usage.snapshotBytes)} · 其他 {formatBytes(usage.otherBytes)}。时间是最近一次拉取。</p>}
    </section>
  )
}

/** The directory name a new workspace of a repository gets by default. */
function defaultName(url: string): string {
  return url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/\\]/).pop() ?? 'repo'
}

function WorkspacesTab({ state, createFor, onCreateForm, onNotice, onOpenAdvanced }: { state: SettingsState; createFor: string | undefined; onCreateForm: (repo: string | undefined) => void; onNotice: (notice: Notice) => void; onOpenAdvanced: () => void }): JSX.Element {
  const [rows, setRows] = useState<WorkspaceRow[] | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const opener = useWorkspaceOpener()
  const load = useCallback(async () => {
    try {
      setRows(await fetchWorkspaces())
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    onNotice(undefined)
    try {
      await action()
    } catch (error) {
      onNotice({ kind: 'error', text: messageOf(error) })
    } finally {
      setBusy(false)
    }
  }
  const open = async (path: string): Promise<void> => {
    if (opener === undefined) return
    await opener.open(path)
  }
  const remove = (row: WorkspaceRow): void => {
    if (!window.confirm(`删除工作区 ${row.path}？目录会整个删掉。`)) return
    void act(async () => {
      try {
        setRows(await removeWorkspace(row.id, false))
      } catch (error) {
        if (!(error instanceof RequestError) || error.status !== 409) throw error
        if (!window.confirm(`${error.message.replace(/；确认不要了再用 force 删除$/, '')}。仍然删除？这些改动会丢失。`)) return
        setRows(await removeWorkspace(row.id, true))
      }
      onNotice({ kind: 'ok', text: `已删除工作区 ${row.path}` })
    })
  }
  const create = (input: { repo: string; base: string; branch: string; name: string }): void => {
    void act(async () => {
      const row = await createWorkspace(input)
      onCreateForm(undefined)
      await load()
      if (opener === undefined) {
        onNotice({ kind: 'ok', text: `已在 ${row.path} 新建工作区，推送分支 ${row.branch}` })
        return
      }
      try {
        await open(row.path)
      } catch (error) {
        onNotice({ kind: 'error', text: `已在 ${row.path} 新建工作区，但没能在 DSH 里打开：${messageOf(error)}` })
      }
    })
  }
  const repos = state.repos.filter(canWorkIn)
  const now = Date.now()
  return (
    <>
      <section className="dr__sec">
        <div className="dr__secHead">
          <h2 className="dr__secTitle">{rows === undefined ? '工作区' : `工作区（${rows.length}）`}</h2>
          <button type="button" className="dr__link dr__link--small" disabled={busy} onClick={() => { void load() }}>刷新</button>
        </div>
        <div className="dr__list">
          {loadError === undefined ? null : <div className="dr__emptyRow dr__rowError">{loadError}</div>}
          {rows === undefined && loadError === undefined ? <div className="dr__emptyRow">加载中…</div> : null}
          {rows !== undefined && rows.length === 0 && createFor === undefined ? <div className="dr__emptyRow">还没有工作区。工作区是一个完整的 git 仓库，可以在里面开会话改代码，用普通的 git 命令提交和推送。</div> : null}
          {rows?.map(row => <WorkspaceListRow key={row.id} row={row} now={now} busy={busy} {...opener === undefined ? {} : { onOpen: () => { void act(() => open(row.path)) } }} onRemove={() => { remove(row) }} />)}
          {createFor === undefined
            ? <div className="dr__addRow"><button type="button" className="dr__link" disabled={busy || !state.workspace.available} onClick={() => { onCreateForm(repos[0]?.id ?? '') }}>＋ 新建工作区</button></div>
            : <WorkspaceForm state={state} repos={repos} initial={createFor} busy={busy} onCancel={() => { onCreateForm(undefined) }} onSubmit={create} onOpenAdvanced={onOpenAdvanced} />}
        </div>
      </section>
      <p className="dr__secFoot">工作区的 origin 经本机 git 代理访问远端，令牌不进工作区；fetch、pull、push 都可以直接用，推送到默认分支、受保护分支、标签和删除分支会被拒绝。设置页新建的工作区不属于任何会话，推送不经会话授权；在里面开的会话照常使用模型工具的审批设置。{opener === undefined ? '当前界面不能打开 DSH 工作区，新建后请在左侧栏用这个目录新建会话。' : ''}</p>
    </>
  )
}

function WorkspaceListRow({ row, now, busy, onOpen, onRemove }: { row: WorkspaceRow; now: number; busy: boolean; onOpen?: () => void; onRemove: () => void }): JSX.Element {
  const branch = row.currentBranch ?? row.branch
  const meta: string[] = []
  if (row.activityAt !== undefined) meta.push(`最近 git 活动 ${ago(row.activityAt, now)}`)
  meta.push(row.session === undefined ? '设置页新建' : `会话 ${row.session.slice(0, 8)}`)
  return (
    <div className="dr__row dr__row--top">
      <div className="dr__rowText">
        <div className="dr__rowLabel">
          <span className="dr__strong dr__mono" title={row.url}>{row.repo}</span>
          <span className="dr__tag dr__mono" title={row.currentBranch === undefined || row.currentBranch === row.branch ? `推送到 ${row.branch}` : `当前在 ${row.currentBranch}，推送到 ${row.branch}`}>{branch} → {row.base}</span>
          {row.uncommittedFiles === undefined || row.uncommittedFiles === 0 ? null : <span className="dr__pill dr__pill--warn"><span className="dr__dot" />{row.uncommittedFiles} 个文件未提交</span>}
          {row.unpushed === undefined || row.unpushed === 0 ? null : <span className="dr__pill dr__pill--warn"><span className="dr__dot" />{row.unpushed} 个提交未推送</span>}
          {row.uncommittedFiles === 0 && row.unpushed === 0 ? <span className="dr__pill dr__pill--ok"><span className="dr__dot" />已推送</span> : null}
          {row.mrs?.map(mr => <a key={mr.number} className="dr__tag" href={mr.webUrl} target="_blank" rel="noreferrer" title={mr.title}>#{mr.number}</a>)}
        </div>
        <div className="dr__rowSummary"><span className="dr__mono">{row.path}</span> · {meta.join(' · ')}</div>
        {row.error === undefined ? null : <div className="dr__rowError">{row.error}</div>}
      </div>
      <div className="dr__rowCtl">
        {onOpen === undefined ? null : <button type="button" className="dr__btn" disabled={busy} onClick={onOpen}>在此新建会话</button>}
        <button type="button" className="dr__btn dr__btn--ghost dr__btn--danger" disabled={busy} onClick={onRemove}>删除</button>
      </div>
    </div>
  )
}

function WorkspaceForm({ state, repos, initial, busy, onCancel, onSubmit, onOpenAdvanced }: { state: SettingsState; repos: readonly RepoRow[]; initial: string; busy: boolean; onCancel: () => void; onSubmit: (input: { repo: string; base: string; branch: string; name: string }) => void; onOpenAdvanced: () => void }): JSX.Element {
  const [repoId, setRepoId] = useState(repos.some(repo => repo.id === initial) ? initial : repos[0]?.id ?? '')
  const [base, setBase] = useState('')
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const repo = repos.find(item => item.id === repoId)
  const dir = state.workspace.dir
  const submit = (): void => {
    if (repo === undefined || dir === undefined || busy) return
    onSubmit({ repo: repo.id, base: base.trim(), branch: branch.trim(), name: name.trim() })
  }
  const submitOnEnter = (event: { key: string }): void => { if (event.key === 'Enter') submit() }
  if (dir === undefined || repos.length === 0) {
    return (
      <div className="dr__addForm">
        <div className="dr__rowError">{dir === undefined ? '还没有设置工作区目录，设置后才能在这里新建工作区。' : '仓库清单里没有权限为「可改代码」或「可合并」的仓库。'}</div>
        <div className="dr__formActions">
          <button type="button" className="dr__btn dr__btn--ghost" onClick={onCancel}>取消</button>
          {dir === undefined ? <button type="button" className="dr__btn dr__btn--primary" onClick={onOpenAdvanced}>去设置</button> : null}
        </div>
      </div>
    )
  }
  return (
    <div className="dr__addForm">
      <div className="dr__formGrid">
        <label className="dr__field dr__field--full">仓库
          <select className="dr__input dr__mono" value={repoId} disabled={busy} onChange={(event) => { setRepoId(event.target.value) }}>
            {repos.map(item => <option key={item.id} value={item.id}>{item.key ?? item.url}</option>)}
          </select>
        </label>
        <label className="dr__field">合入分支（可选）<input className="dr__input dr__mono" spellCheck={false} placeholder={repo?.branch ?? '默认分支'} value={base} onChange={(event) => { setBase(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">推送分支（可选）<input className="dr__input dr__mono" spellCheck={false} placeholder="dsh/随机名；已有分支会接着改" value={branch} onChange={(event) => { setBranch(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field dr__field--full">目录名（可选）<input className="dr__input dr__mono" spellCheck={false} placeholder={repo === undefined ? '' : `${defaultName(repo.url)}，重名时加编号`} value={name} onChange={(event) => { setName(event.target.value) }} onKeyDown={submitOnEnter} /></label>
      </div>
      <div className="dr__rowSummary">建在 <span className="dr__mono">{dir}</span> 下，从合入分支的最新提交开始。</div>
      <div className="dr__formActions">
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="dr__btn dr__btn--primary" disabled={busy || repo === undefined} onClick={submit}>{busy ? '新建中…' : '新建'}</button>
      </div>
    </div>
  )
}

function WorkspaceSettings({ form, state, run, onError }: { form: FormProps; state: SettingsState; run: Run; onError: (text: string) => void }): JSX.Element {
  const { current, defaults, errors, busy, edit } = form
  const [dirDraft, setDirDraft] = useState<string | undefined>()
  const saved = state.workspace.dir ?? ''
  const dirValue = dirDraft ?? saved
  const changed = dirValue.trim() !== '' && dirValue.trim() !== saved
  const saveDir = (): void => {
    const dir = dirValue.trim()
    if (!changed || busy) return
    void run(() => saveWorkspaceDir(dir), (next) => ({ kind: 'ok', text: `工作区目录已改为 ${next.workspace.dir ?? dir}` })).then((ok) => { if (ok) setDirDraft(undefined) })
  }
  const choose = (): void => {
    void pickDirectory().then((path) => { if (path !== null) setDirDraft(path) }, (error: unknown) => { onError(messageOf(error)) })
  }
  const listening = state.workspace.proxyListening
  const configuredPort = state.settings.workspace.proxyPort
  // A failed bind leaves the new port saved, so the save bar has nothing to save; saving the same settings again restarts the proxy.
  const proxyOff = state.workspace.available && (listening === undefined || (configuredPort !== 0 && listening !== configuredPort))
  const retryProxy = (): void => {
    void run(() => saveSettings(state.settings), (next) => next.workspace.proxyListening === undefined ? { kind: 'error', text: '代理仍然没有运行' } : { kind: 'ok', text: `代理已监听 127.0.0.1:${next.workspace.proxyListening}` })
  }
  return (
    <Section title="工作区">
      <Row label="工作区目录" summary="「工作区」里新建的工作区放在这个目录下，不存在会自动创建。会话里用工具新建的工作区放在会话自己的目录里，不受影响。" block>
        <div className="dr__inline">
          <input className="dr__input dr__mono" spellCheck={false} aria-label="工作区目录" placeholder="例如 /srv/dsh/workspaces" value={dirValue} disabled={!state.workspace.available} onChange={(event) => { setDirDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') saveDir() }} />
          {state.pickerAvailable ? <button type="button" className="dr__btn" disabled={busy || !state.workspace.available} onClick={choose}>选择…</button> : null}
          {changed ? <button type="button" className="dr__btn dr__btn--primary" disabled={busy} onClick={saveDir}>保存</button> : null}
          {state.workspace.dir === undefined || changed ? null : <button type="button" className="dr__link dr__link--small" disabled={busy} onClick={() => { void run(clearWorkspaceDir, '已清除工作区目录').then((ok) => { if (ok) setDirDraft(undefined) }) }}>清除</button>}
        </div>
      </Row>
      <NumberRow field="proxyPort" {...form} />
      <Row label="代理状态" summary="端口改动保存后代理立即换到新端口，已有工作区一起改过去。">
        <div className="dr__inline">
          {listening === undefined ? <span className="dr__pill dr__pill--bad"><span className="dr__dot" />没有运行</span> : <span className={`dr__pill ${proxyOff ? 'dr__pill--warn' : 'dr__pill--ok'}`}><span className="dr__dot" />监听 127.0.0.1:{listening}{proxyOff ? `，设置的是 ${configuredPort}` : ''}</span>}
          {proxyOff ? <button type="button" className="dr__btn" disabled={busy} onClick={retryProxy}>重试</button> : null}
        </div>
      </Row>
      <Row label="提交姓名" summary="写进新工作区的 git 配置，和邮箱一起填；都留空时用主机令牌账号的名字和邮箱。" error={errors.commitName}>
        <ResetLink shown={current.commitName !== defaults.commitName} busy={busy} onReset={() => { edit({ commitName: defaults.commitName }) }} />
        <input className="dr__input" aria-label="提交姓名" placeholder="令牌账号的名字" value={current.commitName} disabled={busy} onChange={(event) => { edit({ commitName: event.target.value }) }} />
      </Row>
      <Row label="提交邮箱" error={errors.commitEmail}>
        <ResetLink shown={current.commitEmail !== defaults.commitEmail} busy={busy} onReset={() => { edit({ commitEmail: defaults.commitEmail }) }} />
        <input className="dr__input dr__mono" aria-label="提交邮箱" placeholder="令牌账号的邮箱" value={current.commitEmail} disabled={busy} onChange={(event) => { edit({ commitEmail: event.target.value }) }} />
      </Row>
    </Section>
  )
}
