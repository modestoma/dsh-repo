import { vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { RepoConfig } from '../src/config.ts'
import type { HostCredentials } from '../src/host.ts'

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

/** Credentials answering fixed values. */
export function credentials(values: Record<string, string>): HostCredentials {
  return { resolve: async ref => values[ref] === undefined ? undefined : { value: values[ref], source: 'test' } }
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
