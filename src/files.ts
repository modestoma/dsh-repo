/**
 * Atomic replacement of the plugin's JSON files.
 *
 * @module dsh-repo/files
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
