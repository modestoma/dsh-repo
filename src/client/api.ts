/**
 * 设置页的同源 HTTP 客户端，请求 Host 半侧注册的 `/dsh-repo/*` 路由。
 *
 * @module dsh-repo/client/api
 */

import { HOST_TOKEN_ROUTE, HOSTS_ROUTE, MIRROR_ROUTE, PICK_DIRECTORY_ROUTE, SETTINGS_ROUTE, STATE_ROUTE } from '../settings/contract.ts'
import type { HostAddRequest, MutationError, MutationOk, PickedDirectory, RepoSettingsWire, SettingsState } from '../settings/contract.ts'

/**
 * Error text of a value thrown by a request.
 * @param error - thrown value.
 * @returns message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetch one Host route. Routes are absolute pathnames, but the browser
 * addresses them relative to the DSH document so a reverse proxy that mounts
 * DSH under a prefix still routes them with its scoped login cookie.
 */
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(route.slice(1), {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init?.body === undefined ? {} : { 'content-type': 'application/json' } },
    })
  } catch (error) {
    throw new Error(`无法连接设置接口：${messageOf(error)}`)
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Non-JSON bodies (proxy errors) are reported by HTTP status below.
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.ok) {
    const error = (body as Partial<MutationError>).error
    throw new Error(typeof error === 'string' && error !== '' ? error : `HTTP ${response.status}`)
  }
  return body as T
}

async function mutate(route: string, method: string, body?: object): Promise<SettingsState> {
  return (await request<MutationOk>(route, { method, ...body === undefined ? {} : { body: JSON.stringify(body) } })).state
}

/** @returns hosts, the mirror directory, and the run-time settings. */
export function fetchState(): Promise<SettingsState> {
  return request<SettingsState>(STATE_ROUTE)
}

/**
 * Add a host, optionally with its token.
 * @param host - kind, address, alias, and token.
 * @returns the new state.
 */
export function addHost(host: HostAddRequest): Promise<SettingsState> {
  return mutate(HOSTS_ROUTE, 'POST', host)
}

/**
 * Remove an added host and its stored token.
 * @param url - host address.
 * @returns the new state.
 */
export function removeHost(url: string): Promise<SettingsState> {
  return mutate(HOSTS_ROUTE, 'DELETE', { url })
}

/**
 * Store a host's token.
 * @param url - host address.
 * @param value - token value.
 * @returns the new state, which reports only whether the token is set.
 */
export function saveHostToken(url: string, value: string): Promise<SettingsState> {
  return mutate(HOST_TOKEN_ROUTE, 'PUT', { url, value })
}

/**
 * Remove a host's stored token.
 * @param url - host address.
 * @returns the new state.
 */
export function clearHostToken(url: string): Promise<SettingsState> {
  return mutate(HOST_TOKEN_ROUTE, 'DELETE', { url })
}

/**
 * Choose the mirror directory.
 * @param dir - absolute directory on the Host.
 * @returns the new state.
 */
export function saveMirrorDir(dir: string): Promise<SettingsState> {
  return mutate(MIRROR_ROUTE, 'PUT', { dir })
}

/** @returns the state after returning to the default mirror directory. */
export function resetMirrorDir(): Promise<SettingsState> {
  return mutate(MIRROR_ROUTE, 'DELETE')
}

/**
 * Save the run-time settings.
 * @param settings - complete settings.
 * @returns the new state.
 */
export function saveSettings(settings: RepoSettingsWire): Promise<SettingsState> {
  return mutate(SETTINGS_ROUTE, 'PUT', settings)
}

/** @returns the state after returning every run-time setting to its default. */
export function resetSettings(): Promise<SettingsState> {
  return mutate(SETTINGS_ROUTE, 'DELETE')
}

/** @returns the directory chosen in the Host's system dialog, or null when cancelled. */
export async function pickDirectory(): Promise<string | null> {
  return (await request<PickedDirectory>(PICK_DIRECTORY_ROUTE, { method: 'POST' })).path
}
