import { vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SETTINGS, resolveConfig, resolveSettings, settingsOverrides } from '../src/config.ts'
import type { RepoConfig, RepoSettings } from '../src/config.ts'
import type { HostCredentials } from '../src/host.ts'
import { SettingsStore } from '../src/settings/store.ts'
import { runGit } from '../src/mirror/git.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import type { MirrorLimits } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import type { CatalogEntry } from '../src/catalog/entry.ts'
import type { RepoAccess } from '../src/contract.ts'

/** One recorded request. */
export interface Recorded {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }
type Route = { method: string; path: RegExp | string; reply: Reply | ((request: Recorded) => Reply) }

/**
 * Replace global `fetch` with a router; Octokit and GitBeaker both call it.
 * Unmatched requests answer 599 so a missing route fails loudly.
 */
export function fakeHttp(routes: Route[]): { requests: Recorded[] } {
  const requests: Recorded[] = []
  vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const text = request.body === null ? '' : await request.text()
    let body: unknown = text
    try { body = text === '' ? undefined : JSON.parse(text) } catch { /* Non-JSON body stays text. */ }
    const recorded: Recorded = { method: request.method, url: new URL(request.url), headers: request.headers, body }
    requests.push(recorded)
    const pathWithQuery = recorded.url.pathname
    const route = routes.find(candidate => candidate.method === request.method
      && (typeof candidate.path === 'string' ? candidate.path === pathWithQuery : candidate.path.test(pathWithQuery)))
    const reply = route === undefined
      ? { status: 599, body: { message: `no route for ${request.method} ${recorded.url.href}` } }
      : typeof route.reply === 'function' ? route.reply(recorded) : route.reply
    const status = reply.status ?? 200
    const isText = typeof reply.body === 'string'
    return new Response(status === 204 ? null : isText ? reply.body as string : JSON.stringify(reply.body ?? {}), {
      status,
      headers: { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...reply.headers },
    })
  })
  return { requests }
}

/** In-memory credential store seeded with fixed values. */
export function credentials(values: Record<string, string>): HostCredentials & { readonly values: Record<string, string> } {
  const store = { ...values }
  return {
    values: store,
    resolve: async ref => store[ref] === undefined ? undefined : { value: store[ref], source: 'file' },
    describe: async ref => ({ configured: store[ref] !== undefined, ...store[ref] === undefined ? {} : { source: 'file' }, writable: true }),
    set: async (ref, value) => { store[ref] = value },
    unset: async (ref) => { delete store[ref] },
  }
}

/** Host repositories the provider and tool tests address, each in the default test catalog. */
export const TEST_REPOS: readonly string[] = [
  'https://github.com/a/b',
  'https://github.com/a/lib',
  'https://github.com/other/repo',
  'https://github.com/modestoma/dsh-repo',
  'https://github.com/modestoma/app',
  'https://github.com/team/github',
  'https://github.com/team/.github',
  'https://ghe.example.com/platform/api',
  'https://ghe.example.com/a/b',
  'https://code.example.com/gitlab/team/backend/orders',
  'https://code.example.com/gitlab/team/app',
]

/**
 * Catalog entries for addresses, all with one access level.
 * @param urls - repository addresses.
 * @param access - access of every entry.
 * @returns the entries with distinct ids.
 */
export function catalogEntries(urls: readonly string[], access: RepoAccess = 'merge'): CatalogEntry[] {
  return urls.map((url, index) => ({ id: index.toString(16).padStart(12, '0'), url, access, features: [], addedAt: '2026-11-09T00:00:00.000Z' }))
}

/**
 * Host store over a configuration whose settings file under `root` starts
 * with `settings` and the catalog `repos` (default: no file, so default
 * settings and an empty catalog).
 */
export function settingsStore(config: RepoConfig, root: string, settings?: RepoSettings, repos?: readonly CatalogEntry[]): SettingsStore {
  const file = join(root, 'hosts.json')
  if (settings !== undefined || repos !== undefined) {
    writeFileSync(file, `${JSON.stringify({ hosts: [], ...repos === undefined ? {} : { repos }, ...settings === undefined ? {} : { settings: settingsOverrides(settings) } })}\n`)
  }
  return new SettingsStore(config.hosts, file)
}

/**
 * Add addresses to a service's catalog.
 * @param service - the service.
 * @param urls - repository addresses.
 * @param access - access of every new entry.
 */
export async function allow(service: RepoService, urls: readonly string[], access: RepoAccess = 'merge'): Promise<void> {
  for (const url of urls) await service.catalog.add({ url, access, features: [] })
}

/** Fixed mirror limits. */
export function mirrorLimits(timeoutMs = 30_000): () => MirrorLimits {
  return () => ({ timeoutMs })
}

/** Service over a configuration, fixed tokens, settings, and catalog (default {@link TEST_REPOS} with `merge` access), with its settings file and mirrors in a fresh directory. */
export function createService(config: RepoConfig, tokens: Record<string, string> = {}, settings: RepoSettings = DEFAULT_SETTINGS, repos: readonly CatalogEntry[] = catalogEntries(TEST_REPOS)): RepoService {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-test-'))
  return new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials(tokens),
    store: settingsStore(config, root, settings, repos),
    mirrorStore: new MirrorStore({ git: runGit, root: join(root, 'mirrors'), limits: mirrorLimits() }),
  })
}

/** Settings with overrides on top of the defaults. */
export function testSettings(overrides: Record<string, unknown> = {}): RepoSettings {
  return resolveSettings(overrides)
}

/** Configuration with a github.com host, a GitHub Enterprise host, and a self-managed GitLab under a path prefix. */
export function testConfig(): RepoConfig {
  return resolveConfig({
    hosts: [
      { kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' },
      { kind: 'github', url: 'https://ghe.example.com', tokenRef: 'GHE_TOKEN' },
      { kind: 'gitlab', url: 'https://code.example.com/gitlab', tokenRef: 'GITLAB_TOKEN' },
    ],
  })
}

export const TOKENS = { GITHUB_TOKEN: 'gh-token', GHE_TOKEN: 'ghe-token', GITLAB_TOKEN: 'gl-token' }
