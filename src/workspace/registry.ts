/**
 * The record of every workspace dsh-repo created, and the port the local git
 * proxy last listened on, kept in `workspaces.json` beside the settings file.
 * Each record holds the workspace's secret: the password its git
 * configuration sends to the proxy, which only grants git access to that
 * workspace's repository.
 *
 * @module dsh-repo/workspace/registry
 */

import { dirname, join } from 'node:path'
import { z } from 'zod'
import { JsonFile } from '../files.ts'
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

/** What `workspaces.json` holds. */
interface Content {
  readonly port?: number | undefined
  readonly workspaces: readonly WorkspaceRecord[]
}

/** Workspace records and the proxy port, persisted on every change. */
export class WorkspaceRegistry {
  private readonly json: JsonFile<Content>

  /**
   * Read the file. A missing file means no workspaces and no port; an
   * unreadable or invalid one is renamed to `workspaces.json.invalid-<time>`
   * and reported, so its records and secrets stay recoverable.
   * @param file - absolute path of `workspaces.json`.
   * @param logger - reports a set-aside file.
   */
  constructor(readonly file: string, logger?: HostLogger) {
    this.json = new JsonFile<Content>({
      file,
      label: '工作区记录',
      schema: fileSchema,
      empty: { workspaces: [] },
      invalid: 'set-aside',
      encode: content => ({ ...content.port === undefined ? {} : { port: content.port }, workspaces: content.workspaces }),
      ...logger === undefined ? {} : { logger },
    })
  }

  /** @returns every record, oldest first. */
  list(): readonly WorkspaceRecord[] {
    return this.json.value.workspaces
  }

  /**
   * @param id - workspace id.
   * @returns the record, or undefined.
   */
  get(id: string): WorkspaceRecord | undefined {
    return this.list().find(record => record.id === id)
  }

  /**
   * The workspace whose directory is or contains a canonical path.
   * @param path - canonical absolute path.
   * @returns the record, or undefined.
   */
  containing(path: string): WorkspaceRecord | undefined {
    return this.list().find(record => record.path === path || within(record.path, path))
  }

  /** @returns the port the proxy last listened on. */
  port(): number | undefined {
    return this.json.value.port
  }

  /**
   * Remember the port the proxy listens on.
   * @param port - TCP port.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  setPort(port: number): Promise<void> {
    return this.json.update(current => ({ value: { ...current, port }, result: undefined }))
  }

  /**
   * Add a record.
   * @param record - the new workspace.
   * @throws {RepoError} `unavailable` when the file cannot be written; the record is not kept then.
   */
  add(record: WorkspaceRecord): Promise<void> {
    return this.json.update(current => ({ value: { ...current, workspaces: [...current.workspaces, record] }, result: undefined }))
  }

  /**
   * Forget records.
   * @param ids - workspace ids.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  remove(ids: readonly string[]): Promise<void> {
    return this.json.update(current => ({ value: { ...current, workspaces: current.workspaces.filter(record => !ids.includes(record.id)) }, result: undefined }))
  }
}
