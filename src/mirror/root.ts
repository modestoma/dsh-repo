/**
 * Rules for the mirror directory. There is no default: until one is chosen,
 * every operation that needs a mirror is refused with {@link MIRROR_DIR_UNSET}.
 * A chosen directory must be absolute and must not be, or lie inside, one of
 * the forbidden roots (`$DSH_HOME`, the system temporary directory, and
 * `/tmp`), compared after resolving the symbolic links of the existing part of
 * each path: `$DSH_HOME` is readable by Agents and holds credentials and
 * settings, and the Linux sandbox replaces `/tmp` with an empty directory, so
 * mirrors there would be invisible to sandboxed commands.
 *
 * @module dsh-repo/mirror/root
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { expandHome, resolveDshHome } from '../config.ts'
import { RepoError } from '../errors.ts'

/** The refusal every mirror operation reports while no directory is chosen. */
export const MIRROR_DIR_UNSET = '镜像目录未设置：请到「代码仓库」设置页的「高级」里选择一个目录（不能在 DSH 主目录或 /tmp 下，也不要放在 Agent 可写的目录里）'

/**
 * The roots a mirror directory may not be or lie in: `$DSH_HOME`, the system
 * temporary directory, and `/tmp`.
 * @param env - process environment `$DSH_HOME` is read from.
 * @returns the forbidden roots, without duplicates.
 */
export function forbiddenMirrorRoots(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...new Set([resolveDshHome(env), tmpdir(), '/tmp'])]
}

/**
 * The path with its longest existing ancestor resolved through symbolic links.
 * @param path - absolute path, existing or not.
 * @returns the real path of the existing part joined with the rest.
 */
export function realPathSyncOf(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
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

/** Whether `inner` is `outer` or lies inside it; a child whose name merely starts with `..` still lies inside. */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Validate a mirror directory choice.
 * @param dir - absolute directory, or `~`-prefixed path.
 * @param forbidden - roots the directory may not be or lie in; see {@link forbiddenMirrorRoots}.
 * @returns the absolute directory with `~` expanded.
 * @throws {RepoError} `invalid` when the path is empty, relative, contains control characters, or is or lies inside a forbidden root (also through a symbolic link).
 */
export function checkMirrorDir(dir: string, forbidden: readonly string[]): string {
  const trimmed = dir.trim()
  if (trimmed === '' || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new RepoError('invalid', '镜像目录不能为空或包含控制字符')
  if (!isAbsolute(trimmed) && trimmed !== '~' && !trimmed.startsWith('~/')) throw new RepoError('invalid', `镜像目录必须是绝对路径：${trimmed}`)
  const target = expandHome(trimmed)
  const real = realPathSyncOf(target)
  for (const root of forbidden) {
    const realRoot = realPathSyncOf(root)
    if (within(root, target) || within(realRoot, real)) throw new RepoError('invalid', `镜像目录不能是 ${root} 或它下面的目录：${target}`)
  }
  return target
}
