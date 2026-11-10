/**
 * The settings page's view of workspaces: every workspace dsh-repo created
 * with its branch, unsaved work, and open PRs/MRs, and creating and removing
 * workspaces in the directory the page chose. Workspaces the page creates
 * belong to no Session, so their pushes ask no Session for authorization.
 *
 * @module dsh-repo/workspace/panel
 */

import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { CatalogEntry } from '../catalog/entry.ts'
import { expandHome } from '../config.ts'
import { RepoError } from '../errors.ts'
import { freeDirectory } from '../paths.ts'
import type { RepoService } from '../service.ts'
import type { WorkspaceCreateInput, WorkspaceMr, WorkspaceRow } from '../settings/contract.ts'
import type { WorkspaceManager } from './manager.ts'
import type { WorkspaceRecord } from './registry.ts'

/** Most open PRs/MRs listed for one workspace. */
const MAX_LISTED_MRS = 5

/** What the settings routes need from the workspaces. */
export interface WorkspacePanel {
  /** @returns the directory the page creates workspaces in, or undefined while none is set. */
  dir(): string | undefined
  /**
   * Set or clear the directory the page creates workspaces in.
   * @param dir - absolute directory, created when missing; `~` expands. Undefined clears it.
   * @throws {RepoError} `invalid` for a relative path or one that cannot be created or written.
   */
  setDir(dir: string | undefined): Promise<void>
  /** @returns the port the local git proxy listens on, or undefined while it is not running. */
  proxyPort(): number | undefined
  /** @returns every workspace whose directory still exists, oldest first, each with its state or why it could not be read. */
  rows(): Promise<WorkspaceRow[]>
  /**
   * Create a workspace under the page's directory.
   * @param input - catalog entry, base, branch, and directory name.
   * @returns the new workspace.
   * @throws {RepoError} `invalid` while no directory is set or for a bad name, `not-found` for an unknown catalog entry, and the failures of `workspaceCreate`.
   */
  create(input: WorkspaceCreateInput): Promise<WorkspaceRow>
  /**
   * Delete a workspace's directory and record.
   * @param id - workspace id.
   * @param force - delete despite uncommitted changes or unpushed commits.
   * @throws {RepoError} `not-found` for an unknown workspace, `conflict` for unsaved work without `force`.
   */
  remove(id: string, force: boolean): Promise<void>
}

/**
 * A directory the page may create workspaces in, created when missing.
 * @param dir - absolute path; `~` expands.
 * @returns the absolute directory.
 * @throws {RepoError} `invalid` for a relative path or one that cannot be created or written.
 */
export async function usableDirectory(dir: string): Promise<string> {
  const trimmed = dir.trim()
  // expandHome resolves a relative path against the process directory, so it is checked first.
  if (!isAbsolute(trimmed) && trimmed !== '~' && !trimmed.startsWith('~/')) throw new RepoError('invalid', `工作区目录必须是绝对路径：${dir}`)
  const target = expandHome(trimmed)
  try {
    await mkdir(target, { recursive: true })
    await access(target, constants.W_OK)
  } catch (error) {
    throw new RepoError('invalid', `无法创建或写入工作区目录 ${target}：${error instanceof Error ? error.message : String(error)}`)
  }
  return target
}

/**
 * The settings page's view of the workspaces.
 * @param service - the `dshRepos` implementation.
 * @param manager - the workspaces.
 * @param proxyPort - the port the local git proxy listens on now.
 * @returns the panel.
 */
export function workspacePanel(service: RepoService, manager: WorkspaceManager, proxyPort: () => number | undefined): WorkspacePanel {
  const row = async (record: WorkspaceRecord): Promise<WorkspaceRow> => {
    const timeoutMs = service.settings.current.mirror.gitTimeoutMs
    let entry: CatalogEntry | undefined
    try {
      entry = service.catalog.find(record.repo)
    } catch {
      // The address no longer resolves (its host was removed, or a local path older versions accepted): shown as stored, without PRs/MRs.
      entry = undefined
    }
    const key = entry === undefined ? undefined : service.catalog.keyOf(entry)
    const base: WorkspaceRow = {
      id: record.id,
      url: record.repo,
      repo: key !== undefined && 'key' in key ? key.key : record.repo,
      path: record.path,
      base: record.base,
      branch: record.branch,
      ...record.session === undefined ? {} : { session: record.session },
      createdAt: record.createdAt,
    }
    const errors: string[] = []
    const [summary, mrs] = await Promise.all([
      manager.summary(record, timeoutMs).catch((error: unknown) => { errors.push(error instanceof Error ? error.message : String(error)) }),
      entry === undefined
        ? undefined
        : service.forge.listMrs(record.repo, { state: 'open', sourceBranch: record.branch, page: 1, perPage: MAX_LISTED_MRS }).then(
            (page): WorkspaceMr[] => page.items.map(mr => ({ number: mr.number, title: mr.title, webUrl: mr.webUrl })),
            (error: unknown) => { errors.push(`无法读取 PR/MR：${error instanceof Error ? error.message : String(error)}`) },
          ),
    ])
    return {
      ...base,
      ...summary ?? {},
      ...mrs === undefined ? {} : { mrs },
      ...errors.length === 0 ? {} : { error: errors.join('；') },
    }
  }
  return {
    dir: () => service.settings.workspaceDir(),
    setDir: async (dir) => { await service.settings.setWorkspaceDir(dir === undefined ? undefined : await usableDirectory(dir)) },
    proxyPort,
    rows: async () => await Promise.all((await manager.list()).map(row)),
    create: async (input) => {
      const entry = service.catalog.entries().find(item => item.id === input.repo)
      if (entry === undefined) throw new RepoError('not-found', '仓库清单中没有这个仓库，可能已经删除')
      const parent = service.settings.workspaceDir()
      if (parent === undefined) throw new RepoError('invalid', '还没有设置工作区目录；先在「高级 → 工作区」里设置')
      const name = input.name?.trim() ?? ''
      if (name !== '' && (name === '.' || name === '..' || /[/\\\0]/.test(name))) throw new RepoError('invalid', `目录名只能是一级名称：${name}`)
      const path = name === '' ? await freeDirectory(parent, basename(entry.url.replace(/\/+$/, '').replace(/\.git$/, '')) || 'repo') : join(parent, name)
      const base = input.base?.trim() ?? ''
      const branch = input.branch?.trim() ?? ''
      const info = await manager.create({ repo: entry.url, path, ...base === '' ? {} : { base }, ...branch === '' ? {} : { branch } })
      const record = (await manager.list()).find(item => item.id === info.id)
      if (record === undefined) throw new RepoError('unavailable', `工作区 ${info.path} 创建后没有找到记录`)
      return await row(record)
    },
    remove: async (id, force) => {
      const record = (await manager.list()).find(item => item.id === id)
      if (record === undefined) throw new RepoError('not-found', '没有这个工作区，可能已经删除')
      await manager.remove(record, force, undefined, service.settings.current.mirror.gitTimeoutMs)
    },
  }
}
