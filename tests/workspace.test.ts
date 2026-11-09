/**
 * Workspaces end to end: a local bare repository stands in for the remote, the
 * proxy listens on 127.0.0.1, and plain git in the workspace goes through it.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizeEvent } from '../src/contract.ts'
import { runGit } from '../src/mirror/git.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { WorkspaceManager } from '../src/workspace/manager.ts'
import type { WorkspaceGit } from '../src/workspace/manager.ts'
import { GitProxy } from '../src/workspace/proxy.ts'
import { WorkspaceRegistry } from '../src/workspace/registry.ts'
import { catalogEntries, credentials, hostStore, mirrorLimits, testConfig, testSettings } from './helpers.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const TIMEOUT = 30_000
const execFileAsync = promisify(execFile)

/**
 * Run git as a user would, without the test author unless the workspace sets
 * one. Asynchronous: the proxy answers from this process's event loop.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' })
  return stdout.trim()
}

function gitAs(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

/** git that may fail, with its exit code and combined output. */
async function tryGit(cwd: string, ...args: string[]): Promise<{ status: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' })
    return { status: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { status: typeof failed.code === 'number' ? failed.code : -1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

/** A bare repository with `main` and `dev` holding one commit. */
function upstream(root: string): { bare: string; commit: string } {
  const work = join(root, 'seed')
  mkdirSync(work)
  gitAs(work, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(work, 'README.md'), 'hello\n')
  gitAs(work, 'add', '.')
  gitAs(work, 'commit', '--quiet', '-m', 'init')
  gitAs(work, 'branch', 'dev')
  const bare = join(root, 'upstream.git')
  gitAs(root, 'clone', '--quiet', '--bare', work, bare)
  return { bare, commit: gitAs(work, 'rev-parse', 'HEAD') }
}

const proxies: GitProxy[] = []

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.stop()
})

async function setup(options: { parallel?: (name: string, ...args: unknown[]) => Promise<void> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-repo-ws-')))
  const { bare, commit } = upstream(root)
  const service = new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials({}),
    hosts: hostStore(testConfig(), root, testSettings(), catalogEntries([bare], 'write')),
    mirrors: new MirrorStore({ git: runGit, root: join(root, 'mirrors'), limits: mirrorLimits() }),
  })
  const registry = new WorkspaceRegistry(join(root, 'workspaces.json'))
  const pushed: string[][] = []
  const proxy = new GitProxy({
    service,
    registry,
    ...options.parallel === undefined ? {} : { parallel: options.parallel },
    onPushed: (_record, branches) => { pushed.push([...branches]) },
  })
  proxies.push(proxy)
  await proxy.start(0)
  const workspaceGit: WorkspaceGit = async (dir, args, runOptions) => await runGit(args, { cwd: dir, ...runOptions })
  const manager = new WorkspaceManager({ service, registry, git: runGit, workspaceGit, proxy: () => proxy.port === undefined ? undefined : { port: proxy.port } })
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  return { root, bare, commit, service, registry, proxy, manager, pushed, sessions }
}

