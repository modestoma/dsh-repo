/**
 * Writable workspaces: `git worktree` checkouts of a mirror commit placed in
 * a caller-chosen directory, typically inside an agent's sandbox.
 *
 * - The worktree's git metadata (index, HEAD, local branch, commits) lives
 *   in the mirror, outside the checkout. Whoever can write the checkout can
 *   change files only; commits and pushes run here, in the plugin process.
 * - The checkout is untrusted: every git command names the metadata
 *   directory explicitly after checking that the checkout's `.git` link and
 *   the metadata's back link agree and that the metadata belongs to a mirror
 *   of this store, so a forged `.git` cannot point git at a repository whose
 *   configuration the agent controls.
 * - Each workspace has a local branch `dsh-repo/ws-<id>` in the mirror; its
 *   base branch, base commit, and remote branch are kept in the mirror's
 *   configuration under `dsh-repo-workspace.<id>`.
 * - Pushes never overwrite: the first push may only create the remote branch
 *   (`--force-with-lease=<ref>:` with an empty expectation), later pushes are
 *   plain fast-forward pushes.
 *
 * @module dsh-repo/mirror/workspace
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { CommitAuthor, CommitTrailer, WorkspaceChanges, WorkspaceFileChange, WorkspaceInfo, WorkspacePushResult } from '../contract.ts'
import { RepoError } from '../errors.ts'
import { GitError } from './git.ts'
import type { GitRunner } from './git.ts'
import type { MirrorStore } from './store.ts'

const SECTION = 'dsh-repo-workspace'
const BRANCH_PREFIX = 'dsh-repo/ws-'
const ID = /^[0-9a-f]{16}$/

/** Collaborators and limits of the workspace store. */
export interface WorkspaceStoreDeps {
  readonly git: GitRunner
  readonly mirrors: MirrorStore
  /** Git command timeout and diff cut, read on every use so saved settings apply to the next command. */
  readonly limits: () => WorkspaceLimits
}

/** Limits of one workspace operation. */
export interface WorkspaceLimits {
  /** Timeout of one git command. */
  readonly timeoutMs: number
  /** Cut of {@link WorkspaceChanges.diff}. */
  readonly maxDiffBytes: number
}

/** A located workspace: checked links plus its recorded state. */
interface Located {
  readonly id: string
  /** Canonical checkout directory. */
  readonly dir: string
  /** Canonical worktree metadata directory inside the mirror. */
  readonly gitDir: string
  /** Mirror directory. */
  readonly mirror: string
  readonly url: string
  readonly baseBranch: string
  readonly baseCommit: string
  readonly branch?: string
}

