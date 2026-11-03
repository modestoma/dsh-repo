/**
 * Local mirrors: fetch-only clones under one directory, files and trees read
 * straight from a commit's objects, and read-only `git worktree` checkouts of
 * one commit shared by every holder.
 *
 * - A mirror lives at `<root>/<host>/<path>` derived from its address; local
 *   paths go under `<root>/local/`. A new address is cloned into a temporary
 *   directory and renamed, so a half-finished clone is never used. When the
 *   directory already holds a mirror of another address of the same
 *   repository, its `origin` is pointed at the new address.
 * - Snapshots live at `<root>/.snapshots/<host>/<path>/<commit>-<random>`.
 *   A snapshot is deleted once no lease holds it and it is not the commit
 *   the latest sync resolved. The first sync of a mirror in this process
 *   deletes the snapshots an earlier run left behind.
 * - Clone and fetch of one mirror run one at a time; `git worktree` changes
 *   of one mirror run one at a time.
 * - The first sync of a mirror in this process also deletes the local
 *   branches of writable workspaces ({@link ./workspace.ts}) whose checkouts
 *   were deleted.
 *
 * @module dsh-repo/mirror/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { MirrorState, MirrorTreeEntry, SnapshotLease } from '../contract.ts'
import { RepoError } from '../errors.ts'
import type { MirrorUsage } from '../settings/contract.ts'
import { GitError } from './git.ts'
import type { GitRunner } from './git.ts'
import { measureMirrors } from './usage.ts'
import { forgetAbandonedWorkspaces } from './workspace.ts'

/** Collaborators and limits of the store. */
export interface MirrorStoreDeps {
  readonly git: GitRunner
  /** Absolute directory holding the mirrors at start; {@link MirrorStore.setRoot} changes it. */
  readonly root: string
  /** Git command timeout and read limits, read on every use so saved settings apply to the next command. */
  readonly limits: () => MirrorLimits
}

/** Limits of one mirror operation. */
export interface MirrorLimits {
  /** Timeout of one git command. */
  readonly timeoutMs: number
  readonly maxFileBytes: number
  readonly maxTreeEntries: number
}