describe('workspace creation', () => {
  it('clones a catalog repository on a new branch whose origin goes through the proxy with the workspace secret', async () => {
    const { bare, commit, manager, registry, proxy, sessions, root } = await setup()
    const path = join(sessions, 'app')
    const info = await manager.create({ repo: bare, path, session: 'Sess-1234567890' })
    expect(info).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), repo: bare, path, base: 'main', baseCommit: commit, branch: 'dsh/sess1234', session: 'Sess-1234567890', createdAt: expect.any(String) })
    expect(info).not.toHaveProperty('secret')
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('hello\n')
    expect(await git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('dsh/sess1234')
    expect(await git(path, 'config', 'remote.origin.url')).toBe(bare)
    expect(await git(path, 'config', `url.http://127.0.0.1:${proxy.port}/w/${info.id}/repo.git.insteadOf`)).toBe(bare)
    expect(await git(path, 'config', `branch.dsh/sess1234.merge`)).toBe('refs/heads/dsh/sess1234')
    expect(existsSync(join(path, '.git', 'objects', 'info', 'alternates'))).toBe(true)
    const record = registry.get(info.id)!
    expect(record.secret).toMatch(/^[0-9a-f]{48}$/)
    expect(await git(path, 'config', '--get-all', `credential.http://127.0.0.1:${proxy.port}.helper`)).toContain(record.secret)
    expect(statSync(join(root, 'workspaces.json')).mode & 0o777).toBe(0o600)
    // The secret stays out of the remote URL the model sees.
    expect(await git(path, 'remote', '-v')).not.toContain(record.secret)
  })

  it('starts from a commit on the base, or continues an existing branch, and refuses unusable branches and directories', async () => {
    const { bare, commit, manager, sessions, root } = await setup()
    const seed = join(root, 'seed')
    writeFileSync(join(seed, 'next.txt'), 'next\n')
    gitAs(seed, 'add', '.')
    gitAs(seed, 'commit', '--quiet', '-m', 'next')
    gitAs(seed, 'push', '--quiet', bare, 'main')
    const head = gitAs(seed, 'rev-parse', 'HEAD')
    const older = await manager.create({ repo: bare, path: join(sessions, 'older'), commit, branch: 'fix/older' })
    expect(older).toMatchObject({ base: 'main', baseCommit: commit, branch: 'fix/older' })
    expect(existsSync(join(sessions, 'older', 'next.txt'))).toBe(false)
    gitAs(seed, 'push', '--quiet', bare, 'HEAD:refs/heads/feature/x')
    const continued = await manager.create({ repo: bare, path: join(sessions, 'continued'), branch: 'feature/x', base: 'dev' })
    expect(continued).toMatchObject({ base: 'dev', baseCommit: head, branch: 'feature/x' })
    await expect(manager.create({ repo: bare, path: join(sessions, 'a'), branch: 'feature/x', commit })).rejects.toMatchObject({ code: 'invalid' })
    await expect(manager.create({ repo: bare, path: join(sessions, 'b'), branch: 'main' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('默认分支') })
    await expect(manager.create({ repo: bare, path: join(sessions, 'c'), base: 'dev', branch: 'dev' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('合入目标') })
    await expect(manager.create({ repo: bare, path: join(sessions, 'd'), base: 'dev', commit: head })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('不在分支 dev 上') })
    await expect(manager.create({ repo: bare, path: join(sessions, 'older'), branch: 'x' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('不是空目录') })
    await expect(manager.create({ repo: bare, path: join(sessions, 'older', 'inner'), branch: 'x' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(manager.create({ repo: bare, path: 'relative', branch: 'x' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(manager.create({ repo: join(root, 'elsewhere.git'), path: join(sessions, 'e') })).rejects.toMatchObject({ code: 'not-allowed' })
    expect(existsSync(join(sessions, 'b'))).toBe(false)
  })

  it('does not take a branch below the requested name for the requested branch', async () => {
    const { bare, commit, manager, sessions, root } = await setup()
    const seed = join(root, 'seed')
    writeFileSync(join(seed, 'other.txt'), 'other\n')
    gitAs(seed, 'add', '.')
    gitAs(seed, 'commit', '--quiet', '-m', 'other')
    gitAs(seed, 'push', '--quiet', bare, 'HEAD:refs/heads/fix/sub')
    const info = await manager.create({ repo: bare, path: join(sessions, 'app'), branch: 'fix' })
    expect(info).toMatchObject({ branch: 'fix', baseCommit: commit })
    expect(existsSync(join(sessions, 'app', 'other.txt'))).toBe(false)
  })

  it('creates one workspace when two calls target the same directory, leaving the winner intact', async () => {
    const { bare, manager, sessions } = await setup()
    const path = join(sessions, 'app')
    const outcomes = await Promise.allSettled([manager.create({ repo: bare, path, branch: 'fix/a' }), manager.create({ repo: bare, path, branch: 'fix/b' })])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect((await manager.locate(path)).path).toBe(path)
  })

  it('refuses to create a workspace while the proxy is stopped', async () => {
    const { bare, proxy, manager, sessions } = await setup()
    await proxy.stop()
    await expect(manager.create({ repo: bare, path: join(sessions, 'x') })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('代理') })
  })
})

describe('plain git through the proxy', () => {
  it('fetches and pushes the workspace branch, records the Session in commits, and refuses the default branch and deletions', async () => {
    const events: AuthorizeEvent[] = []
    const { bare, manager, sessions, pushed, root } = await setup({ parallel: async (_name, event) => { events.push(event as AuthorizeEvent) } })
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, session: 's1', branch: 'fix/a' })
    await git(path, 'config', 'user.name', 'Dev')
    await git(path, 'config', 'user.email', 'dev@example.com')
    writeFileSync(join(path, 'a.txt'), 'a\n')
    await git(path, 'add', '.')
    await git(path, 'commit', '--quiet', '-m', 'feat: a')
    expect(await git(path, 'log', '-1', '--format=%B')).toBe('feat: a\n\nDSH-Session: s1')
    await git(path, 'push', '--quiet', 'origin', 'HEAD')
    expect(gitAs(bare, 'rev-parse', 'fix/a')).toBe(await git(path, 'rev-parse', 'HEAD'))
    expect(pushed).toEqual([['fix/a']])
    expect(events).toEqual([{ session: 's1', level: 'code-write', action: 'git-push', summary: expect.stringContaining('fix/a') }])

    // Someone else pushes to the same branch: a plain fetch through the proxy sees it.
    const seed = join(root, 'seed')
    gitAs(seed, 'fetch', '--quiet', bare, 'fix/a')
    gitAs(seed, 'checkout', '--quiet', '-B', 'fix/a', 'FETCH_HEAD')
    writeFileSync(join(seed, 'b.txt'), 'b\n')
    gitAs(seed, 'add', '.')
    gitAs(seed, 'commit', '--quiet', '-m', 'theirs')
    gitAs(seed, 'push', '--quiet', bare, 'fix/a')
    await git(path, 'pull', '--quiet', '--rebase')
    expect(existsSync(join(path, 'b.txt'))).toBe(true)

    const main = await tryGit(path, 'push', 'origin', 'HEAD:main')
    expect(main.status).not.toBe(0)
    expect(main.output).toContain('dsh-repo')
    const deletion = await tryGit(path, 'push', 'origin', ':fix/a')
    expect(deletion.status).not.toBe(0)
    expect(deletion.output).toContain('dsh-repo')
    const tag = await tryGit(path, 'push', 'origin', 'HEAD:refs/tags/v1')
    expect(tag.status).not.toBe(0)
    expect(gitAs(bare, 'rev-parse', 'main')).not.toBe(await git(path, 'rev-parse', 'HEAD'))
  })

  it('asks the remote for its default branch instead of trusting the mirror', async () => {
    const { bare, manager, sessions } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    gitAs(bare, 'symbolic-ref', 'HEAD', 'refs/heads/dev')
    writeFileSync(join(path, 'a.txt'), 'a\n')
    await git(path, 'add', '.')
    await git(path, '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '--quiet', '-m', 'a')
    const refused = await tryGit(path, 'push', 'origin', 'HEAD:dev')
    expect(refused.status).not.toBe(0)
    expect(refused.output).toContain('默认分支 dev')
    expect(gitAs(bare, 'rev-parse', 'dev')).not.toBe(await git(path, 'rev-parse', 'HEAD'))
  })

  it('refuses a push the access/authorize listeners reject, and requests without the workspace secret', async () => {
    const { bare, manager, sessions, proxy, registry } = await setup({ parallel: async () => { throw new AggregateError([new Error('没有改代码权限')]) } })
    const path = join(sessions, 'app')
    const info = await manager.create({ repo: bare, path, session: 's1', branch: 'fix/a' })
    writeFileSync(join(path, 'a.txt'), 'a\n')
    await git(path, 'add', '.')
    await git(path, '-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '--quiet', '-m', 'a')
    const refused = await tryGit(path, 'push', 'origin', 'HEAD')
    expect(refused.status).not.toBe(0)
    expect(refused.output).toContain('没有改代码权限')
    expect((await tryGit(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/fix/a')).status).not.toBe(0)

    const base = `http://127.0.0.1:${proxy.port}/w/${info.id}/repo.git/info/refs?service=git-upload-pack`
    expect((await fetch(base)).status).toBe(401)
    const wrong = await fetch(base, { headers: { authorization: `Basic ${Buffer.from('dsh:wrong').toString('base64')}` } })
    expect(wrong.status).toBe(401)
    const right = await fetch(base, { headers: { authorization: `Basic ${Buffer.from(`dsh:${registry.get(info.id)!.secret}`).toString('base64')}` } })
    expect(right.status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${proxy.port}/w/ffffffffffffffff/repo.git/info/refs?service=git-upload-pack`)).status).toBe(404)
  })

  it('points every workspace at a new proxy port', async () => {
    const { bare, manager, sessions, proxy } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    const previous = proxy.port!
    const port = await proxy.start(0)
    await manager.moveProxy(port, previous)
    expect(await git(path, 'config', '--get-regexp', '^url\\.')).not.toContain(`:${previous}/`)
    expect((await tryGit(path, 'fetch', '--quiet', 'origin')).status).toBe(0)
  })
})

describe('workspace status, push, and removal', () => {
  it('reports changes against the start commit without touching the index', async () => {
    const { bare, manager, sessions } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    writeFileSync(join(path, 'README.md'), 'hello\nworld\n')
    writeFileSync(join(path, 'new.txt'), 'new\n')
    const record = await manager.locate(join(path))
    const status = await manager.status(record, undefined, 4096, TIMEOUT)
    expect(status).toMatchObject({ currentBranch: 'fix/a', commits: [], unpushed: 0, uncommitted: true, truncated: false })
    expect(status.files).toEqual([
      { path: 'README.md', status: 'modified', binary: false, additions: 1, deletions: 0 },
      { path: 'new.txt', status: 'added', binary: false, additions: 1, deletions: 0 },
    ])
    expect(status.diff).toContain('+world')
    expect(await git(path, 'status', '--porcelain')).toBe('M README.md\n?? new.txt')
    expect((await manager.status(record, undefined, 10, TIMEOUT)).truncated).toBe(true)
  })

  it('commits with the given identities and trailers, pushes to a new branch, then fast-forwards it', async () => {
    const { bare, commit, manager, sessions, pushed } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, session: 's1', branch: 'fix/a' })
    const record = await manager.locate(path)
    await expect(manager.push(record, {}, TIMEOUT)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('没有改动') })
    writeFileSync(join(path, 'a.txt'), 'a\n')
    await expect(manager.push(record, {}, TIMEOUT)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('提交说明') })
    const author = { name: '张三', email: 'zhang@example.com' }
    const committer = { name: 'bot', email: 'bot@example.com' }
    const first = await manager.push(record, { message: 'fix: a', author, committer, session: 's1', trailers: [{ token: 'Feishu-User', value: '张三 <u_1>' }] }, TIMEOUT)
    expect(first).toEqual({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), committed: true, author, created: true })
    expect(gitAs(bare, 'rev-parse', 'fix/a')).toBe(first.commit)
    expect(gitAs(bare, 'rev-parse', 'fix/a^')).toBe(commit)
    expect(gitAs(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B', 'fix/a').trim()).toBe('张三 <zhang@example.com>|bot <bot@example.com>|fix: a\n\nDSH-Session: s1\nFeishu-User: 张三 <u_1>')
    expect(pushed).toEqual([['fix/a']])

    expect(await manager.push(record, {}, TIMEOUT)).toEqual({ commit: first.commit, committed: false, created: false })
    writeFileSync(join(path, 'b.txt'), 'b\n')
    const second = await manager.push(record, { message: 'feat: b', committer }, TIMEOUT)
    expect(second).toMatchObject({ committed: true, created: false, author: committer })
    expect(gitAs(bare, 'rev-parse', 'fix/a^')).toBe(first.commit)
    const status = await manager.status(record, undefined, 4096, TIMEOUT)
    expect(status.commits.map(entry => entry.subject)).toEqual(['fix: a', 'feat: b'])
    expect(status.unpushed).toBe(0)
  })

  it('pushes again when the remote branch was deleted after the last push', async () => {
    const { bare, manager, sessions } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    const record = await manager.locate(path)
    writeFileSync(join(path, 'a.txt'), 'a\n')
    const first = await manager.push(record, { message: 'a', committer: { name: 'bot', email: 'bot@example.com' } }, TIMEOUT)
    gitAs(bare, 'branch', '-D', 'fix/a')
    expect(await manager.push(record, {}, TIMEOUT)).toEqual({ commit: first.commit, committed: false, created: true })
    expect(gitAs(bare, 'rev-parse', 'fix/a')).toBe(first.commit)
  })

  it('refuses to overwrite a branch someone else moved unless forced with lease, and undoes its own commit on failure', async () => {
    const { bare, manager, sessions, root } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    const record = await manager.locate(path)
    writeFileSync(join(path, 'a.txt'), 'a\n')
    const committer = { name: 'bot', email: 'bot@example.com' }
    const first = await manager.push(record, { message: 'a', committer }, TIMEOUT)
    const seed = join(root, 'seed')
    gitAs(seed, 'fetch', '--quiet', bare, 'fix/a')
    gitAs(seed, 'checkout', '--quiet', '-B', 'fix/a', 'FETCH_HEAD')
    writeFileSync(join(seed, 'theirs.txt'), 'theirs\n')
    gitAs(seed, 'add', '.')
    gitAs(seed, 'commit', '--quiet', '-m', 'theirs')
    gitAs(seed, 'push', '--quiet', bare, 'fix/a')
    writeFileSync(join(path, 'b.txt'), 'b\n')
    await expect(manager.push(record, { message: 'b', committer }, TIMEOUT)).rejects.toMatchObject({ code: 'conflict' })
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(first.commit)
    expect(await git(path, 'status', '--porcelain')).toContain('b.txt')
    // The lease is the remote branch as the workspace last fetched it.
    await git(path, 'fetch', '--quiet', 'origin')
    const forced = await manager.push(record, { message: 'b', committer, forceWithLease: true }, TIMEOUT)
    expect(gitAs(bare, 'rev-parse', 'fix/a')).toBe(forced.commit)
    expect(gitAs(bare, 'rev-parse', 'fix/a^')).toBe(first.commit)
  })

  it('locates workspaces only from their records, removes them after unsaved work is confirmed, and forgets deleted ones', async () => {
    const { bare, manager, sessions, root } = await setup()
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    mkdirSync(join(path, 'src'))
    expect((await manager.locate(join(path, 'src'))).path).toBe(path)
    const plain = join(root, 'plain')
    mkdirSync(plain)
    await git(plain, 'init', '--quiet')
    await expect(manager.locate(plain)).rejects.toMatchObject({ code: 'not-found' })
    await expect(manager.locate(join(root, 'missing'))).rejects.toMatchObject({ code: 'not-found' })

    writeFileSync(join(path, 'a.txt'), 'a\n')
    const record = await manager.locate(path)
    await expect(manager.remove(record, false, undefined, TIMEOUT)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('未提交') })
    expect(await manager.remove(record, true, undefined, TIMEOUT)).toEqual({ discardedCommits: 0, discardedChanges: true })
    expect(existsSync(path)).toBe(false)
    expect(await manager.list()).toEqual([])

    const other = join(sessions, 'other')
    await manager.create({ repo: bare, path: other, branch: 'fix/b' })
    execFileSync('rm', ['-rf', other])
    expect(await manager.list()).toEqual([])
    await expect(manager.locate(other)).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('workspace git confinement', () => {
  it('runs git inside a workspace through the workspace runner without repository hooks', async () => {
    const { bare, service, registry, proxy, sessions } = await setup()
    const calls: string[][] = []
    const workspaceGit: WorkspaceGit = async (dir, args, runOptions) => {
      calls.push([...args])
      return await runGit(args, { cwd: dir, ...runOptions })
    }
    const manager = new WorkspaceManager({ service, registry, git: runGit, workspaceGit, proxy: () => ({ port: proxy.port! }) })
    const path = join(sessions, 'app')
    await manager.create({ repo: bare, path, branch: 'fix/a' })
    const marker = join(sessions, 'hook-ran')
    writeFileSync(join(path, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
    writeFileSync(join(path, 'a.txt'), 'a\n')
    await manager.push(await manager.locate(path), { message: 'a', committer: { name: 'bot', email: 'bot@example.com' } }, TIMEOUT)
    expect(calls.some(args => args.includes('push'))).toBe(true)
    expect(calls.every(args => args.includes('core.hooksPath=/dev/null'))).toBe(true)
    expect(existsSync(marker)).toBe(false)
    vi.restoreAllMocks()
  })
})
