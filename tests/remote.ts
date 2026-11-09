/**
 * A stand-in remote for tests that run real git: repositories under a
 * temporary directory are addressed as `https://git.test/<path>`, a host the
 * test configuration knows. The git runner rewrites that address with git's
 * own `url.<base>.insteadOf`, to `file://` for reads, or to a smart HTTP
 * server on 127.0.0.1 (`git http-backend`) that also accepts pushes, which
 * the proxy reaches through the substituted `fetch`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { RepoConfig } from '../src/config.ts'
import { resolveConfig } from '../src/config.ts'
import type { GitRunner } from '../src/mirror/git.ts'
import { runGit } from '../src/mirror/git.ts'
import type { Provider } from '../src/providers/types.ts'
import type { ProviderFactory } from '../src/service.ts'

/** Address of the stand-in host. */
export const REMOTE_HOST = 'https://git.test'
/** Credential reference and value of its token. */
export const REMOTE_TOKENS = { GIT_TEST_TOKEN: 'remote-token' }

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

/**
 * Run git as the test author.
 * @param cwd - working directory.
 * @param args - git arguments.
 * @returns trimmed stdout.
 */
export function gitAs(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

/**
 * Configuration whose only host is the stand-in GitLab, plus `extra` hosts.
 * @param extra - further host entries.
 * @returns the resolved configuration.
 */
export function remoteConfig(extra: readonly unknown[] = []): RepoConfig {
  return resolveConfig({ hosts: [{ kind: 'gitlab', url: REMOTE_HOST, tokenRef: 'GIT_TEST_TOKEN' }, ...extra] })
}

/** Repositories of the stand-in host. */
export interface Remote {
  /** Directory holding the repositories at their paths. */
  readonly root: string
  /** git runner that reaches the repositories through {@link REMOTE_HOST}. */
  readonly git: GitRunner
  /**
   * Create a non-bare repository at `path` whose `main` holds `files`.
   * @returns its address, directory, and head commit.
   */
  repo(path: string, files?: Readonly<Record<string, string>>): { url: string; dir: string; commit: string }
}

/**
 * Repositories read through `file://`.
 * @returns the remote.
 */
export function fileRemote(): Remote {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-repo-remote-')))
  return { root, git: rewritingGit(`file://${root}`), repo: (path, files) => createRepo(root, path, files) }
}

function rewritingGit(base: string): GitRunner {
  return async (args, options) => await runGit(['-c', `url.${base}/.insteadOf=${REMOTE_HOST}/`, ...args], options)
}

function createRepo(root: string, path: string, files: Readonly<Record<string, string>> = { 'README.md': 'hello\n' }): { url: string; dir: string; commit: string } {
  const dir = join(root, path)
  mkdirSync(dir, { recursive: true })
  gitAs(dir, 'init', '--quiet', '--initial-branch=main')
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  gitAs(dir, 'add', '.')
  gitAs(dir, 'commit', '--quiet', '-m', 'init')
  return { url: `${REMOTE_HOST}/${path}`, dir, commit: gitAs(dir, 'rev-parse', 'HEAD') }
}

/** One request the HTTP remote answered. */
export interface RemoteRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
}

/** Repositories served over smart HTTP, which also accept pushes. */
export interface HttpRemote extends Remote {
  /** `fetch` that sends {@link REMOTE_HOST} requests to the server. */
  readonly fetch: typeof fetch
  readonly requests: RemoteRequest[]
  /**
   * Create a bare repository at `path` (ending in `.git`) with `main` and `dev` holding one commit.
   * @returns its address, directory, head commit, and the non-bare clone it was made from, for pushes by others.
   */
  bare(path: string): { url: string; dir: string; commit: string; seed: string }
  close(): Promise<void>
}

/**
 * Start a smart HTTP server on 127.0.0.1 for a fresh repository directory.
 * @returns the remote.
 */
export async function httpRemote(): Promise<HttpRemote> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-repo-remote-')))
  const requests: RemoteRequest[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method ?? 'GET', path: url.pathname, authorization: req.headers.authorization })
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'test',
        REMOTE_ADDR: '127.0.0.1',
        ...typeof req.headers['content-encoding'] === 'string' ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {},
        ...typeof req.headers['git-protocol'] === 'string' ? { HTTP_GIT_PROTOCOL: req.headers['git-protocol'] } : {},
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    req.pipe(child.stdin)
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
    child.on('close', () => {
      const output = Buffer.concat(out)
      const end = output.indexOf('\r\n\r\n')
      const headerText = output.subarray(0, end).toString('utf8')
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of headerText.split('\r\n')) {
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        const name = line.slice(0, colon).trim().toLowerCase()
        const value = line.slice(colon + 1).trim()
        if (name === 'status') status = Number.parseInt(value, 10)
        else headers[name] = value
      }
      res.writeHead(status, headers)
      res.end(output.subarray(end + 4))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  const rewrite: typeof fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return await fetch(target.startsWith(`${REMOTE_HOST}/`) ? `${base}/${target.slice(REMOTE_HOST.length + 1)}` : target, init)
  }
  return {
    root,
    git: rewritingGit(base),
    fetch: rewrite,
    requests,
    repo: (path, files) => createRepo(root, path, files),
    bare: (path) => {
      const seed = mkdtempSync(join(tmpdir(), 'dsh-repo-seed-'))
      const { commit } = createRepo(seed, 'work')
      gitAs(join(seed, 'work'), 'branch', 'dev')
      const dir = join(root, path)
      mkdirSync(dirname(dir), { recursive: true })
      gitAs(seed, 'clone', '--quiet', '--bare', join(seed, 'work'), dir)
      return { url: `${REMOTE_HOST}/${path}`, dir, commit, seed: join(seed, 'work') }
    },
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

/**
 * Providers whose every API call fails, except the methods `overrides` gives.
 * @param overrides - implemented provider methods.
 * @returns a factory handing the same provider to every host.
 */
export function stubProviders(overrides: Partial<Provider> = {}): ProviderFactory {
  const provider = new Proxy(overrides, {
    get: (target, name: string) => target[name as keyof Provider] ?? (async () => { throw new Error(`stub provider: ${name} not implemented`) }),
  }) as Provider
  return () => provider
}
