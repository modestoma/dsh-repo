/**
 * 左侧栏「代码仓库」整页设置，分六个标签页：主机（主机与令牌）、访问范围、
 * 模型工具、MR 跟踪（各类动态的处理方式、检查频率、正在跟踪的 PR/MR）、
 * 本地同步（把仓库分支定时展开到本地目录）、高级（超时、上限、镜像目录、
 * 镜像占用）。主机、令牌、镜像目录、停止跟踪和本地同步的改动立即保存；其余运行时设置有改动时出现底部保存条，保存后对之后的调用立即生效。
 * 令牌值存入 DSH 凭据库，页面只显示是否已设置。
 *
 * @module dsh-repo/client/page
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ForgeKind, HostInfo, TokenStatus } from '../contract.ts'
import { DEFAULT_SYNC_INTERVAL_MINUTES } from '../settings/contract.ts'
import type { HostAddRequest, MirrorUsage, SettingsState, SyncInfo, SyncInput, WatchInfo } from '../settings/contract.ts'
import { addHost, addSync, clearHostToken, fetchMirrorUsage, fetchState, messageOf, pickDirectory, removeHost, removeSync, resetMirrorDir, resetSettings, runSync, saveHostToken, saveMirrorDir, saveSettings, stopWatch, updateSync } from './api.ts'
import { formatBytes, formatInterval, fromDraft, intervalHoursText, NUMBER_FIELDS, parseIntervalHours, sameDraft, toDraft, WATCH_ACTIONS, WATCH_EVENTS, WRITE_MODES } from './form.ts'
import type { DraftField, NumberKey, SettingsDraft } from './form.ts'

/** Page title, shared with the sidebar row. */
export const PAGE_TITLE = '代码仓库'

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

