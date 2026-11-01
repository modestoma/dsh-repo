/**
 * Disk usage of the mirror directory: each mirror, the snapshots, and
 * everything else, measured from the files' allocated blocks without
 * following symbolic links.
 *
 * @module dsh-repo/mirror/usage
 */

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { MirrorUsage, MirrorUsageEntry } from '../settings/contract.ts'

/** Deepest directory level searched for mirrors (`<host>/<group>/…/<repo>`). */
const MAX_DEPTH = 12

/** Reads a mirror's `origin` address; undefined when it has none. */
export type OriginReader = (mirrorDir: string) => Promise<string | undefined>

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Allocated size of one entry: its blocks where the platform reports them, otherwise its length. */
function sizeOf(info: { readonly blocks: number; readonly size: number }): number {
  return Number.isFinite(info.blocks) && info.blocks > 0 ? info.blocks * 512 : info.size
}

/**
 * Total size of a file or directory tree; entries that disappear while it
 * is read count as zero.
 * @param path - absolute path.
 * @returns bytes.
 */
export async function treeSize(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
  if (!info.isDirectory()) return sizeOf(info)
  let total = sizeOf(info)
  let names: string[]
  try {
    names = await readdir(path)
  } catch (error) {
    if (isMissing(error)) return total
    throw error
  }
  for (const name of names) total += await treeSize(join(path, name))
  return total
}

/** The address without user name, password, query, or fragment. */
function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return url
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    // A local path has nothing to remove.
    return url
  }
}

async function lastFetch(dir: string): Promise<string | undefined> {
  for (const name of ['FETCH_HEAD', 'HEAD']) {
    try {
      return (await lstat(join(dir, '.git', name))).mtime.toISOString()
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return undefined
}

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    return (await lstat(join(dir, '.git'))).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Measure the mirror directory. A directory holding `.git` is one mirror;
 * `.snapshots` counts as snapshots; unfinished clones (`*.partial-*`) and
 * files count as other.
 * @param root - absolute mirror directory; a missing one measures empty.
 * @param origin - reads each mirror's address.
 * @returns the mirrors, largest first, and the totals.
 */
export async function measureMirrors(root: string, origin: OriginReader): Promise<MirrorUsage> {
  const mirrors: MirrorUsageEntry[] = []
  let snapshotBytes = 0
  let otherBytes = 0
  const visit = async (dir: string, segments: readonly string[]): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    for (const name of names.sort()) {
      const path = join(dir, name)
      if (segments.length === 0 && name === '.snapshots') {
        snapshotBytes += await treeSize(path)
        continue
      }
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (!info.isDirectory() || name.includes('.partial-')) {
        otherBytes += await treeSize(path)
        continue
      }
      const rel = [...segments, name]
      if (await hasGitDir(path)) {
        const url = await origin(path)
        const fetchedAt = await lastFetch(path)
        mirrors.push({ path: rel.join('/'), ...url === undefined ? {} : { url: withoutCredentials(url) }, bytes: await treeSize(path), ...fetchedAt === undefined ? {} : { fetchedAt } })
      } else if (rel.length < MAX_DEPTH) {
        otherBytes += sizeOf(info)
        await visit(path, rel)
      } else {
        otherBytes += await treeSize(path)
      }
    }
  }
  await visit(root, [])
  mirrors.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
  const totalBytes = mirrors.reduce((sum, entry) => sum + entry.bytes, snapshotBytes + otherBytes)
  return { ok: true, root, mirrors, snapshotBytes, otherBytes, totalBytes }
}
