/**
 * Workspaces: ordinary git clones with their own `.git`, created from the
 * repository's mirror (objects borrowed through `git clone --shared`, so a
 * clone costs only its checkout) in a directory the caller chooses, typically
 * inside an Agent's sandbox.
 *
 * - `origin` keeps the repository's real address; the workspace's own
 *   `.git/config` rewrites it (`url.<proxy>.insteadOf`) to dsh-repo's local
 *   git proxy and answers the proxy's password with the workspace's secret,
 *   so plain `git fetch` and `git push` work there without any token. Nothing
 *   is written to the user's or the system's git configuration.
 * - Each workspace has one remote branch, fixed at creation; a `commit-msg`
 *   hook adds `DSH-Session: <id>` (the running Session from
 *   `$DSH_SESSION_ID`, else the creating Session).
 * - The checkout is untrusted: its configuration, hooks, and attributes are
 *   the Agent's. Git commands dsh-repo runs inside a workspace after creating
 *   it run with hooks off and, when DSH provides a sandbox, confined to the
 *   workspace directory, and never carry a token.
 *
 * @module dsh-repo/workspace/manager
 */

import { randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { CommitAuthor, CommitTrailer, WorkspaceFileChange, WorkspaceInfo, WorkspaceStatus } from '../contract.ts'
import { RepoError } from '../errors.ts'
import type { HostLogger } from '../host.ts'
import { GitError } from '../mirror/git.ts'
import type { GitRunner } from '../mirror/git.ts'
import { gitFailure, serialize } from '../mirror/store.ts'
import { realPathOf, within } from '../paths.ts'
import type { RepoService } from '../service.ts'
import type { WorkspaceRecord, WorkspaceRegistry } from './registry.ts'

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[^\s~^:?*[\\\u0000-\u001f\u007f]+$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ZERO = /^0+$/

/** Options of git commands run inside a workspace. */
export interface WorkspaceGitOptions {
  readonly timeoutMs: number
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly maxOutputBytes?: number
}

/** Runs one git command inside a workspace directory, confined to it when a sandbox is available. */
export type WorkspaceGit = (dir: string, args: readonly string[], options: WorkspaceGitOptions) => Promise<string>

/** Collaborators of the manager. */
export interface WorkspaceManagerDeps {
  readonly service: RepoService
  readonly registry: WorkspaceRegistry
  /** Unconfined git for clones and configuration of directories dsh-repo just created. */
  readonly git: GitRunner
  /** Git inside existing workspaces. */
  readonly workspaceGit: WorkspaceGit
  /** Base URL the proxy serves a workspace at, e.g. `http://127.0.0.1:43123/w/<id>/repo.git`, and the proxy's credential scope; undefined while the proxy is not listening. */
  readonly proxy: () => { readonly port: number } | undefined
  readonly logger?: HostLogger
}

/** What a create resolved and checked. */
export interface CreateRequest {
  readonly repo: string
  readonly path: string
  readonly base?: string
  readonly commit?: string
  readonly branch?: string
  readonly session?: string
}

/** A commit the push records. */
export interface PushRequest {
  readonly message?: string
  readonly forceWithLease?: boolean
  readonly author?: CommitAuthor
  readonly committer?: CommitAuthor
  /** Recorded as `DSH-Session:`. */
  readonly session?: string
  readonly trailers?: readonly CommitTrailer[]
  readonly signal?: AbortSignal
}

/** Outcome of {@link WorkspaceManager.push}. */
export interface PushOutcome {
  readonly commit: string
  readonly committed: boolean
  readonly author?: CommitAuthor
  readonly created: boolean
}

/**
 * The proxy address a workspace's `origin` is rewritten to.
 * @param port - proxy port.
 * @param id - workspace id.
 * @returns the URL.
 */
export function proxyUrl(port: number, id: string): string {
  return `http://127.0.0.1:${port}/w/${id}/repo.git`
}

/**
 * The record as the contract shows it, without the secret.
 * @param record - stored workspace.
 * @returns the public fields.
 */
export function workspaceInfo(record: WorkspaceRecord): WorkspaceInfo {
  const { secret: _secret, ...info } = record
  return info
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const STATUS: Record<string, WorkspaceFileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type-changed', C: 'added' }

/**
 * Parse `git diff -z --name-status -M` and `--numstat` output.
 * @param names - name-status records.
 * @param numbers - numstat records.
 * @returns one entry per changed file.
 */
function parseChanges(names: string, numbers: string): WorkspaceFileChange[] {
  const counts = new Map<string, { binary: boolean; additions?: number; deletions?: number }>()
  const numberFields = numbers.split('\0')
  for (let index = 0; index < numberFields.length; index += 1) {
    const field = numberFields[index] ?? ''
    if (field === '') continue
    // Only the first two tabs separate fields; a path may contain tabs.
    const first = field.indexOf('\t')
    const second = field.indexOf('\t', first + 1)
    const added = field.slice(0, first)
    const deleted = field.slice(first + 1, second)
    const path = field.slice(second + 1)
    // A rename reports an empty path followed by the old and new paths.
    const target = path === '' ? numberFields[index + 2] ?? '' : path
    if (path === '') index += 2
    counts.set(target, added === '-' ? { binary: true } : { binary: false, additions: Number(added), deletions: Number(deleted) })
  }
  const files: WorkspaceFileChange[] = []
  const fields = names.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index] ?? ''
    if (code === '') continue
    const status = STATUS[code[0] ?? ''] ?? 'modified'
    if (code[0] === 'R' || code[0] === 'C') {
      const previousPath = fields[index + 1] ?? ''
      const path = fields[index + 2] ?? ''
      index += 2
      files.push({ path, status, ...code[0] === 'R' ? { previousPath } : {}, ...counts.get(path) ?? { binary: false } })
    } else {
      const path = fields[index + 1] ?? ''
      index += 1
      files.push({ path, status, ...counts.get(path) ?? { binary: false } })
    }
  }
  return files
}

/** Classify a failed `git push` by its output. */
function pushFailure(error: unknown, branch: string): RepoError {
  if (!(error instanceof GitError)) return gitFailure(error, `推送分支 ${branch} `)
  const output = error.output
  if (/dsh-repo:|remote rejected|protected branch|pre-receive hook declined|not allowed to push|permission|denied|\b403\b/i.test(output)) {
    return new RepoError('forbidden', `推送到 ${branch} 被拒绝：${output}`)
  }
  if (/stale info|fetch first|non-fast-forward|rejected/i.test(output)) {
    return new RepoError('conflict', `远端分支 ${branch} 已被他人更新，没有推送；先 git pull --rebase 合入远端改动，或确认后用 forceWithLease 覆盖：${output}`)
  }
  if (/authentication failed|could not read username|\b401\b/i.test(output)) {
    return new RepoError('unauthenticated', `推送 ${branch} 时身份验证失败：${output}`)
  }
  return new RepoError('unavailable', `推送分支 ${branch} 失败：${output}`)
}

/** The `commit-msg` hook every workspace gets. */
function commitMsgHook(session: string | undefined): string {
  const fallback = session === undefined ? '' : session.replace(/[^A-Za-z0-9._:-]/g, '')
  return [
    '#!/bin/sh',
    '# dsh-repo: record the DSH Session that made the commit.',
    `session="\${DSH_SESSION_ID:-${fallback}}"`,
    '[ -n "$session" ] || exit 0',
    'exec git interpret-trailers --in-place --if-exists doNothing --trailer "DSH-Session: $session" "$1"',
    '',
  ].join('\n')
}

/** Workspaces of catalog repositories. */
export class WorkspaceManager {
  /** Tail of each workspace's queue of status reads, pushes, and removals. */
  private readonly locks = new Map<string, Promise<void>>()
  /** Tail of each destination directory's queue of creations. */
  private readonly createLocks = new Map<string, Promise<void>>()

  /** @param deps - engine, registry, git runners, and the proxy. */
  constructor(private readonly deps: WorkspaceManagerDeps) {}

  /**
   * Clone a catalog repository into a new workspace.
   * @param request - repository, directory, start, branch, and creating Session.
   * @param signal - cancellation.
   * @returns the workspace.
   * @throws {RepoError} see `DshRepoService.workspaceCreate`.
   */
  async create(request: CreateRequest, signal?: AbortSignal): Promise<WorkspaceInfo> {
    if (!isAbsolute(request.path)) throw new RepoError('invalid', `工作区目录必须是绝对路径：${request.path}`)
    // One creation per directory at a time, so a failed one never cleans up a directory another call just filled.
    return await serialize(this.createLocks, await realPathOf(resolve(request.path)), async () => await this.createIn(request, signal))
  }

  private async createIn(request: CreateRequest, signal?: AbortSignal): Promise<WorkspaceInfo> {
    const { service } = this.deps
    const entry = service.catalog.require(request.repo, 'read')
    const url = entry.url
    const path = await this.checkPath(request.path)
    if (request.commit !== undefined && !COMMIT.test(request.commit)) throw new RepoError('invalid', `起点提交必须是完整的十六进制提交 id：${request.commit}`)
    if (request.base !== undefined && !BRANCH.test(request.base)) throw new RepoError('invalid', `合入分支名不合法：${request.base}`)
    const proxy = this.deps.proxy()
    if (proxy === undefined) throw new RepoError('unavailable', 'dsh-repo 的本机 git 代理没有运行，无法创建工作区；查看日志里代理启动失败的原因，或在设置页换一个代理端口')
    const mirror = await service.syncMirror(url, { ...request.base === undefined ? {} : { branch: request.base }, signal })
    const branch = request.branch ?? `dsh/${request.session === undefined ? randomBytes(4).toString('hex') : request.session.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || randomBytes(4).toString('hex')}`
    if (!BRANCH.test(branch) || branch.startsWith('/') || branch === '@') throw new RepoError('invalid', `分支名不合法：${branch}`)
    if (branch === mirror.defaultBranch) throw new RepoError('invalid', `不能在默认分支 ${branch} 上工作；用 base 指定合入目标，推送到别的分支`)
    if (branch === mirror.branch) throw new RepoError('invalid', `分支 ${branch} 是合入目标，不能同时作为工作区的推送分支`)
    if (service.gitHost(url)) {
      const remote = await service.getBranch(url, branch, signal === undefined ? {} : { signal })
      if (remote?.protected === true) throw new RepoError('forbidden', `${branch} 是受保护分支，工作区不能推送到它`)
    }
    const existing = await this.mirrorBranch(mirror.dir, branch, signal)
    if (existing !== undefined && request.commit !== undefined) throw new RepoError('invalid', `分支 ${branch} 已存在，工作区从它的最新提交开始，不能再指定 commit`)
    let start = existing ?? request.commit ?? mirror.commit
    if (existing === undefined && request.commit !== undefined) {
      await service.mirrors.existing(url, request.commit, signal)
      try {
        await this.git(['merge-base', '--is-ancestor', request.commit, `refs/heads/${mirror.branch}`], mirror.dir, signal)
      } catch (error) {
        if (!(error instanceof GitError)) throw gitFailure(error, '检查起点提交 ')
        throw new RepoError('invalid', `提交 ${request.commit.slice(0, 12)} 不在分支 ${mirror.branch} 上`)
      }
      start = request.commit
    }
    const id = randomBytes(8).toString('hex')
    const secret = randomBytes(24).toString('hex')
    const created = !await exists(path)
    try {
      await mkdir(path, { recursive: true })
      await this.git(['clone', '--quiet', '--shared', '--no-checkout', '--', mirror.dir, path], undefined, signal)
      const real = await realpath(path)
      await this.git(['remote', 'set-url', 'origin', url], real, signal)
      await this.git(['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '-B', branch, start], real, signal)
      await this.git(['config', `branch.${branch}.remote`, 'origin'], real, signal)
      await this.git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], real, signal)
      await this.writeProxyConfig(real, url, id, secret, proxy.port, undefined, signal)
      const identity = await this.identity(url, signal)
      if (identity !== undefined) {
        await this.git(['config', 'user.name', identity.name], real, signal)
        await this.git(['config', 'user.email', identity.email], real, signal)
      }
      const hook = join(real, '.git', 'hooks', 'commit-msg')
      await mkdir(join(real, '.git', 'hooks'), { recursive: true })
      await writeFile(hook, commitMsgHook(request.session))
      await chmod(hook, 0o755)
      const record: WorkspaceRecord = {
        id, path: real, repo: url, base: mirror.branch, baseCommit: start, branch, secret,
        ...request.session === undefined ? {} : { session: request.session },
        createdAt: new Date().toISOString(),
      }
      await this.deps.registry.add(record)
      return workspaceInfo(record)
    } catch (error) {
      await (created ? rm(path, { recursive: true, force: true }) : this.empty(path))
      throw gitFailure(error, `在 ${path} 创建 ${url} 的工作区`)
    }
  }

  /**
   * The workspaces whose directories still exist; records of deleted directories are forgotten.
   * @param repo - only workspaces of this catalog address.
   * @returns the records, oldest first.
   */
  async list(repo?: string): Promise<WorkspaceRecord[]> {
    const gone: string[] = []
    const kept: WorkspaceRecord[] = []
    for (const record of this.deps.registry.list()) {
      if (!await exists(join(record.path, '.git'))) gone.push(record.id)
      else if (repo === undefined || record.repo === repo) kept.push(record)
    }
    if (gone.length > 0) {
      try {
        await this.deps.registry.remove(gone)
      } catch (error) {
        // Only the cleanup failed; the next listing retries it.
        this.deps.logger?.warn?.('dsh-repo: %s', error instanceof Error ? error.message : String(error))
      }
    }
    return kept
  }

  /**
   * The workspace that is or contains a path.
   * @param path - absolute path.
   * @returns the record.
   * @throws {RepoError} `not-found` when the path is not inside a workspace dsh-repo created.
   */
  async locate(path: string): Promise<WorkspaceRecord> {
    let real: string
    try {
      real = await realpath(resolve(path))
    } catch {
      // A missing directory is not inside a workspace.
      throw new RepoError('not-found', `${path} 不存在`)
    }
    const record = this.deps.registry.containing(real)
    if (record === undefined || !await exists(join(record.path, '.git'))) throw new RepoError('not-found', `${path} 不在 dsh-repo 创建的工作区内；用 repo_workspace_create 创建工作区`)
    return record
  }

  /**
   * Describe a workspace's changes since its start commit without touching its index.
   * @param record - located workspace.
   * @param signal - cancellation.
   * @param maxDiffBytes - cut of the diff.
   * @param timeoutMs - timeout of one git command.
   * @returns the changes.
   */
  async status(record: WorkspaceRecord, signal: AbortSignal | undefined, maxDiffBytes: number, timeoutMs: number): Promise<WorkspaceStatus> {
    return await serialize(this.locks, record.id, async () => {
      try {
        return await this.describe(record, signal, maxDiffBytes, timeoutMs)
      } catch (error) {
        throw gitFailure(error, `读取工作区 ${record.path} 的改动`)
      }
    })
  }

  /**
   * Commit uncommitted changes and push `HEAD` to the workspace's branch through the proxy.
   * @param record - located workspace.
   * @param request - message, force, identities, and trailers.
   * @param timeoutMs - timeout of one git command.
   * @returns the push outcome.
   * @throws {RepoError} see `DshRepoService.workspacePush`.
   */
  async push(record: WorkspaceRecord, request: PushRequest, timeoutMs: number): Promise<PushOutcome> {
    return await serialize(this.locks, record.id, async () => {
      const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}) => this.inside(record, args, timeoutMs, request.signal, env)
      // A fresh fetch: a stale mirror could claim the remote branch already holds HEAD after someone deleted or rewound it.
      const mirror = await this.deps.service.syncMirror(record.repo, request.signal === undefined ? {} : { signal: request.signal })
      const remoteBefore = await this.mirrorBranch(mirror.dir, record.branch, request.signal)
      let committed = false
      const author = request.author ?? request.committer
      try {
        const pending = (await run(['status', '--porcelain', '-z'])) !== ''
        if (pending) {
          if (request.message === undefined || request.message.trim() === '') throw new RepoError('invalid', '工作区有未提交的改动，推送时要给出提交说明（message）')
          await run(['add', '--all'])
          const identity = request.committer === undefined ? [] : ['-c', `user.name=${request.committer.name}`, '-c', `user.email=${request.committer.email}`]
          const authorEnv: Record<string, string> = author === undefined ? {} : { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email }
          const trailers = [
            ...request.session === undefined ? [] : [`DSH-Session: ${request.session}`],
            ...(request.trailers ?? []).map(trailer => `${trailer.token}: ${trailer.value}`),
          ].flatMap(line => ['--trailer', line])
          await run([...identity, 'commit', '--quiet', '--no-verify', '-m', request.message, ...trailers], authorEnv)
          committed = true
        }
        const head = (await run(['rev-parse', 'HEAD'])).trim()
        if (remoteBefore === head) return { commit: head, committed, created: false }
        if (remoteBefore === undefined && head === record.baseCommit) throw new RepoError('invalid', '工作区相对起点提交没有改动，没有可推送的内容')
        try {
          await run(['push', '--quiet', ...request.forceWithLease === true ? ['--force-with-lease'] : [], 'origin', `HEAD:refs/heads/${record.branch}`])
        } catch (error) {
          throw pushFailure(error, record.branch)
        }
        return { commit: head, committed, ...committed && author !== undefined ? { author } : {}, created: remoteBefore === undefined }
      } catch (error) {
        // Undo this call's commit so a retry records the changes with its own message.
        if (committed) {
          try {
            await run(['reset', '--quiet', '--soft', 'HEAD^'])
          } catch (undo) {
            this.deps.logger?.warn?.('dsh-repo: 推送失败后撤销提交失败：%s', undo instanceof Error ? undo.message : String(undo))
          }
        }
        throw gitFailure(error, `推送工作区 ${record.path} `)
      }
    })
  }

  /**
   * Delete a workspace's directory and record.
   * @param record - located workspace.
   * @param force - delete despite uncommitted changes or unpushed commits.
   * @param signal - cancellation.
   * @param timeoutMs - timeout of one git command.
   * @returns what was discarded.
   * @throws {RepoError} `conflict` when there is unsaved work and `force` is not set.
   */
  async remove(record: WorkspaceRecord, force: boolean, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ discardedCommits: number; discardedChanges: boolean }> {
    return await serialize(this.locks, record.id, async () => {
      let discardedChanges = false
      let discardedCommits = 0
      try {
        discardedChanges = (await this.inside(record, ['status', '--porcelain', '-z'], timeoutMs, signal)) !== ''
        discardedCommits = await this.unpushed(record, signal, timeoutMs)
      } catch (error) {
        // A workspace git cannot read any more holds nothing that can be saved.
        if (!force) throw gitFailure(error, `检查工作区 ${record.path} `)
      }
      if (!force && (discardedChanges || discardedCommits > 0)) {
        throw new RepoError('conflict', `工作区 ${record.path} 还有${discardedChanges ? '未提交的改动' : ''}${discardedChanges && discardedCommits > 0 ? '和' : ''}${discardedCommits > 0 ? ` ${discardedCommits} 个未推送的提交` : ''}，没有删除；确认不要了再用 force 删除`)
      }
      await rm(record.path, { recursive: true, force: true })
      await this.deps.registry.remove([record.id])
      return { discardedCommits, discardedChanges }
    })
  }

  /**
   * Point every workspace at a new proxy port.
   * @param port - the port the proxy listens on now.
   * @param previous - the port the workspaces were configured for.
   */
  async moveProxy(port: number, previous: number): Promise<void> {
    for (const record of await this.list()) {
      try {
        await this.writeProxyConfig(record.path, record.repo, record.id, record.secret, port, previous)
      } catch (error) {
        this.deps.logger?.error?.('dsh-repo: 无法把工作区 %s 指向新的代理端口 %d：%s', record.path, port, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private async describe(record: WorkspaceRecord, signal: AbortSignal | undefined, maxDiffBytes: number, timeoutMs: number): Promise<WorkspaceStatus> {
    const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}, maxOutputBytes?: number) => this.inside(record, args, timeoutMs, signal, env, maxOutputBytes)
    const head = (await run(['rev-parse', 'HEAD'])).trim()
    let currentBranch: string | undefined
    try {
      currentBranch = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    } catch (error) {
      // `symbolic-ref --quiet` exits 1 on a detached head.
      if (!(error instanceof GitError)) throw error
    }
    // A private copy of the index: staging untracked files there shows them without touching the Agent's index.
    const gitDir = join(record.path, '.git')
    const index = join(gitDir, `dsh-repo-status-${randomBytes(4).toString('hex')}.index`)
    try {
      if (await exists(join(gitDir, 'index'))) await copyFile(join(gitDir, 'index'), index)
      const env = { GIT_INDEX_FILE: index }
      await run(['add', '--all'], env)
      const [names, numbers, patch, log, pending] = await Promise.all([
        run(['diff', '--cached', '-z', '--name-status', '-M', record.baseCommit], env),
        run(['diff', '--cached', '-z', '--numstat', '-M', record.baseCommit], env),
        run(['diff', '--cached', '-M', record.baseCommit], env, maxDiffBytes + 1),
        run(['log', '--reverse', '--format=%H%x1f%s', `${record.baseCommit}..HEAD`]),
        run(['diff', '--cached', '--name-only', '-z', 'HEAD'], env),
      ])
      const bytes = Buffer.from(patch, 'utf8')
      const truncated = bytes.length > maxDiffBytes
      return {
        workspace: workspaceInfo(record),
        head,
        ...currentBranch === undefined ? {} : { currentBranch },
        commits: log.split('\n').filter(line => line !== '').map((line) => {
          const [sha = '', subject = ''] = line.split('\x1f')
          return { sha, subject }
        }),
        unpushed: await this.unpushed(record, signal, timeoutMs),
        uncommitted: pending !== '',
        files: parseChanges(names, numbers),
        diff: truncated ? bytes.subarray(0, maxDiffBytes).toString('utf8') : patch,
        truncated,
      }
    } finally {
      await rm(index, { force: true })
    }
  }

  /** Commits on `HEAD` the remote branch did not have when the workspace last fetched or pushed. */
  private async unpushed(record: WorkspaceRecord, signal: AbortSignal | undefined, timeoutMs: number): Promise<number> {
    const tracking = `refs/remotes/origin/${record.branch}`
    let known = true
    try {
      await this.inside(record, ['rev-parse', '--verify', '--quiet', tracking], timeoutMs, signal)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      known = false
    }
    return Number((await this.inside(record, ['rev-list', '--count', `${known ? tracking : record.baseCommit}..HEAD`], timeoutMs, signal)).trim())
  }

  private inside(record: WorkspaceRecord, args: readonly string[], timeoutMs: number, signal: AbortSignal | undefined, env: Readonly<Record<string, string>> = {}, maxOutputBytes?: number): Promise<string> {
    return this.deps.workspaceGit(record.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      timeoutMs,
      env,
      ...signal === undefined ? {} : { signal },
      ...maxOutputBytes === undefined ? {} : { maxOutputBytes },
    })
  }

  private git(args: readonly string[], cwd: string | undefined, signal?: AbortSignal): Promise<string> {
    return this.deps.git(args, { ...cwd === undefined ? {} : { cwd }, timeoutMs: this.deps.service.settings.mirror.gitTimeoutMs, env: {}, ...signal === undefined ? {} : { signal } })
  }

  /** The head of a branch in a mirror, or undefined when the mirror has no such branch. */
  private async mirrorBranch(mirrorDir: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
    const target = `refs/heads/${branch}`
    // for-each-ref also matches branches below `branch/`, so the refname has to match exactly.
    const listed = await this.git(['for-each-ref', '--format=%(refname) %(objectname)', target], mirrorDir, signal)
    const commit = listed.split('\n').find(line => line.startsWith(`${target} `))?.slice(target.length + 1).trim()
    return commit === undefined || commit === '' || ZERO.test(commit) ? undefined : commit
  }

  /** Commit identity of new workspaces: the configured one, else the token account's; undefined for a local repository without configuration. */
  private async identity(url: string, signal?: AbortSignal): Promise<CommitAuthor | undefined> {
    const { commitName, commitEmail } = this.deps.service.settings.workspace
    const account = commitName !== '' && commitEmail !== '' ? undefined : await this.accountIdentity(url, signal)
    const name = commitName !== '' ? commitName : account?.name
    const email = commitEmail !== '' ? commitEmail : account?.email
    return name === undefined || email === undefined ? undefined : { name, email }
  }

  private async accountIdentity(url: string, signal?: AbortSignal): Promise<CommitAuthor | undefined> {
    try {
      return await this.deps.service.tokenIdentity(url, signal)
    } catch (error) {
      // Without the account's identity the Agent's git uses the machine's; pushes still go through the proxy.
      this.deps.logger?.warn?.('dsh-repo: 读取令牌账号的提交身份失败，新工作区不设置提交身份：%s', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** Rewrite `origin` to the proxy and answer its password, replacing the entries of a previous port. */
  private async writeProxyConfig(dir: string, url: string, id: string, secret: string, port: number, previous: number | undefined, signal?: AbortSignal): Promise<void> {
    if (previous !== undefined) {
      for (const section of [`url.${proxyUrl(previous, id)}`, `credential.http://127.0.0.1:${previous}`, `http.http://127.0.0.1:${previous}/`]) {
        try {
          await this.git(['config', '--remove-section', section], dir, signal)
        } catch (error) {
          // `--remove-section` exits non-zero for a section that is already gone.
          if (!(error instanceof GitError)) throw error
        }
      }
    }
    const scope = `credential.http://127.0.0.1:${port}`
    await this.git(['config', `url.${proxyUrl(port, id)}.insteadOf`, url], dir, signal)
    await this.git(['config', '--replace-all', `${scope}.helper`, ''], dir, signal)
    await this.git(['config', '--add', `${scope}.helper`, `!f() { test "$1" = get || exit 0; echo username=dsh; echo password=${secret}; }; f`], dir, signal)
    // An `http_proxy` without 127.0.0.1 in `no_proxy` would send the proxy's traffic elsewhere.
    await this.git(['config', `http.http://127.0.0.1:${port}/.proxy`, ''], dir, signal)
  }

  /**
   * A directory a new workspace may use, made canonical.
   * @throws {RepoError} `invalid` for a relative, non-empty, nested, or mirror path.
   */
  private async checkPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new RepoError('invalid', `工作区目录必须是绝对路径：${path}`)
    const target = resolve(path)
    if (await exists(target)) {
      let names: string[]
      try {
        names = await readdir(target)
      } catch {
        // A file, or a directory that cannot be read, cannot hold a workspace.
        throw new RepoError('invalid', `工作区目录 ${target} 已存在且不是可用的空目录`)
      }
      if (names.length > 0) throw new RepoError('invalid', `工作区目录 ${target} 已存在且不是空目录`)
    }
    const real = await realPathOf(target)
    const outer = this.deps.registry.containing(real)
    if (outer !== undefined) throw new RepoError('invalid', `工作区目录 ${target} 在另一个工作区 ${outer.path} 里面`)
    const inner = this.deps.registry.list().find(record => within(real, record.path))
    if (inner !== undefined) throw new RepoError('invalid', `工作区目录 ${target} 里面已经有工作区 ${inner.path}`)
    if (await this.deps.service.mirrors.owns(real)) throw new RepoError('invalid', `工作区目录 ${target} 在镜像目录里面`)
    return target
  }

  private async empty(path: string): Promise<void> {
    try {
      for (const name of await readdir(path)) await rm(join(path, name), { recursive: true, force: true })
    } catch (error) {
      this.deps.logger?.warn?.('dsh-repo: 清理创建失败的工作区 %s 失败：%s', path, error instanceof Error ? error.message : String(error))
    }
  }
}
