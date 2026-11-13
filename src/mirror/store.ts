/**
 * Local mirrors: bare replicas of the remote under one directory, and
 * read-only snapshots (plain files, no `.git`) of one commit shared by every
 * holder. The remote is the only source of truth: a mirror is fetched before
 * anything is served from it, and only dsh-repo writes it.
 *
 * - A mirror lives at `<root>/<host>/<path>.git` derived from its address. It is a bare repository whose
 *   `refs/heads/*` and `refs/tags/*` equal the remote's after each fetch, and
 *   whose `HEAD` names the remote's default branch, so workspaces can clone
 *   and fetch from it as if it were the remote. A new address is cloned into
 *   a temporary directory and renamed, so a half-finished clone is never used.
 * - Mirrors never collect garbage (`gc.auto=0`, `gc.pruneExpire=never`):
 *   workspaces borrow their objects through git alternates.
 * - Snapshots live at `<root>/.snapshots/<host>/<path>/<commit>-<random>`.
 *   A snapshot is deleted once no lease holds it and it is not the commit the
 *   latest sync resolved; the random suffix keeps a new snapshot of the same
 *   commit apart from one still being deleted. The first use of a mirror in
 *   this process deletes the snapshots an earlier run left behind.
 * - Clone and fetch of one mirror run one at a time.
 *
 * @module dsh-repo/mirror/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { RepoError } from '../errors.ts'
import { isCommitId, requireBranch, requireCommit } from '../refs.ts'
import { MIRROR_DIR_UNSET } from './root.ts'
import type { MirrorUsage } from '../settings/contract.ts'
import { GitError } from './git.ts'
import type { GitRunner } from './git.ts'
import { measureMirrors } from './usage.ts'

/** Collaborators and limits of the store. */
export interface MirrorStoreDeps {
  readonly git: GitRunner
  /** Absolute directory holding the mirrors at start, or undefined while none is chosen; {@link MirrorStore.setRoot} changes it. */
  readonly root: string | undefined
  /** Git command timeout, read on every use so saved settings apply to the next command. */
  readonly limits: () => MirrorLimits
}

/** Limits of one mirror operation. */
export interface MirrorLimits {
  /** Timeout of one git command. */
  readonly timeoutMs: number
}

/** A mirror after a successful clone or fetch. */
export interface MirrorState {
  /** The address as passed in. */
  readonly url: string
  /** Absolute directory of the bare mirror. */
  readonly dir: string
  /** The requested branch, or the remote's default branch. */
  readonly branch: string
  /** The remote's default branch. */
  readonly defaultBranch: string
  /** Commit the branch points to after the fetch. */
  readonly commit: string
  /** Committer date of {@link commit}, ISO 8601. */
  readonly commitTime: string
}

/** A snapshot held until {@link release} runs. */
export interface MirrorSnapshot {
  readonly commit: string
  /** Absolute directory of the files. */
  readonly dir: string
  release(): void
}


/**
 * Whether an address is one this store hands to `git clone`: an `https` URL.
 * Local paths, `file:` URLs, SSH, scp-like `user@host:path`, `git://`, plain
 * `http`, and other transports (notably `ext::`) are refused, so every
 * address authenticates with a host token.
 * @param value - candidate address.
 * @returns whether it is accepted.
 */