const URL_SCHEMES = new Set(['https:', 'file:'])
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[^\s~^:?*[\\\u0000-\u001f\u007f]+$/

/**
 * Whether an address is one this store hands to `git clone`: an `https` or
 * `file` URL, or an absolute local path. SSH, scp-like `user@host:path`,
 * `git://`, plain `http`, and other transports (notably `ext::`) are refused,
 * so every remote address authenticates with a host token.
 * @param value - candidate address.
 * @returns whether it is accepted.
 */
export function isAcceptedGitUrl(value: string): boolean {
  if (value === '' || value.startsWith('-') || /\s/.test(value)) return false
  if (isAbsolute(value)) return true
  try {
    return URL_SCHEMES.has(new URL(value).protocol)
  } catch {
    // Not a URL and not a local path: refused.
    return false
  }
}

/**
 * Directory-safe path segments. A segment that sanitizing changes (a leading
 * dot, other characters) gets a hash of the original appended, so distinct
 * names such as `.github` and `github` keep distinct directories.
 */
function cleanSegments(path: string): string[] {
  const segments = path.replace(/[?#].*$/, '').split(/[/\\]+/)
    .map(segment => segment.replace(/\.git$/, ''))
    .filter(segment => segment !== '' && segment !== '.')
    .map((segment) => {
      const clean = segment.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
      if (clean === segment) return segment
      return `${clean === '' ? 'x' : clean}-${createHash('sha1').update(segment).digest('hex').slice(0, 6)}`
    })
  return segments.length === 0 ? ['repo'] : segments
}

/**
 * Mirror directory of an address, relative to the mirror root:
 * `<host>/<path>` for remote addresses (`host_port` when a port is given)
 * and `local/<name>-<hash>` for local paths and `file:` URLs.
 * @param url - accepted git address.
 * @returns relative directory, `/`-separated.
 */
export function mirrorPath(url: string): string {
  if (!isAbsolute(url)) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') {
      const host = parsed.host.toLowerCase().replace(':', '_').replace(/[^a-z0-9._-]/g, '-')
      return [host, ...cleanSegments(decodeURIComponent(parsed.pathname))].join('/')
    }
  }
  const name = cleanSegments(url).at(-1) ?? 'repo'
  return `local/${name}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`
}

/**
 * Run a task after every task queued earlier under the same key.
 * @param locks - tail of each key's queue.
 * @param key - queue key.
 * @param task - work to run.
 * @returns the task's result.
 */
function serialize<T>(locks: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(task)
  // The queue only orders work; callers observe the failure through `run`.
  const tail = run.then(() => undefined, () => undefined)
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    return (await stat(path)).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function gitFailure(error: unknown, what: string): RepoError {
  if (error instanceof RepoError) return error
  const detail = error instanceof GitError ? error.output : error instanceof Error ? error.message : String(error)
  return new RepoError('unavailable', `${what}失败：${detail === '' ? '无输出' : detail}`)
}

interface Snapshot {
  readonly commit: string
  readonly dir: string
  users: number
  /** Settles once `git worktree add` finished; rejects when it failed. */
  readonly created: Promise<void>
}

interface Mirror {
  /** Commit the latest sync resolved; its snapshot is kept without holders. */
  latest?: string
  readonly snapshots: Map<string, Snapshot>
}

/** Fetch-only mirrors and their commit snapshots. */
export class MirrorStore {
  private readonly mirrors = new Map<string, Mirror>()
  private readonly syncLocks = new Map<string, Promise<void>>()
  private readonly worktreeLocks = new Map<string, Promise<void>>()
  /** Per mirror, the one-time deletion of snapshots an earlier run left behind. */
  private readonly cleared = new Map<string, Promise<void>>()
  /** Root each mirror directory was resolved under, so its snapshots stay beside it after a root change. */
  private readonly roots = new Map<string, string>()
  private currentRoot: string

  /** @param deps - git runner, root, and limits. */
  constructor(private readonly deps: MirrorStoreDeps) {
    this.currentRoot = deps.root
  }

  /** @returns the mirror root. */
  get root(): string {
    return this.currentRoot
  }

  /**
   * Resolve later addresses under another root. Existing mirrors and held
   * snapshots stay where they are; a later sync clones into the new root.
   * @param root - absolute directory.
   */
  setRoot(root: string): void {
    this.currentRoot = root
  }

  /**
   * Absolute mirror directory of an address.
   * @param url - git address.
   * @returns the directory.
   * @throws {RepoError} `invalid` for an unsupported address.
   */
  dirOf(url: string): string {
    if (!isAcceptedGitUrl(url)) throw new RepoError('invalid', `不支持的 git 地址：${url}（只支持 https 地址、file URL 或绝对路径；SSH 地址请改用仓库的 https 地址）`)
    const root = this.currentRoot
    const dir = join(root, ...mirrorPath(url).split('/'))
    this.roots.set(dir, root)
    return dir
  }

  /**
   * Clone or fetch, and resolve the branch head.
   * @param url - git address.
   * @param branch - branch to resolve; undefined resolves the remote's default branch.
   * @param env - environment of the network commands (credentials).
   * @param signal - cancellation.
   * @returns the mirror state.
   * @throws {RepoError} `invalid`, `not-found` for a missing branch, or `unavailable`.
   */
  async sync(url: string, branch: string | undefined, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<MirrorState> {
    const dir = this.dirOf(url)
    if (branch !== undefined && !BRANCH.test(branch)) throw new RepoError('invalid', `分支名不合法：${branch}`)
    return await serialize(this.syncLocks, dir, async () => {
      try {
        await this.update(url, dir, env, signal)
        const resolved = branch ?? await this.remoteHead(dir, env, signal)
        const target = `refs/remotes/origin/${resolved}`
        const listed = await this.git(['for-each-ref', '--format=%(objectname)', target], dir, {}, signal)
        if (listed.trim() === '') throw new RepoError('not-found', `${url} 没有分支 ${resolved}`)
        const [commit = '', commitTime = ''] = (await this.git(['log', '-1', '--format=%H%n%cI', target, '--'], dir, {}, signal)).trim().split('\n')
        const mirror = this.mirror(dir)
        mirror.latest = commit
        this.prune(dir, mirror)
        return { url, dir, branch: resolved, commit, commitTime }
      } catch (error) {
        throw gitFailure(error, `同步镜像 ${url} `)
      }
    })
  }

  /**
   * Read one regular file of a commit.
   * @param url - git address of a mirror on disk.
   * @param commit - full commit id.
   * @param path - path from the repository root.
   * @param signal - cancellation.
   * @returns UTF-8 text, or undefined when the commit has no such path.
   * @throws {RepoError} `invalid`, `too-large`, `not-found`, or `unavailable`.
   */
  async readFile(url: string, commit: string, path: string, signal?: AbortSignal): Promise<string | undefined> {
    const dir = await this.existing(url, commit, signal)
    try {
      const listing = await this.git(['ls-tree', '-z', '--long', commit, '--', path], dir, {}, signal)
      if (listing === '') return undefined
      const [meta = '', listed = ''] = listing.replace(/\0$/, '').split('\t')
      if (listed !== path) return undefined
      const [mode, type, object, size] = meta.split(/\s+/)
      if (type !== 'blob' || mode === '120000' || object === undefined) throw new RepoError('invalid', `${path} 不是普通文件`)
      const { maxFileBytes } = this.deps.limits()
      if (Number(size) > maxFileBytes) throw new RepoError('too-large', `${path} 超过单文件上限 ${maxFileBytes} 字节`)
      return await this.git(['cat-file', 'blob', object], dir, {}, signal)
    } catch (error) {
      throw gitFailure(error, `读取 ${url} 的 ${path} `)
    }
  }

  /**
   * List the entries below a directory of a commit, recursively.
   * @param url - git address of a mirror on disk.
   * @param commit - full commit id.
   * @param path - directory from the repository root; empty lists the whole tree.
   * @param signal - cancellation.
   * @returns entries, directories included.
   * @throws {RepoError} `too-large`, `not-found`, or `unavailable`.
   */
  async listTree(url: string, commit: string, path: string, signal?: AbortSignal): Promise<MirrorTreeEntry[]> {
    const dir = await this.existing(url, commit, signal)
    try {
      const listing = await this.git(['ls-tree', '-r', '-t', '-z', commit, '--', ...path === '' ? [] : [`${path}/`]], dir, {}, signal)
      const entries: MirrorTreeEntry[] = []
      const { maxTreeEntries } = this.deps.limits()
      for (const record of listing.split('\0')) {
        if (record === '') continue
        const tab = record.indexOf('\t')
        const [mode = '', type = ''] = record.slice(0, tab).split(' ')
        const entryPath = record.slice(tab + 1)
        if (path !== '' && !entryPath.startsWith(`${path}/`)) continue
        if (entries.length >= maxTreeEntries) throw new RepoError('too-large', `${path === '' ? '仓库' : path} 下的条目超过上限 ${maxTreeEntries}`)
        if (type === 'tree') entries.push({ path: entryPath, type: 'dir' })
        else if (type === 'commit') entries.push({ path: entryPath, type: 'submodule' })
        else if (mode === '120000') entries.push({ path: entryPath, type: 'symlink' })
        else entries.push({ path: entryPath, type: 'file', executable: mode === '100755' })
      }
      return entries
    } catch (error) {
      throw gitFailure(error, `列出 ${url} 的目录 `)
    }
  }

  /**
   * Hold a read-only checkout of a commit, creating it on first use.
   * @param url - git address of a mirror on disk.
   * @param commit - full commit id.
   * @param signal - cancellation of the existence check.
   * @returns the lease.
   * @throws {RepoError} `not-found` or `unavailable`.
   */
  async acquire(url: string, commit: string, signal?: AbortSignal): Promise<SnapshotLease> {
    const dir = await this.existing(url, commit, signal)
    await this.clearLeftovers(dir)
    const mirror = this.mirror(dir)
    const snapshot = this.snapshotFor(dir, mirror, commit)
    snapshot.users += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      snapshot.users -= 1
      this.prune(dir, mirror)
    }
    try {
      await snapshot.created
    } catch (error) {
      release()
      throw gitFailure(error, `创建 ${url} 在 ${commit.slice(0, 12)} 的快照`)
    }
    return { url, commit, dir: snapshot.dir, release }
  }

  /**
   * Disk usage of the current mirror directory.
   * @returns each mirror with its address and last fetch, the snapshots, and the totals.
   * @throws {RepoError} `unavailable` when the directory cannot be read.
   */
  async usage(): Promise<MirrorUsage> {
    try {
      return await measureMirrors(this.currentRoot, async (dir) => {
        try {
          const url = (await this.git(['config', '--get', 'remote.origin.url'], dir, {})).trim()
          return url === '' ? undefined : url
        } catch {
          // A mirror without an origin is listed without its address.
          return undefined
        }
      })
    } catch (error) {
      throw gitFailure(error, `统计镜像目录 ${this.currentRoot} 的占用`)
    }
  }

  /**
   * Run a task after every `git worktree` change of the same mirror queued earlier.
   * @param dir - mirror directory.
   * @param task - work to run.
   * @returns the task's result.
   */
  withWorktreeLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
    return serialize(this.worktreeLocks, dir, task)
  }

  /**
   * Whether a directory lies inside the current mirror root or a root a
   * mirror was resolved under earlier in this process.
   * @param dir - canonical absolute directory.
   * @returns whether the store owns it.
   */
  async owns(dir: string): Promise<boolean> {
    for (const root of new Set([this.currentRoot, ...this.roots.values()])) {
      let real: string
      try {
        real = await realpath(root)
      } catch {
        // A root that no longer exists owns nothing.
        continue
      }
      const rel = relative(real, dir)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
    }
    return false
  }

  private mirror(dir: string): Mirror {
    let mirror = this.mirrors.get(dir)
    if (mirror === undefined) {
      mirror = { snapshots: new Map() }
      this.mirrors.set(dir, mirror)
    }
    return mirror
  }

  private snapshotRoot(dir: string): string {
    const root = this.roots.get(dir) ?? this.currentRoot
    return join(root, '.snapshots', relative(root, dir))
  }

  private git(args: readonly string[], cwd: string | undefined, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.deps.git(args, { ...cwd === undefined ? {} : { cwd }, timeoutMs: this.deps.limits().timeoutMs, env, ...signal === undefined ? {} : { signal } })
  }

  /**
   * The mirror directory of an address, after checking the mirror and commit exist.
   * @param url - git address.
   * @param commit - full commit id.
   * @param signal - cancellation.
   * @returns the mirror directory.
   * @throws {RepoError} `invalid` for a bad address or commit id, `not-found` when the mirror or commit is missing.
   */
  async existing(url: string, commit: string, signal?: AbortSignal): Promise<string> {
    const dir = this.dirOf(url)
    if (!COMMIT.test(commit)) throw new RepoError('invalid', `提交必须是完整的十六进制提交 id：${commit}`)
    if (await pathKind(join(dir, '.git')) === 'missing') throw new RepoError('not-found', `${url} 还没有镜像，先同步`)
    try {
      await this.git(['cat-file', '-e', `${commit}^{commit}`], dir, {}, signal)
    } catch (error) {
      if (error instanceof GitError) throw new RepoError('not-found', `${url} 的镜像中没有提交 ${commit.slice(0, 12)}`)
      throw gitFailure(error, `检查 ${url} 的提交 `)
    }
    return dir
  }

  private async update(url: string, dir: string, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void> {
    await this.clearLeftovers(dir)
    const kind = await pathKind(dir)
    if (kind === 'missing') {
      await mkdir(dirname(dir), { recursive: true })
      const partial = `${dir}.partial-${randomBytes(4).toString('hex')}`
      try {
        await this.git(['clone', '--quiet', '--no-checkout', '--', url, partial], undefined, env, signal)
        await rename(partial, dir)
      } catch (error) {
        await rm(partial, { recursive: true, force: true })
        throw error
      }
      return
    }
    if (kind !== 'directory') throw new RepoError('unavailable', `${dir} 已存在且不是目录`)
    if (await pathKind(join(dir, '.git')) === 'missing') {
      if ((await readdir(dir)).length !== 0) throw new RepoError('unavailable', `${dir} 已存在且不是 git 仓库，请移走后重新同步`)
      await rm(dir, { recursive: true })
      await this.update(url, dir, env, signal)
      return
    }
    const origin = (await this.git(['config', '--get', 'remote.origin.url'], dir, {}, signal)).trim()
    if (origin !== url) await this.git(['remote', 'set-url', 'origin', url], dir, {}, signal)
    await this.git(['fetch', '--quiet', '--prune', 'origin'], dir, env, signal)
  }

  /**
   * Delete, once per mirror and process, the snapshots an earlier run left
   * behind, before this process creates any snapshot of that mirror, so a
   * lease taken in this process is never deleted by the cleanup.
   */
  private clearLeftovers(dir: string): Promise<void> {
    let cleared = this.cleared.get(dir)
    if (cleared === undefined) {
      cleared = serialize(this.worktreeLocks, dir, async () => {
        await rm(this.snapshotRoot(dir), { recursive: true, force: true })
        if (await pathKind(join(dir, '.git')) === 'missing') return
        await this.git(['worktree', 'prune'], dir, {})
        await forgetAbandonedWorkspaces(args => this.git(args, dir, {}))
      })
      // A failed cleanup is retried by the next caller.
      cleared.catch(() => { this.cleared.delete(dir) })
      this.cleared.set(dir, cleared)
    }
    return cleared
  }

  /**
   * The default branch the remote reports right now.
   * @param url - mirror address.
   * @param env - credentials of the network command.
   * @param signal - cancellation.
   * @returns the branch name, or undefined when the remote reports none.
   * @throws {RepoError} `unavailable` when git fails.
   */
  async remoteDefaultBranch(url: string, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string | undefined> {
    const dir = this.dirOf(url)
    try {
      const listed = await this.git(['ls-remote', '--symref', 'origin', 'HEAD'], dir, env, signal)
      return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed)?.[1]
    } catch (error) {
      throw gitFailure(error, `读取 ${url} 的默认分支`)
    }
  }

  /** The remote's current default branch, asked from the remote on every call so a changed default is followed. */
  private async remoteHead(dir: string, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    await this.git(['remote', 'set-head', 'origin', '--auto'], dir, env, signal)
    return (await this.git(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir, {}, signal)).trim().replace(/^refs\/remotes\/origin\//, '')
  }

  private snapshotFor(dir: string, mirror: Mirror, commit: string): Snapshot {
    const existing = mirror.snapshots.get(commit)
    if (existing !== undefined) return existing
    const target = join(this.snapshotRoot(dir), `${commit.slice(0, 12)}-${randomBytes(3).toString('hex')}`)
    const created = serialize(this.worktreeLocks, dir, async () => {
      await mkdir(dirname(target), { recursive: true })
      await this.git(['worktree', 'add', '--detach', target, commit], dir, {})
    })
    const snapshot: Snapshot = { commit, dir: target, users: 0, created }
    mirror.snapshots.set(commit, snapshot)
    created.catch(() => {
      // The acquiring caller reports the failure; the next acquire retries.
      if (mirror.snapshots.get(commit) === snapshot) mirror.snapshots.delete(commit)
      void this.removeSnapshot(dir, target)
    })
    return snapshot
  }

  private prune(dir: string, mirror: Mirror): void {
    for (const [commit, snapshot] of mirror.snapshots) {
      if (snapshot.users > 0 || commit === mirror.latest) continue
      mirror.snapshots.delete(commit)
      void snapshot.created.then(() => this.removeSnapshot(dir, snapshot.dir), () => undefined)
    }
  }

  private async removeSnapshot(dir: string, target: string): Promise<void> {
    try {
      await serialize(this.worktreeLocks, dir, async () => {
        await rm(target, { recursive: true, force: true })
        await this.git(['worktree', 'prune'], dir, {})
      })
    } catch {
      // Best effort: the first sync after the next start deletes leftover snapshots.
    }
  }
}
