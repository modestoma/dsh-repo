/**
 * Path comparisons for directories the user chooses (local sync directories
 * and the mirror directory), made on real paths so a symbolic link cannot hide
 * an overlap.
 *
 * @module dsh-repo/paths
 */

import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Whether `inner` is `outer` or lies inside it, compared as given.
 * @param outer - absolute path.
 * @param inner - absolute path.
 * @returns whether `inner` is inside `outer`.
 */
export function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * The path with its longest existing ancestor resolved through symbolic links.
 * @param path - absolute path, existing or not.
 * @returns the real path of the existing part joined with the rest.
 * @throws the file system error other than a missing component.
 */
export async function realPathOf(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Whether two directories overlap (one is or contains the other), compared
 * both as given and through their real paths.
 * @param a - absolute directory.
 * @param b - absolute directory.
 * @param real - real paths read beforehand; a missing entry compares the path as given.
 * @returns whether they overlap.
 */
export function overlaps(a: string, b: string, real: ReadonlyMap<string, string>): boolean {
  const ra = real.get(a) ?? a
  const rb = real.get(b) ?? b
  return within(a, b) || within(b, a) || within(ra, rb) || within(rb, ra)
}

/**
 * Whether a path exists, without following a final symbolic link.
 * @param path - absolute path.
 * @returns whether anything is there.
 * @throws the file system error other than a missing path.
 */
export async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * The first of `<parent>/<name>`, `<parent>/<name>-2`, … that does not exist.
 * @param parent - absolute directory.
 * @param name - preferred name.
 * @returns the absolute path.
 */
export async function freeDirectory(parent: string, name: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const candidate = join(parent, index === 1 ? name : `${name}-${index}`)
    if (!await present(candidate)) return candidate
  }
}
