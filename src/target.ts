/**
 * Repository targets: map a URL or `host/path` to a configured host and a
 * repository path, and apply the configured repository patterns.
 *
 * @module dsh-repo/target
 */

import type { RepoRef } from './contract.ts'
import type { HostSpec } from './config.ts'
import { RepoError } from './errors.ts'

const SEGMENT = /^[A-Za-z0-9._-]+$/
const SCP_LIKE = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/

/** A target resolved to its host. */
export interface ResolvedTarget extends RepoRef {
  readonly spec: HostSpec
}

interface ParsedTarget {
  /** Lowercase host, with port only for HTTP(S) addresses. */
  readonly host: string
  /** Whether the address was HTTP(S) or bare, so the host's port and path prefix apply. */
  readonly web: boolean
  readonly pathname: string
}

function parse(input: string): ParsedTarget | undefined {
  const value = input.trim()
  if (value === '' || /\s/.test(value)) return undefined
  const scp = SCP_LIKE.exec(value)
  if (scp !== null) return { host: (scp[1] ?? '').toLowerCase(), web: false, pathname: `/${scp[2] ?? ''}` }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    // Neither a URL nor host/path.
    return undefined
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return { host: url.host.toLowerCase(), web: true, pathname: decodeURIComponent(url.pathname) }
  if (url.protocol === 'ssh:' || url.protocol === 'git:') return { host: url.hostname.toLowerCase(), web: false, pathname: decodeURIComponent(url.pathname) }
  return undefined
}

function repoPath(kind: HostSpec['kind'], rest: string): string | undefined {
  let segments = rest.replace(/\.git$/, '').split('/').filter(segment => segment !== '')
  if (kind === 'github') {
    segments = segments.slice(0, 2)
    if (segments.length !== 2) return undefined
  } else {
    const marker = segments.indexOf('-')
    if (marker >= 0) segments = segments.slice(0, marker)
    if (segments.length < 2) return undefined
  }
  if (segments.at(-1)?.endsWith('.git') === true) segments[segments.length - 1] = segments.at(-1)!.slice(0, -4)
  return segments.every(segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..') ? segments.join('/') : undefined
}

/**
 * Whether a repository key matches one configured pattern.
 * @param key - lowercase `host/path`.
 * @param pattern - lowercase pattern; a final `*` matches one segment, `**` one or more.
 * @returns whether it matches.
 */
export function matchesPattern(key: string, pattern: string): boolean {
  const keySegments = key.split('/')
  const patternSegments = pattern.split('/')
  const last = patternSegments.at(-1)
  if (last === '**') {
    const prefix = patternSegments.slice(0, -1)
    return keySegments.length > prefix.length && prefix.every((segment, index) => segment === keySegments[index])
  }
  if (keySegments.length !== patternSegments.length) return false
  return patternSegments.every((segment, index) => segment === '*' ? index === patternSegments.length - 1 : segment === keySegments[index])
}

/**
 * Resolve a repository target.
 * @param input - URL or `host/path`.
 * @param hosts - configured hosts.
 * @param patterns - configured repository patterns; empty allows every repository on the hosts.
 * @returns the host and repository path.
 * @throws {RepoError} `invalid` for an unreadable target, `not-allowed` when no host or pattern admits it.
 */
export function resolveTarget(input: string, hosts: readonly HostSpec[], patterns: readonly string[]): ResolvedTarget {
  const parsed = parse(input)
  if (parsed === undefined) throw new RepoError('invalid', `无法识别的仓库：${input}（填仓库网址、git 地址或 主机/路径）`)
  let best: { spec: HostSpec; rest: string; prefix: number } | undefined
  for (const spec of hosts) {
    const url = new URL(spec.url)
    const prefix = url.pathname.replace(/\/+$/, '')
    if (parsed.web) {
      if (url.host !== parsed.host) continue
      if (prefix !== '' && parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.prefix) best = { spec, rest: parsed.pathname.slice(prefix.length), prefix: prefix.length }
    } else if (url.hostname === parsed.host && best === undefined) {
      best = { spec, rest: parsed.pathname, prefix: 0 }
    }
  }
  if (best === undefined) throw new RepoError('not-allowed', `没有为 ${parsed.host} 配置主机，dsh-repo 不能访问 ${input}`)
  const path = repoPath(best.spec.kind, best.rest)
  if (path === undefined) {
    throw new RepoError('invalid', best.spec.kind === 'github' ? `GitHub 仓库路径应为 owner/name：${input}` : `GitLab 仓库路径应为 group/project（可有多级 group）：${input}`)
  }
  const host = new URL(best.spec.url).host
  const key = `${host}/${path}`.toLowerCase()
  if (patterns.length > 0 && !patterns.some(pattern => matchesPattern(key, pattern))) {
    throw new RepoError('not-allowed', `${host}/${path} 不在 dsh-repo 配置的仓库范围内`)
  }
  return { spec: best.spec, kind: best.spec.kind, host, path, webUrl: `${best.spec.url}/${path}` }
}
