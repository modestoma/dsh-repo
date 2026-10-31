import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostStore } from '../src/hosts.ts'
import { runGit } from '../src/mirror/git.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { credentials, testConfig, withMirrors } from './helpers.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const BOT = { name: 'Bot', email: 'bot@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

/** A bare origin with `main` (default, two files) and `dev`. */
function origin(): { bare: string; commit: string } {
  const work = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-src-'))
  git(work, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(work, 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(work, 'old.txt'), 'old\n')
  git(work, 'add', '.')
  git(work, 'commit', '--quiet', '-m', 'init')
  git(work, 'branch', 'dev')
  const bare = `${work}.git`
  git(tmpdir(), 'clone', '--quiet', '--bare', work, bare)
  return { bare, commit: git(work, 'rev-parse', 'HEAD') }
}

function setup(tokens: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-'))
  const config = testConfig()
  const make = () => new RepoService(config, {
    credentials: credentials(tokens),
    hosts: new HostStore(config.hosts, join(root, 'hosts.json')),
    ...withMirrors(new MirrorStore({ git: runGit, root: join(root, 'mirrors'), timeoutMs: 30_000, maxFileBytes: 1024, maxTreeEntries: 100 }), runGit, 200),
  })
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-session-'))
  return { root, sandbox, service: make(), make }
}

describe('workspaces', () => {
  it('opens a writable checkout whose git metadata stays in the mirror and reports changes against the base', async () => {
    const { bare, commit } = origin()
    const { root, sandbox, service } = setup()
    const dir = join(sandbox, 'topic', 'app')
    const info = await service.openWorkspace(bare, { dir })
    expect(info).toEqual({ url: bare, dir: realpathSync(dir), baseBranch: 'main', baseCommit: commit })
    expect(readFileSync(join(dir, '.git'), 'utf8')).toContain(realpathSync(join(root, 'mirrors')))
    await expect(service.openWorkspace(bare, { dir })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.openWorkspace(bare, { dir: 'relative/app' })).rejects.toMatchObject({ code: 'invalid' })

    writeFileSync(join(dir, 'app.ts'), 'export const a = 2\nexport const b = 3\n')
    writeFileSync(join(dir, 'new.ts'), 'export {}\n')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
    rmSync(join(dir, 'old.txt'))
    const changes = await service.workspaceChanges(join(dir))
    expect(changes.uncommitted).toBe(true)
    expect(changes.commits).toEqual([])
    expect(changes.files).toEqual(expect.arrayContaining([
      { path: 'app.ts', status: 'modified', binary: false, additions: 2, deletions: 1 },
      { path: 'new.ts', status: 'added', binary: false, additions: 1, deletions: 0 },
      { path: 'old.txt', status: 'deleted', binary: false, additions: 0, deletions: 1 },
      { path: 'blob.bin', status: 'added', binary: true },
    ]))
    expect(changes.diff).toContain('+export const b = 3')
    expect(changes.truncated).toBe(true)
  })

  it('starts from a given commit or branch', async () => {
    const { bare, commit } = origin()
    const { sandbox, service } = setup()
    const info = await service.openWorkspace(bare, { dir: join(sandbox, 'dev'), baseBranch: 'dev', commit })
    expect(info).toMatchObject({ baseBranch: 'dev', baseCommit: commit })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'x'), commit: 'abc' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'y'), commit: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'z'), baseBranch: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('commits and pushes to a new branch only, then keeps pushing to that branch without forcing', async () => {
    const { bare, commit } = origin()
    const { sandbox, service } = setup()
    const dir = join(sandbox, 'app')
    await service.openWorkspace(bare, { dir })
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm', author: BOT })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('没有改动') })
    writeFileSync(join(dir, 'app.ts'), 'export const a = 2\n')
    await expect(service.pushWorkspace(dir, { message: 'm' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('分支名') })
    await expect(service.pushWorkspace(dir, { branch: 'fix/a' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('提交说明') })
    await expect(service.pushWorkspace(dir, { branch: 'main', message: 'm' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('起点分支') })
    await expect(service.pushWorkspace(dir, { branch: 'dev', message: 'm', author: BOT })).rejects.toMatchObject({ code: 'conflict' })
    expect(git(bare, 'rev-parse', 'dev')).toBe(commit)
    expect(await service.workspaceChanges(dir)).toMatchObject({ uncommitted: true, commits: [] })

    const pushed = await service.pushWorkspace(dir, { branch: 'fix/a', message: 'fix: a', author: BOT })
    expect(pushed).toMatchObject({ url: bare, branch: 'fix/a', baseBranch: 'main', committed: true, created: true })
    expect(git(bare, 'rev-parse', 'fix/a')).toBe(pushed.commit)
    expect(git(bare, 'log', '-1', '--format=%an <%ae> %cn %s', 'fix/a')).toBe('Bot <bot@example.com> Bot fix: a')
    expect(git(bare, 'rev-parse', 'fix/a^')).toBe(commit)

    const after = await service.workspaceChanges(dir)
    expect(after).toMatchObject({ uncommitted: false, workspace: { branch: 'fix/a' }, commits: [{ sha: pushed.commit, subject: 'fix: a' }] })
    await expect(service.pushWorkspace(dir, { branch: 'fix/b', message: 'm' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('fix/a') })

    writeFileSync(join(dir, 'more.ts'), 'export {}\n')
    const second = await service.pushWorkspace(dir, { message: 'feat: more', author: BOT })
    expect(second).toMatchObject({ branch: 'fix/a', committed: true, created: false })
    expect(git(bare, 'rev-parse', 'fix/a')).toBe(second.commit)

    const other = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-other-'))
    git(other, 'clone', '--quiet', '--branch', 'fix/a', bare, '.')
    writeFileSync(join(other, 'theirs.ts'), 'x\n')
    git(other, 'add', '.')
    git(other, 'commit', '--quiet', '-m', 'theirs')
    git(other, 'push', '--quiet', 'origin', 'fix/a')
    writeFileSync(join(dir, 'mine.ts'), 'y\n')
    await expect(service.pushWorkspace(dir, { message: 'mine', author: BOT })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses the remote default branch on the first push', async () => {
    const { bare } = origin()
    const { sandbox, service } = setup()
    const dir = join(sandbox, 'dev')
    await service.openWorkspace(bare, { dir, baseBranch: 'dev' })
    writeFileSync(join(dir, 'app.ts'), 'x\n')
    await expect(service.pushWorkspace(dir, { branch: 'main', message: 'm', author: BOT })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('默认分支') })
  })

  it('needs a configured host with a token to push a remote address', async () => {
    const { bare } = origin()
    const { root, sandbox, service } = setup()
    const dir = join(sandbox, 'app')
    await service.openWorkspace(bare, { dir })
    writeFileSync(join(dir, 'app.ts'), 'x\n')
    const mirror = readFileSync(join(dir, '.git'), 'utf8').replace(/^gitdir: /, '').trim().replace(/\/\.git\/worktrees\/.*$/, '')
    expect(mirror.startsWith(realpathSync(root))).toBe(true)
    git(mirror, 'remote', 'set-url', 'origin', 'https://elsewhere.example.com/a/b.git')
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm' })).rejects.toMatchObject({ code: 'unauthenticated' })
    git(mirror, 'remote', 'set-url', 'origin', 'https://github.com/modestoma/app.git')
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('refuses directories that are not workspaces of this service, including forged links', async () => {
    const { bare } = origin()
    const { sandbox, service } = setup()
    const real = join(sandbox, 'app')
    await service.openWorkspace(bare, { dir: real })
    await expect(service.workspaceChanges(join(sandbox, 'missing'))).rejects.toMatchObject({ code: 'not-found' })

    const plain = join(sandbox, 'plain')
    mkdirSync(plain)
    git(plain, 'init', '--quiet')
    await expect(service.workspaceChanges(plain)).rejects.toMatchObject({ code: 'not-found' })

    const borrowed = join(sandbox, 'borrowed')
    mkdirSync(borrowed)
    writeFileSync(join(borrowed, '.git'), readFileSync(join(real, '.git'), 'utf8'))
    await expect(service.pushWorkspace(borrowed, { branch: 'x', message: 'm' })).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining('不一致') })

    // A repository the agent controls, laid out like a mirror worktree.
    const fake = join(sandbox, 'fake')
    git(sandbox, 'clone', '--quiet', bare, fake)
    const forged = join(sandbox, 'forged')
    git(fake, 'worktree', 'add', '--quiet', '-b', 'dsh-repo/ws-0123456789abcdef', forged)
    git(fake, 'config', 'dsh-repo-workspace.0123456789abcdef.baseBranch', 'main')
    git(fake, 'config', 'dsh-repo-workspace.0123456789abcdef.baseCommit', git(fake, 'rev-parse', 'HEAD'))
    await expect(service.workspaceChanges(forged)).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining('镜像') })
  })

  it('forgets the branches of deleted checkouts on the first sync of a later process', async () => {
    const { bare } = origin()
    const { sandbox, service, make } = setup()
    const kept = join(sandbox, 'kept')
    const gone = join(sandbox, 'gone')
    await service.openWorkspace(bare, { dir: kept })
    await service.openWorkspace(bare, { dir: gone })
    const mirror = readFileSync(join(kept, '.git'), 'utf8').replace(/^gitdir: /, '').trim().replace(/\/\.git\/worktrees\/.*$/, '')
    expect(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/dsh-repo/').split('\n')).toHaveLength(2)
    rmSync(gone, { recursive: true })
    await make().syncMirror(bare)
    expect(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/dsh-repo/').split('\n')).toHaveLength(1)
    expect((await service.workspaceChanges(kept)).files).toEqual([])
  })
})