type TabId = 'hosts' | 'access' | 'tools' | 'watch' | 'sync' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'hosts', label: '主机' },
  { id: 'access', label: '访问范围' },
  { id: 'tools', label: '模型工具' },
  { id: 'watch', label: 'MR 跟踪' },
  { id: 'sync', label: '本地同步' },
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
              <div className="dr__rowSummary">主机与令牌、访问范围、模型工具、MR 跟踪、本地同步、超时与上限、本地镜像都在那里配置。</div>
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

  const reload = useCallback(async () => {
    try {
      setState(await fetchState())
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const syncing = tab === 'sync' && !busy && state?.syncs.some(sync => sync.state !== 'idle') === true
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
    if (!window.confirm('把访问范围、模型工具、MR 跟踪、超时和上限全部恢复默认？主机、令牌、镜像目录和正在跟踪的 PR/MR 不受影响。')) return
    void run(resetSettings, '已全部恢复默认').then((ok) => { if (ok) discard() })
  }
  const form = { current, defaults, errors, busy, edit }

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
      {tab === 'access' ? <AccessTab {...form} /> : null}
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
      {tab === 'sync' ? <SyncTab state={state} busy={busy} run={run} onError={(text) => { setNotice({ kind: 'error', text }) }} /> : null}
      {tab === 'advanced'
        ? (
            <>
              <AdvancedTab {...form} />
              <MirrorSection state={state} busy={busy} run={run} onError={(text) => { setNotice({ kind: 'error', text }) }} />
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

function AccessTab({ current, defaults, errors, busy, edit }: FormProps): JSX.Element {
  return (
    <Section>
      <Row label="可访问的仓库" summary="每行一个，* 匹配一层，** 匹配任意多层；留空表示令牌能访问的全部仓库。" error={errors.repos} block>
        <textarea className="dr__input dr__textarea dr__mono" aria-label="可访问的仓库" spellCheck={false} rows={Math.min(8, Math.max(3, current.repos.split('\n').length + 1))} placeholder={'github.com/modestoma/*\ncode.example.com/team/**'} value={current.repos} disabled={busy} onChange={(event) => { edit({ repos: event.target.value }) }} />
      </Row>
      <Row label="镜像其他主机上的仓库" summary="不在主机列表里的公开仓库，不带凭据拉取。">
        <ResetLink shown={current.otherHosts !== defaults.otherHosts} busy={busy} onReset={() => { edit({ otherHosts: defaults.otherHosts }) }} />
        <Switch label="镜像其他主机上的仓库" checked={current.otherHosts} disabled={busy} onChange={(value) => { edit({ otherHosts: value }) }} />
      </Row>
    </Section>
  )
}

function ToolsTab({ current, defaults, errors, busy, edit }: FormProps): JSX.Element {
  const off = !current.enabled
  return (
    <Section>
      <Row label="提供代码仓库工具" summary="关闭后模型看不到 repo_* 工具，其他插件不受影响。">
        <Switch label="提供代码仓库工具" checked={current.enabled} disabled={busy} onChange={(value) => { edit({ enabled: value }) }} />
      </Row>
      <Row label="写操作" summary="创建、修改、评论 issue 与 PR/MR，推送工作区。">
        <ResetLink shown={current.writes !== defaults.writes} busy={busy} onReset={() => { edit({ writes: defaults.writes }) }} />
        <Segmented label="写操作" value={current.writes} options={WRITE_MODES} disabled={busy || off} onChange={(value) => { edit({ writes: value }) }} />
      </Row>
      <Row label="合并 PR/MR" summary="审批方式同写操作。">
        <Switch label="合并 PR/MR" checked={current.merge} disabled={busy || off || current.writes === 'off'} onChange={(value) => { edit({ merge: value }) }} />
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
  const mirrorValue = mirrorDraft ?? state.mirror.dir
  const isDefault = state.mirror.dir === state.mirror.defaultDir
  const saveMirror = (): void => {
    const dir = mirrorValue.trim()
    if (dir === '' || dir === state.mirror.dir || busy) return
    void run(() => saveMirrorDir(dir), `镜像目录已改为 ${dir}`).then((ok) => { if (ok) setMirrorDraft(undefined) })
  }
  const choose = (): void => {
    void pickDirectory().then((path) => { if (path !== null) setMirrorDraft(path) }, (error: unknown) => { onError(messageOf(error)) })
  }
  const changed = mirrorValue.trim() !== '' && mirrorValue.trim() !== state.mirror.dir
  return (
    <Section title="本地镜像">
      <Row label="镜像目录" summary="仓库的只读本地副本。改目录立即保存，旧镜像不搬也不删。" block>
        <div className="dr__inline">
          <input className="dr__input dr__mono" spellCheck={false} aria-label="镜像目录" placeholder={state.mirror.defaultDir} value={mirrorValue} onChange={(event) => { setMirrorDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') saveMirror() }} />
          {state.pickerAvailable ? <button type="button" className="dr__btn" disabled={busy} onClick={choose}>选择…</button> : null}
          {changed ? <button type="button" className="dr__btn dr__btn--primary" disabled={busy} onClick={saveMirror}>保存</button> : null}
          {isDefault || changed ? null : <button type="button" className="dr__link dr__link--small" disabled={busy} onClick={() => { void run(resetMirrorDir, '已恢复默认镜像目录').then((ok) => { if (ok) setMirrorDraft(undefined) }) }}>恢复默认</button>}
        </div>
      </Row>
    </Section>
  )
}

/** Notice after a change that synced: the sync's failure, or `success`. */
function syncNotice(id: string | undefined, success: string): (state: SettingsState) => Notice {
  return (state) => {
    const sync = id === undefined ? state.syncs.at(-1) : state.syncs.find(item => item.id === id)
    return sync?.error === undefined ? { kind: 'ok', text: success } : { kind: 'error', text: `同步失败：${sync.error}` }
  }
}

function SyncTab({ state, busy, run, onError }: { state: SettingsState; busy: boolean; run: Run; onError: (text: string) => void }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | undefined>()
  const now = Date.now()
  return (
    <>
      <Section>
        {state.syncs.length === 0 && !adding ? <div className="dr__emptyRow">还没有本地同步。添加后，仓库分支的最新提交会定时展开到你指定的本地目录。</div> : null}
        {state.syncs.map(sync => sync.id === editing
          ? <SyncForm key={sync.id} sync={sync} picker={state.pickerAvailable} busy={busy} onError={onError} onCancel={() => { setEditing(undefined) }} onSubmit={(input) => { void run(() => updateSync(sync.id, input), syncNotice(sync.id, '已保存')).then((ok) => { if (ok) setEditing(undefined) }) }} />
          : <SyncRow key={sync.id} sync={sync} now={now} busy={busy} run={run} onEdit={() => { setEditing(sync.id) }} />)}
        {adding
          ? <SyncForm picker={state.pickerAvailable} busy={busy} onError={onError} onCancel={() => { setAdding(false) }} onSubmit={(input) => { void run(() => addSync(input), syncNotice(undefined, '已添加并完成第一次同步')).then((ok) => { if (ok) setAdding(false) }) }} />
          : <div className="dr__addRow"><button type="button" className="dr__link" disabled={busy} onClick={() => { setAdding(true) }}>＋ 添加本地同步</button></div>}
      </Section>
      <p className="dr__secFoot">本地目录里是分支最新提交展开后的普通文件，没有 .git，git 对象只在镜像目录里存一份。每次同步只写入有变化的文件，删除分支上已删除的文件，本地改过或删掉的文件会恢复成仓库里的版本；目录里另外放的文件保留。第一次同步要求目录不存在或为空。删除本地同步不会删除目录里的文件。</p>
    </>
  )
}

function syncPill(sync: SyncInfo): JSX.Element {
  if (sync.state === 'running') return <span className="dr__pill dr__pill--ok"><span className="dr__dot" />同步中</span>
  if (sync.state === 'queued') return <span className="dr__pill"><span className="dr__dot" />排队中</span>
  if (sync.error !== undefined) return <span className="dr__pill dr__pill--bad"><span className="dr__dot" />同步失败</span>
  if (sync.commit === undefined) return <span className="dr__pill dr__pill--warn"><span className="dr__dot" />还没同步</span>
  return <span className="dr__pill dr__pill--ok"><span className="dr__dot" />已同步</span>
}

function SyncRow({ sync, now, busy, run, onEdit }: { sync: SyncInfo; now: number; busy: boolean; run: Run; onEdit: () => void }): JSX.Element {
  const parts = [`每 ${formatInterval(sync.intervalMinutes)}`]
  if (sync.syncedAt !== undefined) parts.push(`上次 ${ago(sync.syncedAt, now)}${sync.commit === undefined ? '' : `（${sync.syncedBranch ?? ''} ${sync.commit.slice(0, 8)}）`}`)
  if (sync.nextAt !== undefined) parts.push(`下次 ${until(sync.nextAt, now)}`)
  const working = sync.state !== 'idle'
  return (
    <div className="dr__row dr__row--top">
      <div className="dr__rowText">
        <div className="dr__rowLabel">
          <span className="dr__strong dr__mono">{sync.url}</span>
          <span className="dr__tag">{sync.branch ?? '默认分支'}</span>
          {syncPill(sync)}
        </div>
        <div className="dr__rowSummary"><span className="dr__mono">→ {sync.dir}</span></div>
        <div className="dr__rowSummary">{parts.join(' · ')}</div>
        {sync.error === undefined ? null : <div className="dr__rowError">{sync.error}</div>}
      </div>
      <div className="dr__rowCtl">
        <button type="button" className="dr__btn" disabled={busy || working} onClick={() => { void run(() => runSync(sync.id), syncNotice(sync.id, `已同步 ${sync.url}`)) }}>立即同步</button>
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={onEdit}>编辑</button>
        <button type="button" className="dr__btn dr__btn--ghost dr__btn--danger" disabled={busy} onClick={() => { if (window.confirm(`删除 ${sync.url} 的本地同步？目录 ${sync.dir} 里的文件会保留。`)) void run(() => removeSync(sync.id), '已删除本地同步，目录里的文件保留') }}>删除</button>
      </div>
    </div>
  )
}

function SyncForm({ sync, picker, busy, onError, onCancel, onSubmit }: { sync?: SyncInfo; picker: boolean; busy: boolean; onError: (text: string) => void; onCancel: () => void; onSubmit: (input: SyncInput) => void }): JSX.Element {
  const [url, setUrl] = useState(sync?.url ?? '')
  const [branch, setBranch] = useState(sync?.branch ?? '')
  const [dir, setDir] = useState(sync?.dir ?? '')
  const [hours, setHours] = useState(intervalHoursText(sync?.intervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES))
  const [error, setError] = useState<string | undefined>()
  const complete = url.trim() !== '' && dir.trim() !== ''
  const submit = (): void => {
    if (!complete || busy) return
    const interval = parseIntervalHours(hours)
    if (!interval.ok) {
      setError(interval.message)
      return
    }
    setError(undefined)
    onSubmit({ url: url.trim(), branch: branch.trim(), dir: dir.trim(), intervalMinutes: interval.minutes })
  }
  const choose = (): void => {
    void pickDirectory().then((path) => { if (path !== null) setDir(path) }, (failure: unknown) => { onError(messageOf(failure)) })
  }
  const submitOnEnter = (event: { key: string }): void => { if (event.key === 'Enter') submit() }
  return (
    <div className="dr__addForm">
      <div className="dr__formGrid">
        <label className="dr__field dr__field--full">仓库地址<input className="dr__input dr__mono" spellCheck={false} placeholder="https://gitlab.example.com/team/shared-skills.git" value={url} onChange={(event) => { setUrl(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">分支（可选）<input className="dr__input dr__mono" spellCheck={false} placeholder="默认分支" value={branch} onChange={(event) => { setBranch(event.target.value) }} onKeyDown={submitOnEnter} /></label>
        <label className="dr__field">同步间隔（小时）<input className="dr__input dr__mono" inputMode="decimal" aria-invalid={error === undefined ? undefined : true} value={hours} onChange={(event) => { setHours(event.target.value); setError(undefined) }} onKeyDown={submitOnEnter} /></label>
        <div className="dr__field dr__field--full">本地目录
          <div className="dr__inline dr__inline--flush">
            <input className="dr__input dr__mono" spellCheck={false} aria-label="本地目录" placeholder="/绝对路径/目录，不存在会自动创建" value={dir} onChange={(event) => { setDir(event.target.value) }} onKeyDown={submitOnEnter} />
            {picker ? <button type="button" className="dr__btn" disabled={busy} onClick={choose}>选择…</button> : null}
          </div>
        </div>
      </div>
      {error === undefined ? null : <div className="dr__rowError">{error}</div>}
      <div className="dr__formActions">
        <button type="button" className="dr__btn dr__btn--ghost" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="dr__btn dr__btn--primary" disabled={busy || !complete} onClick={submit}>{busy ? '同步中…' : sync === undefined ? '添加并同步' : '保存'}</button>
      </div>
    </div>
  )
}

function MirrorUsageSection({ mirrorDir }: { mirrorDir: string }): JSX.Element {
  const [usage, setUsage] = useState<MirrorUsage | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setUsage(await fetchMirrorUsage())
      setError(undefined)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load, mirrorDir])
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
