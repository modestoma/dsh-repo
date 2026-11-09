/**
 * The write policy: the one place that decides whether a write to a code
 * host may happen.
 *
 * - While the settings page turns writes `off`, every write to a code host is
 *   refused, whoever asks: tools, `dshRepos` calls with or without `agent`,
 *   the settings page, and plain `git push` in a workspace.
 * - A write needs the repository in the catalog with the access it names.
 * - A push from a workspace may only update branches: no tags or other refs,
 *   no deletions, not the default branch, and not a protected branch.
 *
 * Approval and `access/authorize` for an Agent's Session are not decided
 * here but by the operation gate and the proxy, after this policy allows the
 * write.
 *
 * @module dsh-repo/policy
 */

import type { RepoCatalog } from './catalog/catalog.ts'
import type { CatalogEntry } from './catalog/entry.ts'
import type { RepoSettings } from './config.ts'
import type { RepoTarget } from './contract.ts'
import { RepoError } from './errors.ts'
import type { Forge } from './forge/forge.ts'
import type { Mirrors } from './mirror/access.ts'
import { isBranchName } from './refs.ts'

/** Access a write needs on its repository. */
export type WriteLevel = 'write' | 'merge'

/** One ref update of a push. */
export interface RefUpdate {
  /** Full ref name, e.g. `refs/heads/fix/a`. */
  readonly ref: string
  /** New object id; all zeros deletes the ref. */
  readonly new: string
}

const ZERO = /^0+$/

/**
 * Refuse while the settings page turns writes off.
 * @param settings - run-time settings now in effect.
 * @param action - what is refused, for the message.
 * @throws {RepoError} `forbidden` while writes are off.
 */
export function requireWritesOn(settings: RepoSettings, action: string): void {
  if (settings.tools.writes === 'off') throw new RepoError('forbidden', `dsh-repo 设置页已关闭写操作，${action} 不会执行`)
}

/** Collaborators of {@link WritePolicy}. */
export interface WritePolicyDeps {
  readonly catalog: RepoCatalog
  readonly mirrors: Mirrors
  readonly forge: Forge
  /** @returns the run-time settings now in effect, read on every decision. */
  readonly settings: () => RepoSettings
}

/** Decides whether a write to a code host may happen. */
export class WritePolicy {
  /** @param deps - catalog, mirrors, API calls, and settings. */
  constructor(private readonly deps: WritePolicyDeps) {}

  /**
   * Refuse while the settings page turns writes off.
   * @param action - what is refused, for the message.
   * @throws {RepoError} `forbidden` while writes are off.
   */
  requireWritesOn(action: string): void {
    requireWritesOn(this.deps.settings(), action)
  }

  /**
   * Require writes on and the repository in the catalog with `level` access.
   * @param target - repository address, `host/path`, or PR/MR URL.
   * @param level - access the write needs.
   * @param action - what is refused, for the message.
   * @returns the catalog entry.
   * @throws {RepoError} `forbidden` while writes are off, and the catalog's refusals (see `RepoCatalog.open`).
   */
  requireWrite(target: RepoTarget, level: WriteLevel, action: string): CatalogEntry {
    this.requireWritesOn(action)
    return this.deps.catalog.require(target, level)
  }

  /**
   * Why a push from a workspace is refused, or undefined when every update may go to the remote.
   * @param repo - catalog address of the workspace's repository.
   * @param updates - the push's ref updates.
   * @returns the reason in Chinese.
   */
  async pushRefusal(repo: string, updates: readonly RefUpdate[]): Promise<string | undefined> {
    try {
      this.requireWrite(repo, 'write', 'git push')
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    let defaultBranch: string
    try {
      defaultBranch = await this.remoteDefaultBranch(repo)
    } catch (error) {
      return `无法确认默认分支：${error instanceof Error ? error.message : String(error)}`
    }
    for (const update of updates) {
      if (!update.ref.startsWith('refs/heads/') || !isBranchName(update.ref.slice('refs/heads/'.length))) return `只能推送分支，不能推送 ${update.ref}（标签等其他引用不经工作区推送）`
      const branch = update.ref.slice('refs/heads/'.length)
      if (ZERO.test(update.new)) return `不能删除远端分支 ${branch}`
      if (branch === defaultBranch) return defaultRefusal(branch)
      try {
        await this.requirePushableBranch(repo, branch)
      } catch (error) {
        return error instanceof RepoError && error.code === 'forbidden' ? error.message : `无法确认分支 ${branch} 是否受保护：${error instanceof Error ? error.message : String(error)}`
      }
    }
    return undefined
  }

  /**
   * Require a branch a workspace may push to: neither the remote's default branch nor a protected one.
   * @param repo - catalog address.
   * @param branch - branch name.
   * @param signal - cancellation.
   * @throws {RepoError} `forbidden` for the default or a protected branch, and the failures of reading the branch.
   */
  async requirePushableBranch(repo: string, branch: string, signal?: AbortSignal): Promise<void> {
    const remote = await this.deps.forge.getBranch(repo, branch, signal === undefined ? {} : { signal })
    if (remote?.default === true) throw new RepoError('forbidden', defaultRefusal(branch))
    if (remote?.protected === true) throw new RepoError('forbidden', `${branch} 是受保护分支，工作区不能推送到它`)
  }

  /** The remote's default branch; asked of the remote, since the mirror's HEAD may predate a change of the default branch. */
  private async remoteDefaultBranch(repo: string): Promise<string> {
    const { store } = this.deps.mirrors
    return await store.remoteDefaultBranch(repo, await this.deps.mirrors.auth(repo, true)) ?? await store.defaultBranch(repo)
  }
}

function defaultRefusal(branch: string): string {
  return `不能直接推送到默认分支 ${branch}；推送到别的分支后创建 PR/MR`
}
