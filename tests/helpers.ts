import { vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../src/config.ts'
import type { RepoConfig } from '../src/config.ts'
import type { HostCredentials } from '../src/host.ts'
import { HostStore } from '../src/hosts.ts'
import { runGit } from '../src/mirror/git.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { WorkspaceStore } from '../src/mirror/workspace.ts'
import type { GitRunner } from '../src/mirror/git.ts'
import { RepoService } from '../src/service.ts'

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

/**
 * Service over a configuration, fixed tokens, an added-hosts file and mirror
 * root under `root` (default: a path that does not exist).
 */
export function createService(config: RepoConfig, tokens: Record<string, string> = {}, root = join(tmpdir(), 'dsh-repo-test-missing')): RepoService {
  return new RepoService(config, {
    credentials: credentials(tokens),
    hosts: new HostStore(config.hosts, join(root, 'hosts.json')),
    ...withMirrors(new MirrorStore({ git: runGit, root: join(root, 'mirrors'), timeoutMs: 30_000, maxFileBytes: config.limits.maxFileBytes, maxTreeEntries: config.limits.maxTreeEntries })),
  })
}

/** Service dependencies over a mirror store: the store and workspaces on it. */
export function withMirrors(mirrors: MirrorStore, git: GitRunner = runGit, maxDiffBytes = 4096): { mirrors: MirrorStore; workspaces: WorkspaceStore } {
  return { mirrors, workspaces: new WorkspaceStore({ git, mirrors, timeoutMs: 30_000, maxDiffBytes }) }
}

/** Configuration with a github.com host, a GitHub Enterprise host, and a self-managed GitLab under a path prefix. */
export function testConfig(overrides: Record<string, unknown> = {}): RepoConfig {
  return resolveConfig({
    hosts: [
      { kind: 'github', url: 'https://github.com', tokenRef: 'GITHUB_TOKEN' },
      { kind: 'github', url: 'https://ghe.example.com', tokenRef: 'GHE_TOKEN' },
      { kind: 'gitlab', url: 'https://code.example.com/gitlab', tokenRef: 'GITLAB_TOKEN' },
    ],
    ...overrides,
  })
}

export const TOKENS = { GITHUB_TOKEN: 'gh-token', GHE_TOKEN: 'ghe-token', GITLAB_TOKEN: 'gl-token' }