export function isAcceptedGitUrl(value: string): boolean {
  if (value === '' || value.startsWith('-') || /\s/.test(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    // Not a URL: refused.
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
 * `<host>/<path>.git` (`host_port` when a port is given).
 * @param url - accepted git address.
 * @returns relative directory, `/`-separated.
 */
export function mirrorPath(url: string): string {
  const parsed = new URL(url)
  const host = parsed.host.toLowerCase().replace(':', '_').replace(/[^a-z0-9._-]/g, '-')
  return `${[host, ...cleanSegments(decodeURIComponent(parsed.pathname))].join('/')}.git`
}

/**
 * Run a task after every task queued earlier under the same key.
 * @param locks - tail of each key's queue.
 * @param key - queue key.
 * @param task - work to run.
 * @returns the task's result.
 */
export function serialize<T>(locks: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
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

/**
 * A failure as a {@link RepoError}: `RepoError`s stay, everything else is `unavailable` with git's output.
 * @param error - what was thrown.
 * @param what - the operation, ending in a space when the message continues.
 * @returns the classified error.
 */
export function gitFailure(error: unknown, what: string): RepoError {
  if (error instanceof RepoError) return error
  const detail = error instanceof GitError ? error.output : error instanceof Error ? error.message : String(error)
  return new RepoError('unavailable', `${what}失败：${detail === '' ? '无输出' : detail}`)
}

interface Snapshot {
  readonly commit: string
  readonly dir: string
  users: number
  /** Settles once the files are written; rejects when that failed. */
  readonly created: Promise<void>
}

interface Mirror {
  /** Commit the latest sync resolved; its snapshot is kept without holders. */
  latest?: string
  readonly snapshots: Map<string, Snapshot>
}

/** Bare mirrors and their commit snapshots. */
export class MirrorStore {
  private readonly mirrors = new Map<string, Mirror>()
  private readonly syncLocks = new Map<string, Promise<void>>()
  /** Per mirror, the one-time deletion of snapshots an earlier run left behind. */
  private readonly cleared = new Map<string, Promise<void>>()
  /** Root each mirror directory was resolved under, so its snapshots stay beside it after a root change. */
  private readonly roots = new Map<string, string>()
  private currentRoot: string | undefined

  /** @param deps - git runner, root, and limits. */
  constructor(private readonly deps: MirrorStoreDeps) {
    this.currentRoot = deps.root
  }

  /** @returns the mirror root, or undefined while none is chosen. */
  get root(): string | undefined {
    return this.currentRoot
  }

  /**
   * Resolve later addresses under another root, or under none. Existing
   * mirrors and held snapshots stay where they are; a later sync clones into
   * the new root.
   * @param root - absolute directory, or undefined to refuse later operations until one is chosen.
   */
  setRoot(root: string | undefined): void {
    this.currentRoot = root
  }

  /**
   * Absolute mirror directory of an address.
   * @param url - git address.
   * @returns the directory.
   * @throws {RepoError} `invalid` for an unsupported address, `unavailable` while no root is chosen.
   */
  dirOf(url: string): string {
    if (!isAcceptedGitUrl(url)) throw new RepoError('invalid', `不支持的 git 地址：${url}（只支持 https 地址；SSH 地址请改用仓库的 https 地址）`)
    const root = this.requireRoot()
    const dir = join(root, ...mirrorPath(url).split('/'))
    this.roots.set(dir, root)
    return dir
  }

  /**
   * Clone or fetch, point the mirror's `HEAD` at the remote's default branch,
   * and resolve the branch head.
   * @param url - git address.
   * @param branch - branch to resolve; undefined resolves the remote's default branch.
   * @param env - environment of the network commands (credentials).
   * @param signal - cancellation.
   * @returns the mirror state.
   * @throws {RepoError} `invalid`, `not-found` for a missing branch, or `unavailable`.
   */
  async sync(url: string, branch: string | undefined, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<MirrorState> {
    const dir = this.dirOf(url)
    if (branch !== undefined) requireBranch(branch, '分支名')
    return await serialize(this.syncLocks, dir, async () => {
      try {
        await this.update(url, dir, env, signal)
        const defaultBranch = await this.followRemoteHead(dir, env, signal)
        const resolved = branch ?? defaultBranch
        const head = await this.branchHead(dir, resolved, signal)
        if (head === undefined) throw new RepoError('not-found', `${url} 没有分支 ${resolved}`)
        const mirror = this.mirror(dir)
        mirror.latest = head.commit
        this.prune(dir, mirror)
        return { url, dir, branch: resolved, defaultBranch, ...head }
      } catch (error) {
        throw gitFailure(error, `同步镜像 ${url} `)
      }
    })
  }

  /**
   * The commit a branch, tag, or full commit id names in a synced mirror.
   * @param url - git address of a mirror on disk.
   * @param ref - branch, tag, or full commit id.
   * @param signal - cancellation.
   * @returns the full commit id.
   * @throws {RepoError} `not-found` when the mirror has nothing of that name, `unavailable` when git fails.
   */
  async resolveRef(url: string, ref: string, signal?: AbortSignal): Promise<string> {
    const dir = this.dirOf(url)
    if (isCommitId(ref)) return (await this.existing(url, ref, signal), ref)
    // Tags follow the same naming rules as branches.
    requireBranch(ref, 'ref ')
    for (const candidate of [`refs/heads/${ref}`, `refs/tags/${ref}`]) {
      try {
        return (await this.git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], dir, {}, signal)).trim()
      } catch (error) {
        // `rev-parse --verify --quiet` exits 1 for a missing ref; the next candidate is tried.
        if (!(error instanceof GitError)) throw gitFailure(error, `解析 ${url} 的 ${ref} `)
      }
    }
    throw new RepoError('not-found', `${url} 没有分支或标签 ${ref}`)
  }

  /**
   * The remote's default branch as the latest sync recorded it in the mirror's `HEAD`.
   * @param url - git address of a mirror on disk.
   * @param signal - cancellation.
   * @returns the branch name.
   * @throws {RepoError} `not-found` before the first sync, `unavailable` when git fails.
   */
  async defaultBranch(url: string, signal?: AbortSignal): Promise<string> {
    const dir = this.dirOf(url)
    if (await pathKind(join(dir, 'objects')) === 'missing') throw new RepoError('not-found', `${url} 还没有镜像，先同步`)
    try {
      return (await this.git(['symbolic-ref', '--short', 'HEAD'], dir, {}, signal)).trim()
    } catch (error) {
      throw gitFailure(error, `读取 ${url} 的默认分支`)
    }
  }

  /**
   * Hold read-only files of a commit, writing them on first use.
   * @param url - git address of a synced mirror.
   * @param commit - full commit id present in the mirror.
   * @param signal - cancellation of the existence check.
   * @returns the lease.
   * @throws {RepoError} `not-found` or `unavailable`.
   */
  async acquire(url: string, commit: string, signal?: AbortSignal): Promise<MirrorSnapshot> {
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
    return { commit, dir: snapshot.dir, release }
  }

  /**
   * Disk usage of the current mirror directory.
   * @returns each mirror with its address and last fetch, the snapshots, and the totals.
   * @throws {RepoError} `unavailable` while no root is chosen or when the directory cannot be read.
   */
  async usage(): Promise<MirrorUsage> {
    const root = this.requireRoot()
    try {
      return await measureMirrors(root, async (dir) => {
        try {
          const url = (await this.git(['config', '--get', 'remote.origin.url'], dir, {})).trim()
          return url === '' ? undefined : url
        } catch {
          // A mirror without an origin is listed without its address.
          return undefined
        }
      })
    } catch (error) {
      throw gitFailure(error, `统计镜像目录 ${root} 的占用`)
    }
  }

  /**
   * Whether a directory lies inside the current mirror root or a root a
   * mirror was resolved under earlier in this process.
   * @param dir - canonical absolute directory.
   * @returns whether the store owns it.
   */
  async owns(dir: string): Promise<boolean> {
    for (const root of new Set([this.currentRoot, ...this.roots.values()])) {
      if (root === undefined) continue
      let real: string
      try {
        real = await realpath(root)
      } catch {
        // A root that no longer exists owns nothing.
        continue
      }
      const rel = relative(real, dir)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
    }
    return false
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
    requireCommit(commit, '提交')
    if (await pathKind(join(dir, 'objects')) === 'missing') throw new RepoError('not-found', `${url} 还没有镜像，先同步`)
    try {
      await this.git(['cat-file', '-e', `${commit}^{commit}`], dir, {}, signal)
    } catch (error) {
      if (error instanceof GitError) throw new RepoError('not-found', `${url} 的镜像中没有提交 ${commit.slice(0, 12)}`)
      throw gitFailure(error, `检查 ${url} 的提交 `)
    }
    return dir
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
    try {
      const listed = await this.git(['ls-remote', '--symref', '--', url, 'HEAD'], undefined, env, signal)
      return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed)?.[1]
    } catch (error) {
      throw gitFailure(error, `读取 ${url} 的默认分支`)
    }
  }

  /**
   * The branches the remote has right now.
   * @param url - accepted git address.
   * @param env - credentials of the network command.
   * @param timeoutMs - deadline of the command.
   * @param signal - cancellation.
   * @returns the branch names and the remote's default branch, when it reports one.
   * @throws {RepoError} `unavailable` when git fails (unreachable remote, refused token).
   */
  async remoteBranches(url: string, env: Readonly<Record<string, string>>, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly branches: readonly string[]; readonly defaultBranch?: string }> {
    let listed: string
    try {
      listed = await this.deps.git(['ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*'], { timeoutMs, env, ...signal === undefined ? {} : { signal } })
    } catch (error) {
      throw gitFailure(error, `访问 ${url} `)
    }
    const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed)?.[1]
    const branches = listed.split('\n').flatMap((line) => {
      const ref = /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(line)?.[1]
      return ref === undefined ? [] : [ref]
    })
    return { branches, ...defaultBranch === undefined ? {} : { defaultBranch } }
  }

  /**
   * The branches a mirror on disk holds, without contacting the remote.
   * @param url - accepted git address.
   * @param signal - cancellation.
   * @returns the sorted branch names and the default branch the latest fetch recorded; no branches while the mirror was never fetched.
   * @throws {RepoError} `invalid` for an unsupported address, `unavailable` while no root is chosen or git fails.
   */
  async localBranches(url: string, signal?: AbortSignal): Promise<{ readonly branches: readonly string[]; readonly defaultBranch?: string }> {
    const dir = this.dirOf(url)
    if (await pathKind(join(dir, 'objects')) === 'missing') return { branches: [] }
    try {
      const listed = await this.git(['for-each-ref', '--format=%(refname:lstrip=2)', '--sort=refname', 'refs/heads/'], dir, {}, signal)
      // A detached HEAD names no default branch.
      const head = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir, {}, signal).catch((_detached: unknown) => '')).trim()
      return { branches: listed.split('\n').filter(name => name !== ''), ...head === '' ? {} : { defaultBranch: head } }
    } catch (error) {
      throw gitFailure(error, `读取 ${url} 的镜像分支`)
    }
  }

  private mirror(dir: string): Mirror {
    let mirror = this.mirrors.get(dir)
    if (mirror === undefined) {
      mirror = { snapshots: new Map() }
      this.mirrors.set(dir, mirror)
    }
    return mirror
  }

  private requireRoot(): string {
    if (this.currentRoot === undefined) throw new RepoError('unavailable', MIRROR_DIR_UNSET)
    return this.currentRoot
  }

  private snapshotRoot(dir: string): string {
    const root = this.roots.get(dir) ?? this.requireRoot()
    return join(root, '.snapshots', relative(root, dir).replace(/\.git$/, ''))
  }

  private git(args: readonly string[], cwd: string | undefined, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.deps.git(cwd === undefined ? args : [`--git-dir=${cwd}`, ...args], { ...cwd === undefined ? {} : { cwd }, timeoutMs: this.deps.limits().timeoutMs, env, ...signal === undefined ? {} : { signal } })
  }

  private async branchHead(dir: string, branch: string, signal?: AbortSignal): Promise<{ commit: string; commitTime: string } | undefined> {
    const target = `refs/heads/${branch}`
    // for-each-ref also matches branches below `branch/`, so the refname has to match exactly.
    const listed = await this.git(['for-each-ref', '--format=%(refname)', target], dir, {}, signal)
    if (!listed.split('\n').includes(target)) return undefined
    const [commit = '', commitTime = ''] = (await this.git(['log', '-1', '--format=%H%n%cI', target, '--'], dir, {}, signal)).trim().split('\n')
    return { commit, commitTime }
  }

  private async update(url: string, dir: string, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<void> {
    await this.clearLeftovers(dir)
    const kind = await pathKind(dir)
    if (kind === 'missing') {
      await mkdir(dirname(dir), { recursive: true })
      const partial = `${dir}.partial-${randomBytes(4).toString('hex')}`
      try {
        await this.git(['clone', '--quiet', '--bare', '--', url, partial], undefined, env, signal)
        await this.configure(partial, signal)
        await this.git(['fetch', '--quiet', '--prune', 'origin'], partial, env, signal)
        await rename(partial, dir)
      } catch (error) {
        await rm(partial, { recursive: true, force: true })
        throw error
      }
      return
    }
    if (kind !== 'directory') throw new RepoError('unavailable', `${dir} 已存在且不是目录`)
    if (await pathKind(join(dir, 'objects')) === 'missing') {
      if ((await readdir(dir)).length !== 0) throw new RepoError('unavailable', `${dir} 已存在且不是 git 仓库，请移走后重新同步`)
      await rm(dir, { recursive: true })
      await this.update(url, dir, env, signal)
      return
    }
    const origin = (await this.git(['config', '--get', 'remote.origin.url'], dir, {}, signal)).trim()
    if (origin !== url) await this.git(['remote', 'set-url', 'origin', url], dir, {}, signal)
    await this.git(['fetch', '--quiet', '--prune', 'origin'], dir, env, signal)
  }

  /** Make a fresh bare clone fetch every branch and tag as its own and never drop objects workspaces borrow. */
  private async configure(dir: string, signal?: AbortSignal): Promise<void> {
    await this.git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], dir, {}, signal)
    await this.git(['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'], dir, {}, signal)
    for (const [key, value] of [['gc.auto', '0'], ['gc.pruneExpire', 'never'], ['core.logAllRefUpdates', 'false'], ['uploadpack.allowFilter', 'true']] as const) {
      await this.git(['config', key, value], dir, {}, signal)
    }
  }

  /** Point `HEAD` at the remote's current default branch, asked from the remote on every sync so a changed default is followed. */
  private async followRemoteHead(dir: string, env: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const listed = await this.git(['ls-remote', '--symref', 'origin', 'HEAD'], dir, env, signal)
    const reported = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed)?.[1]
    if (reported !== undefined) {
      await this.git(['symbolic-ref', 'HEAD', `refs/heads/${reported}`], dir, {}, signal)
      return reported
    }
    return (await this.git(['symbolic-ref', '--short', 'HEAD'], dir, {}, signal)).trim()
  }

  /**
   * Delete, once per mirror and process, the snapshots an earlier run left
   * behind, before this process creates any snapshot of that mirror, so a
   * lease taken in this process is never deleted by the cleanup.
   */
  private clearLeftovers(dir: string): Promise<void> {
    let cleared = this.cleared.get(dir)
    if (cleared === undefined) {
      cleared = rm(this.snapshotRoot(dir), { recursive: true, force: true })
      // A failed cleanup is retried by the next caller.
      cleared.catch(() => { this.cleared.delete(dir) })
      this.cleared.set(dir, cleared)
    }
    return cleared
  }

  private snapshotFor(dir: string, mirror: Mirror, commit: string): Snapshot {
    const existing = mirror.snapshots.get(commit)
    if (existing !== undefined) return existing
    const target = join(this.snapshotRoot(dir), `${commit.slice(0, 12)}-${randomBytes(3).toString('hex')}`)
    const created = this.writeSnapshot(dir, commit, target)
    const snapshot: Snapshot = { commit, dir: target, users: 0, created }
    mirror.snapshots.set(commit, snapshot)
    created.catch(() => {
      // The acquiring caller reports the failure; the next acquire retries.
      if (mirror.snapshots.get(commit) === snapshot) mirror.snapshots.delete(commit)
      void rm(target, { recursive: true, force: true })
    })
    return snapshot
  }

  /** Write the files of a commit to `target` through a private index, so the mirror is only read. */
  private async writeSnapshot(dir: string, commit: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true })
    const index = `${target}.index`
    try {
      await this.git(['read-tree', commit], dir, { GIT_INDEX_FILE: index })
      await this.git([`--work-tree=${target}`, 'checkout-index', '--all', '--force'], dir, { GIT_INDEX_FILE: index })
    } finally {
      await rm(index, { force: true })
    }
  }

  private prune(dir: string, mirror: Mirror): void {
    for (const [commit, snapshot] of mirror.snapshots) {
      if (snapshot.users > 0 || commit === mirror.latest) continue
      mirror.snapshots.delete(commit)
      void snapshot.created.then(() => rm(snapshot.dir, { recursive: true, force: true }), () => undefined).catch(() => {
        // Best effort: the first use after the next start deletes leftover snapshots.
      })
    }
  }
}
