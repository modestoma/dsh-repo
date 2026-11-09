/**
 * The plugin's JSON files: each is read once at start, validated, and
 * changed only through {@link JsonFile.update}, which runs one change at a
 * time and replaces the file atomically before the new value is kept.
 *
 * @module dsh-repo/files
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { z } from 'zod'
import { RepoError } from './errors.ts'
import type { HostLogger } from './host.ts'

/**
 * Write a value as JSON to a temporary file next to `file`, readable only by
 * the owner, then rename it over `file`, so a reader sees the old or the new
 * content and never a partial one.
 * @param file - absolute destination path; its directory is created when missing.
 * @param value - JSON-serializable content.
 * @throws the file system error when any step fails.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, file)
}

/** How a {@link JsonFile} is read and written. */
export interface JsonFileOptions<T> {
  /** Absolute path. */
  readonly file: string
  /** What the file is, for messages, e.g. `PR/MR 跟踪记录`. */
  readonly label: string
  /** Validates the parsed JSON and yields the value. */
  readonly schema: z.ZodType<T>
  /** Value of a missing file, and of a set-aside one. */
  readonly empty: T
  /**
   * What happens to a file that cannot be read, is not JSON, or fails the schema:
   * `fail` throws from the constructor, so the plugin does not start on a
   * settings file it would overwrite; `set-aside` renames it to
   * `<file>.invalid-<time>`, reports it, and starts from {@link empty}.
   */
  readonly invalid: 'fail' | 'set-aside'
  /** Adjusts the parsed JSON in place before validation; returns notes to report. */
  readonly prepare?: (raw: unknown) => readonly string[]
  /** JSON to write for a value; default: the value itself. */
  readonly encode?: (value: T) => unknown
  readonly logger?: HostLogger
}

/** One JSON file and its current value. */
export class JsonFile<T> {
  /** Absolute path. */
  readonly file: string
  private current: T
  /** Tail of the queue that runs changes one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Read the file.
   * @param options - path, schema, and handling of an invalid file.
   * @throws when the file is invalid and {@link JsonFileOptions.invalid} is `fail`.
   */
  constructor(private readonly options: JsonFileOptions<T>) {
    this.file = options.file
    this.current = this.read()
  }

  /** @returns the value last read or written. */
  get value(): T {
    return this.current
  }

  /**
   * Change the value and write it. `change` sees the value after every change
   * queued before it; the value changes only once the file is written.
   * @param change - returns the new value and the caller's result; throwing changes nothing.
   * @returns the result of `change`.
   * @throws {RepoError} `unavailable` when the file cannot be written; whatever `change` throws.
   */
  update<R>(change: (current: T) => { readonly value: T; readonly result: R } | Promise<{ readonly value: T; readonly result: R }>): Promise<R> {
    const run = this.queue.then(async () => {
      const { value, result } = await change(this.current)
      try {
        await writeJsonAtomic(this.file, this.options.encode === undefined ? value : this.options.encode(value))
      } catch (error) {
        throw new RepoError('unavailable', `无法写入${this.options.label} ${this.file}：${error instanceof Error ? error.message : String(error)}`)
      }
      this.current = value
      return result
    })
    // The queue only orders changes; callers observe the failure through `run`.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private read(): T {
    const { file, label, logger } = this.options
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.options.empty
      return this.invalid(`无法读取：${error instanceof Error ? error.message : String(error)}`, false)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return this.invalid(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, true)
    }
    for (const note of this.options.prepare?.(raw) ?? []) logger?.warn?.(`dsh-repo: ${label} ${file}：${note}`)
    const parsed = this.options.schema.safeParse(raw)
    if (parsed.success) return parsed.data
    return this.invalid(`内容不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`, true)
  }

  /** Fail, or set the file aside (when it exists) and start empty. */
  private invalid(reason: string, exists: boolean): T {
    const { file, label, logger } = this.options
    if (this.options.invalid === 'fail') throw new Error(`dsh-repo ${label} ${file} ${reason}`)
    if (!exists) {
      logger?.warn?.(`dsh-repo: ${label} ${file} ${reason}，本次从空开始，保存时会覆盖它`)
      return this.options.empty
    }
    const aside = `${file}.invalid-${Date.now()}`
    try {
      renameSync(file, aside)
      logger?.warn?.(`dsh-repo: ${label} ${file} ${reason}，已移到 ${aside}，从空开始`)
    } catch (error) {
      logger?.warn?.(`dsh-repo: ${label} ${file} ${reason}，也无法移开（${error instanceof Error ? error.message : String(error)}），从空开始，保存时会覆盖它`)
    }
    return this.options.empty
  }
}
