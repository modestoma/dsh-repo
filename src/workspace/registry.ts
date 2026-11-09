/**
 * The record of every workspace dsh-repo created, and the port the local git
 * proxy last listened on, kept in `workspaces.json` beside the settings file.
 * Each record holds the workspace's secret: the password its git
 * configuration sends to the proxy, which only grants git access to that
 * workspace's repository.
 *
 * @module dsh-repo/workspace/registry
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { RepoError } from '../errors.ts'
import { COMMIT_ID } from '../refs.ts'
import type { HostLogger } from '../host.ts'
import { within } from '../paths.ts'

/** One workspace as stored. */
export interface WorkspaceRecord {
  /** 16 lowercase hex characters. */
  readonly id: string
  /** Canonical absolute directory. */
  readonly path: string
  /** Catalog address of the repository. */
  readonly repo: string
  readonly base: string
  readonly baseCommit: string
  readonly branch: string
  /** Password the workspace's git sends to the proxy. */
  readonly secret: string
  /** Session that created it. */
  readonly session?: string
  readonly createdAt: string
}

const recordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  path: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
  baseCommit: z.string().regex(COMMIT_ID),
  branch: z.string().min(1),
  secret: z.string().regex(/^[0-9a-f]{32,}$/),
  session: z.string().min(1).optional(),
  createdAt: z.string(),
}).strict()

const fileSchema = z.object({
  port: z.number().int().min(1).max(65_535).optional(),
  workspaces: z.array(recordSchema).default([]),
}).strict()

/**
 * Path of the workspace record file.
 * @param settingsFile - absolute path of the settings file.
 * @returns `workspaces.json` beside it.
 */
export function workspacesFile(settingsFile: string): string {
  return join(dirname(settingsFile), 'workspaces.json')
}

/** Workspace records and the proxy port, persisted on every change. */
export class WorkspaceRegistry {
  private records: WorkspaceRecord[]
  private savedPort: number | undefined
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Read the file; a missing file means no workspaces and no port.
   * @param file - absolute path of `workspaces.json`.
   * @param logger - reports an unreadable file, which is then treated as empty.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    let parsed: z.output<typeof fileSchema> = { workspaces: [] }
    try {
      const result = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      if (result.success) parsed = result.data
      else logger?.error?.(`dsh-repo: 工作区记录 ${file} 内容不合法，已忽略：${result.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger?.error?.(`dsh-repo: 无法读取工作区记录 ${file}，已忽略：${error instanceof Error ? error.message : String(error)}`)
    }
    this.records = parsed.workspaces
    this.savedPort = parsed.port
  }

  /** @returns every record, oldest first. */
  list(): readonly WorkspaceRecord[] {
    return this.records
  }

  /**
   * @param id - workspace id.
   * @returns the record, or undefined.
   */
  get(id: string): WorkspaceRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  /**
   * The workspace whose directory is or contains a canonical path.
   * @param path - canonical absolute path.
   * @returns the record, or undefined.
   */
  containing(path: string): WorkspaceRecord | undefined {
    return this.records.find(record => record.path === path || within(record.path, path))
  }

  /** @returns the port the proxy last listened on. */
  port(): number | undefined {
    return this.savedPort
  }

  /**
   * Remember the port the proxy listens on.
   * @param port - TCP port.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  setPort(port: number): Promise<void> {
    return this.enqueue(async () => {
      this.savedPort = port
      await this.write()
    })
  }

  /**
   * Add a record.
   * @param record - the new workspace.
   * @throws {RepoError} `unavailable` when the file cannot be written; the record is not kept then.
   */
  add(record: WorkspaceRecord): Promise<void> {
    return this.enqueue(async () => {
      this.records = [...this.records, record]
      try {
        await this.write()
      } catch (error) {
        this.records = this.records.filter(entry => entry.id !== record.id)
        throw error
      }
    })
  }

  /**
   * Forget records.
   * @param ids - workspace ids.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  remove(ids: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const next = this.records.filter(record => !ids.includes(record.id))
      if (next.length === this.records.length) return
      this.records = next
      await this.write()
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    // The queue only orders writes; callers observe failures through `run`.
    this.queue = run.catch(() => undefined)
    return run
  }

  private async write(): Promise<void> {
    const temporary = `${this.file}.tmp-${process.pid}`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      await writeFile(temporary, `${JSON.stringify({ ...this.savedPort === undefined ? {} : { port: this.savedPort }, workspaces: this.records }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
    } catch (error) {
      throw new RepoError('unavailable', `无法保存工作区记录 ${this.file}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