/** Push options after the service checked them. */
export interface PushRequest {
  readonly branch?: string
  readonly message?: string
  readonly author?: CommitAuthor
  /** Session recorded as the commit's `DSH-Session:` trailer. */
  readonly session?: string
  /** Validated trailers recorded after `DSH-Session:`. */
  readonly trailers?: readonly CommitTrailer[]
  /** Credentials of the network commands. */
  readonly env: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

function failure(error: unknown, what: string): RepoError {
  if (error instanceof RepoError) return error
  const detail = error instanceof GitError ? error.output : error instanceof Error ? error.message : String(error)
  return new RepoError('unavailable', `${what}失败：${detail === '' ? '无输出' : detail}`)
}

function notWorkspace(dir: string, why: string): RepoError {
  return new RepoError('not-found', `${dir} 不是 dsh-repo 打开的工作区：${why}`)
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

/** Classify a rejected `git push` by its output. */
function pushFailure(error: unknown, branch: string): RepoError {
  if (!(error instanceof GitError)) return failure(error, `推送分支 ${branch} `)
  const output = error.output
  if (/stale info|fetch first|non-fast-forward|already exists/i.test(output)) {
    return new RepoError('conflict', `远端分支 ${branch} 已存在或已被他人更新，没有推送：${output}`)
  }
  if (/protected branch|pre-receive hook declined|not allowed to push|permission|denied|\b403\b/i.test(output)) {
    return new RepoError('forbidden', `主机拒绝推送到 ${branch}：${output}`)
  }
  if (/authentication failed|could not read username|\b401\b|invalid credentials/i.test(output)) {
    return new RepoError('unauthenticated', `推送 ${branch} 时令牌被拒绝：${output}`)
  }
  return new RepoError('unavailable', `推送分支 ${branch} 失败：${output}`)
}

/**
 * Delete the local workspace branches and records of a mirror whose
 * checkouts are gone. Run after `git worktree prune` under the worktree lock.
 * @param git - runs one git command in the mirror.
 */
export async function forgetAbandonedWorkspaces(git: (args: readonly string[]) => Promise<string>): Promise<void> {
  const listed = await git(['worktree', 'list', '--porcelain'])
  const marker = `branch refs/heads/${BRANCH_PREFIX}`
  const active = new Set(listed.split('\n').filter(line => line.startsWith(marker)).map(line => line.slice(marker.length)))
  const branches = await git(['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/dsh-repo/'])
  for (const name of branches.split('\n')) {
    const id = name.startsWith(BRANCH_PREFIX) ? name.slice(BRANCH_PREFIX.length) : ''
    if (!ID.test(id) || active.has(id)) continue
    await git(['branch', '--quiet', '-D', name])
    try {
      await git(['config', '--remove-section', `${SECTION}.${id}`])
    } catch (error) {
      // A workspace whose open failed before its records were written has no section.
      if (!(error instanceof GitError)) throw error
    }
  }
}

/** Writable worktree checkouts of mirror commits. */
export class WorkspaceStore {
  /** Tail of each workspace's queue of change reads and pushes. */
  private readonly locks = new Map<string, Promise<void>>()

  /** @param deps - git runner, mirrors, timeout, and diff limit. */
  /** Whether `git lfs` is installed; asked once per store. */
  private lfs: Promise<boolean> | undefined

  constructor(private readonly deps: WorkspaceStoreDeps) {}

  /** Whether Git LFS is installed and some LFS file differs between the workspace's base commit and HEAD. */
  private async changesLfsFiles(ws: Located, signal?: AbortSignal): Promise<boolean> {
    // A missing `git lfs` command is the only expected failure of `git lfs version`.
    this.lfs ??= this.deps.git(['lfs', 'version'], { timeoutMs: this.deps.limits().timeoutMs }).then(() => true, () => false)
    if (!await this.lfs) return false
    return (await this.workspaceGit(ws, ['lfs', 'ls-files', '--name-only', ws.baseCommit, 'HEAD'], {}, signal)).trim() !== ''
  }

  /**
   * Check out a commit of a synced mirror at a new directory on a fresh local branch.
   * @param url - mirror address.
   * @param dir - absolute directory that must not exist.
   * @param commit - full commit id present in the mirror.
   * @param baseBranch - branch the work starts from.
   * @param env - credentials of the checkout, whose Git LFS smudge filter may download files.
   * @param signal - cancellation.
   * @returns the workspace.
   * @throws {RepoError} `invalid` for a relative or existing directory, `not-found` for a missing mirror or commit, `unavailable` when git fails.
   */
  async open(url: string, dir: string, commit: string, baseBranch: string, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<WorkspaceInfo> {
    if (!isAbsolute(dir)) throw new RepoError('invalid', `工作区目录必须是绝对路径：${dir}`)
    const target = resolve(dir)
    if (await exists(target)) throw new RepoError('invalid', `工作区目录已存在：${target}`)
    const mirror = await this.deps.mirrors.existing(url, commit, signal)
    const id = randomBytes(8).toString('hex')
    try {
      await mkdir(dirname(target), { recursive: true })
      await this.deps.mirrors.withWorktreeLock(mirror, async () => {
        signal?.throwIfAborted()
        await this.deps.git(['worktree', 'add', '--quiet', '-b', `${BRANCH_PREFIX}${id}`, target, commit], { cwd: mirror, timeoutMs: this.deps.limits().timeoutMs, env, ...signal === undefined ? {} : { signal } })
        await this.git(['config', `${SECTION}.${id}.baseBranch`, baseBranch], mirror)
        await this.git(['config', `${SECTION}.${id}.baseCommit`, commit], mirror)
      })
    } catch (error) {
      throw failure(error, `在 ${target} 打开 ${url} 的工作区`)
    }
    return { url, dir: await realpath(target), baseBranch, baseCommit: commit }
  }

  /**
   * Describe a workspace's changes since its base commit.
   * @param dir - workspace directory.
   * @param signal - cancellation.
   * @returns the changes.
   * @throws {RepoError} `not-found` for a directory that is not a workspace, `unavailable` when git fails.
   */
  async changes(dir: string, signal?: AbortSignal): Promise<WorkspaceChanges> {
    const ws = await this.locate(dir)
    return await this.queued(ws, async () => {
      try {
        return await this.describe(ws, signal)
      } catch (error) {
        throw failure(error, `读取工作区 ${ws.dir} 的改动`)
      }
    })
  }

  /**
   * Record uncommitted changes as a commit and push the local branch.
   * @param dir - workspace directory.
   * @param request - remote branch, commit message, author and session, credentials.
   * @param isDefaultBranch - asks the remote whether a branch is its default branch.
   * @returns the push outcome.
   * @throws {RepoError} see {@link DshRepoService.pushWorkspace}.
   */
  async push(dir: string, request: PushRequest, isDefaultBranch: (url: string, branch: string) => Promise<boolean>): Promise<WorkspacePushResult> {
    return await this.queued(await this.locate(dir), async () => {
      // Read the records again inside the queue: an earlier push may have fixed the branch.
      const ws = await this.locate(dir)
      const branch = request.branch ?? ws.branch
      if (branch === undefined) throw new RepoError('invalid', '第一次推送要给出远端分支名')
      if (ws.branch !== undefined && branch !== ws.branch) throw new RepoError('invalid', `这个工作区已推送到分支 ${ws.branch}，之后只能推送到同一个分支`)
      if (branch === ws.baseBranch) throw new RepoError('invalid', `不能推送到起点分支 ${branch}；换一个新分支名`)
      const first = ws.branch === undefined
      if (first && await isDefaultBranch(ws.url, branch)) throw new RepoError('invalid', `不能推送到默认分支 ${branch}；换一个新分支名`)
      return await this.commitAndPush(ws, branch, first, request)
    })
  }

  private async commitAndPush(ws: Located, branch: string, first: boolean, request: PushRequest): Promise<WorkspacePushResult> {
    let committed = false
    try {
      await this.workspaceGit(ws, ['add', '--all'], {}, request.signal)
      const pending = await this.workspaceGit(ws, ['diff', '--cached', '--name-only', '-z', 'HEAD'], {}, request.signal)
      if (pending !== '') {
        if (request.message === undefined || request.message.trim() === '') throw new RepoError('invalid', '工作区有未提交的改动，推送时要给出提交说明')
        const identity = request.author === undefined ? [] : ['-c', `user.name=${request.author.name}`, '-c', `user.email=${request.author.email}`]
        const trailers = [
          ...request.session === undefined ? [] : [`DSH-Session: ${request.session}`],
          ...(request.trailers ?? []).map(trailer => `${trailer.token}: ${trailer.value}`),
        ].flatMap(line => ['--trailer', line])
        await this.workspaceGit(ws, [...identity, 'commit', '--quiet', '--no-verify', '-m', request.message, ...trailers], {}, request.signal)
        committed = true
      }
      const head = (await this.workspaceGit(ws, ['rev-parse', 'HEAD'], {}, request.signal)).trim()
      if (head === ws.baseCommit) throw new RepoError('invalid', '工作区相对起点提交没有改动，没有可推送的内容')
      const ref = `refs/heads/${branch}`
      const lease = first ? [`--force-with-lease=${ref}:`] : []
      try {
        // `--no-verify` also skips the Git LFS pre-push hook, so upload the LFS objects of the new commits first.
        if (await this.changesLfsFiles(ws, request.signal)) await this.workspaceGit(ws, ['lfs', 'push', 'origin', 'HEAD'], request.env, request.signal)
        const report = await this.workspaceGit(ws, ['push', '--porcelain', '--no-verify', ...lease, 'origin', `HEAD:${ref}`], request.env, request.signal)
        // A lease does not reject a remote branch that already points at HEAD; git reports it as up to date (`=`).
        if (first && report.split('\n').some(line => line.startsWith('=\t'))) throw new RepoError('conflict', `远端分支 ${branch} 已存在，没有推送`)
      } catch (error) {
        // Undo this call's commit so a retry records the changes with its own message.
        if (committed) await this.workspaceGit(ws, ['reset', '--quiet', '--soft', 'HEAD^'], {})
        throw error instanceof RepoError ? error : pushFailure(error, branch)
      }
      if (first) await this.git(['config', `${SECTION}.${ws.id}.branch`, branch], ws.mirror)
      return { url: ws.url, branch, baseBranch: ws.baseBranch, commit: head, committed, created: first }
    } catch (error) {
      throw failure(error, `推送工作区 ${ws.dir} `)
    }
  }

  /**
   * Find a workspace from its checkout directory, verifying both links and the mirror.
   * @param dir - checkout directory.
   * @returns the located workspace.
   * @throws {RepoError} `not-found` for anything but a workspace of this store.
   */
  async locate(dir: string): Promise<Located> {
    let checkout: string
    try {
      checkout = await realpath(dir)
    } catch {
      // A missing or unreadable directory is not a workspace.
      throw notWorkspace(dir, '目录不存在')
    }
    let link: string
    try {
      link = await readFile(join(checkout, '.git'), 'utf8')
    } catch {
      // A `.git` directory (a separate repository) or no `.git` at all.
      throw notWorkspace(checkout, '缺少指向镜像的 .git 文件')
    }
    const match = /^gitdir: (.+)\n?$/.exec(link)
    if (match === null) throw notWorkspace(checkout, '.git 文件内容不对')
    let gitDir: string
    let back: string
    try {
      gitDir = await realpath(resolve(checkout, match[1] ?? ''))
      back = await realpath(dirname((await readFile(join(gitDir, 'gitdir'), 'utf8')).trim()))
    } catch {
      // The metadata the link names is gone (for example pruned).
      throw notWorkspace(checkout, '镜像中的工作区记录不存在')
    }
    const commonGit = dirname(dirname(gitDir))
    if (basename(dirname(gitDir)) !== 'worktrees' || basename(commonGit) !== '.git' || back !== checkout) throw notWorkspace(checkout, '.git 链接与镜像中的记录不一致')
    const mirror = dirname(commonGit)
    if (!await this.deps.mirrors.owns(mirror)) throw notWorkspace(checkout, '链接指向的不是 dsh-repo 的镜像')
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const id = head.startsWith(`ref: refs/heads/${BRANCH_PREFIX}`) ? head.slice(`ref: refs/heads/${BRANCH_PREFIX}`.length) : ''
    if (!ID.test(id)) throw notWorkspace(checkout, '镜像中的工作区不在 dsh-repo 的工作分支上')
    try {
      const read = async (key: string): Promise<string | undefined> => {
        try {
          return (await this.git(['config', '--get', `${SECTION}.${id}.${key}`], mirror)).trim()
        } catch (error) {
          // `git config --get` exits 1 for an unset key.
          if (error instanceof GitError) return undefined
          throw error
        }
      }
      const [url, baseBranch, baseCommit, branch] = await Promise.all([
        this.git(['config', '--get', 'remote.origin.url'], mirror).then(value => value.trim()),
        read('baseBranch'),
        read('baseCommit'),
        read('branch'),
      ])
      if (baseBranch === undefined || baseCommit === undefined) throw notWorkspace(checkout, '镜像中缺少工作区的起点记录')
      return { id, dir: checkout, gitDir, mirror, url, baseBranch, baseCommit, ...branch === undefined ? {} : { branch } }
    } catch (error) {
      throw failure(error, `读取工作区 ${checkout} 的记录`)
    }
  }

  private async describe(ws: Located, signal?: AbortSignal): Promise<WorkspaceChanges> {
    await this.workspaceGit(ws, ['add', '--all'], {}, signal)
    const { maxDiffBytes } = this.deps.limits()
    const [names, numbers, patch, log, pending] = await Promise.all([
      this.workspaceGit(ws, ['diff', '--cached', '-z', '--name-status', '-M', ws.baseCommit], {}, signal),
      this.workspaceGit(ws, ['diff', '--cached', '-z', '--numstat', '-M', ws.baseCommit], {}, signal),
      this.workspaceGit(ws, ['diff', '--cached', '-M', ws.baseCommit], {}, signal, maxDiffBytes + 1),
      this.workspaceGit(ws, ['log', '--reverse', '--format=%H%x1f%s', `${ws.baseCommit}..HEAD`], {}, signal),
      this.workspaceGit(ws, ['diff', '--cached', '--name-only', '-z', 'HEAD'], {}, signal),
    ])
    const bytes = Buffer.from(patch, 'utf8')
    const truncated = bytes.length > maxDiffBytes
    return {
      workspace: { url: ws.url, dir: ws.dir, baseBranch: ws.baseBranch, baseCommit: ws.baseCommit, ...ws.branch === undefined ? {} : { branch: ws.branch } },
      commits: log.split('\n').filter(line => line !== '').map((line) => {
        const [sha = '', subject = ''] = line.split('\x1f')
        return { sha, subject }
      }),
      uncommitted: pending !== '',
      files: parseChanges(names, numbers),
      diff: truncated ? bytes.subarray(0, maxDiffBytes).toString('utf8') : patch,
      truncated,
    }
  }

  /** Run a task after every read or push of the same workspace queued earlier. */
  private queued<T>(ws: Located, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(ws.gitDir) ?? Promise.resolve()).then(task)
    // The queue only orders work; callers observe the failure through `run`.
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(ws.gitDir, tail)
    void tail.then(() => { if (this.locks.get(ws.gitDir) === tail) this.locks.delete(ws.gitDir) })
    return run
  }

  /** Run git on a located workspace with its metadata named explicitly. */
  private workspaceGit(ws: Located, args: readonly string[], env: Readonly<Record<string, string>>, signal?: AbortSignal, maxOutputBytes?: number): Promise<string> {
    return this.deps.git([`--git-dir=${ws.gitDir}`, `--work-tree=${ws.dir}`, ...args], {
      cwd: ws.dir,
      timeoutMs: this.deps.limits().timeoutMs,
      env,
      ...signal === undefined ? {} : { signal },
      ...maxOutputBytes === undefined ? {} : { maxOutputBytes },
    })
  }

  private git(args: readonly string[], cwd: string): Promise<string> {
    return this.deps.git(args, { cwd, timeoutMs: this.deps.limits().timeoutMs, env: {} })
  }
}
