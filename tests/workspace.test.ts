import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostStore } from '../src/hosts.ts'
import { runGit } from '../src/mirror/git.ts'
import type { GitRunner } from '../src/mirror/git.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { credentials, fakeHttp, mirrorLimits, testConfig, TOKENS, withMirrors } from './helpers.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const BOT = { name: 'Bot', email: 'bot@example.com' }

/** Whether the machine has Git LFS. */
const HAS_LFS = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    // No `git lfs` command on this machine.
    return false
  }
})()

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

function setup(tokens: Record<string, string> = {}, git: GitRunner = runGit) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-'))
  const config = testConfig()
  const make = () => new RepoService({
    credentials: credentials(tokens),
    hosts: new HostStore(config.hosts, join(root, 'hosts.json')),
    ...withMirrors(new MirrorStore({ git, root: join(root, 'mirrors'), limits: mirrorLimits(1024, 100) }), git, 200),
  })
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-session-'))
  return { root, sandbox, service: make(), make }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** The mirror directory behind a workspace checkout. */
function mirrorOf(dir: string): string {
  return readFileSync(join(dir, '.git'), 'utf8').replace(/^gitdir: /, '').trim().replace(/\/\.git\/worktrees\/.*$/, '')
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
    writeFileSync(join(dir, 'tab\tname.txt'), 'a\nb\n')
    writeFileSync(join(dir, 'tab\tblob.bin'), Buffer.from([0, 1]))
    rmSync(join(dir, 'old.txt'))
    const changes = await service.workspaceChanges(join(dir))
    expect(changes.uncommitted).toBe(true)
    expect(changes.commits).toEqual([])
    expect(changes.files).toEqual(expect.arrayContaining([
      { path: 'app.ts', status: 'modified', binary: false, additions: 2, deletions: 1 },
      { path: 'new.ts', status: 'added', binary: false, additions: 1, deletions: 0 },
      { path: 'old.txt', status: 'deleted', binary: false, additions: 0, deletions: 1 },
      { path: 'blob.bin', status: 'added', binary: true },
      { path: 'tab\tname.txt', status: 'added', binary: false, additions: 2, deletions: 0 },
      { path: 'tab\tblob.bin', status: 'added', binary: true },
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
    expect(pushed).toMatchObject({ url: bare, branch: 'fix/a', baseBranch: 'main', committed: true, author: BOT, created: true })
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

  it('continues an existing remote branch: starts from its head and pushes fast-forward commits to it', async () => {
    const { bare, commit } = origin()
    const { sandbox, service } = setup()
    const first = join(sandbox, 'first')
    await service.openWorkspace(bare, { dir: first })
    writeFileSync(join(first, 'app.ts'), 'export const a = 2\n')
    const pushed = await service.pushWorkspace(first, { branch: 'fix/a', message: 'fix: a', author: BOT })

    const dir = join(sandbox, 'again')
    const info = await service.openWorkspace(bare, { dir, branch: 'fix/a' })
    expect(info).toEqual({ url: bare, dir: realpathSync(dir), baseBranch: 'main', baseCommit: pushed.commit, branch: 'fix/a' })
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(await service.workspaceChanges(dir)).toMatchObject({ workspace: { branch: 'fix/a' }, commits: [], files: [] })
    await expect(service.pushWorkspace(dir, { message: 'm', author: BOT })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('没有改动') })

    writeFileSync(join(dir, 'more.ts'), 'export {}\n')
    await expect(service.pushWorkspace(dir, { branch: 'fix/b', message: 'm', author: BOT })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('fix/a') })
    const more = await service.pushWorkspace(dir, { message: 'fix: more', author: BOT })
    expect(more).toMatchObject({ branch: 'fix/a', baseBranch: 'main', committed: true, created: false })
    expect(git(bare, 'rev-parse', 'fix/a')).toBe(more.commit)
    expect(git(bare, 'rev-parse', 'fix/a^')).toBe(pushed.commit)
    expect(git(bare, 'rev-parse', 'main')).toBe(commit)
  })

  it('refuses to continue the base or default branch, a missing branch, or a branch with a start commit', async () => {
    const { bare, commit } = origin()
    const { sandbox, service } = setup()
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'a'), branch: 'main' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('合入目标') })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'b'), branch: 'main', baseBranch: 'dev' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('默认分支') })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'c'), branch: 'dev', commit })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('起点提交') })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'd'), branch: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.openWorkspace(bare, { dir: join(sandbox, 'e'), branch: '-x' })).rejects.toMatchObject({ code: 'invalid' })
    expect(await service.openWorkspace(bare, { dir: join(sandbox, 'f'), branch: 'dev' })).toMatchObject({ baseBranch: 'main', branch: 'dev', baseCommit: commit })
  })

  it('refuses a first push to an existing branch that already holds the same commit', async () => {
    const { bare } = origin()
    const { sandbox, service } = setup()
    const one = join(sandbox, 'one')
    const two = join(sandbox, 'two')
    await service.openWorkspace(bare, { dir: one })
    await service.openWorkspace(bare, { dir: two })
    writeFileSync(join(one, 'app.ts'), 'same\n')
    const pushed = await service.pushWorkspace(one, { branch: 'topic', message: 'same', author: BOT })
    git(two, 'fetch', '--quiet', 'origin', pushed.commit)
    git(two, 'reset', '--quiet', '--hard', pushed.commit)
    await expect(service.pushWorkspace(two, { branch: 'topic', author: BOT })).rejects.toMatchObject({ code: 'conflict' })
    expect((await service.workspaceChanges(two)).workspace.branch).toBeUndefined()
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
    const mirror = mirrorOf(dir)
    expect(mirror.startsWith(realpathSync(root))).toBe(true)
    git(mirror, 'remote', 'set-url', 'origin', 'https://elsewhere.example.com/a/b.git')
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm' })).rejects.toMatchObject({ code: 'unauthenticated' })
    git(mirror, 'remote', 'set-url', 'origin', 'https://github.com/modestoma/app.git')
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('commits as the account that owns the host token and records the session', async () => {
    const { bare, commit } = origin()
    const checkouts: Readonly<Record<string, string>>[] = []
    const { sandbox, service } = setup(TOKENS, async (args, options) => {
      if (args[0] === 'worktree' && args[1] === 'add') checkouts.push(options.env ?? {})
      return await runGit(args, options)
    })
    // Serve the github.com address from the local origin so the test stays offline.
    const remote = 'https://github.com/modestoma/app.git'
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${bare}.insteadOf`)
    vi.stubEnv('GIT_CONFIG_VALUE_0', remote)
    const dir = join(sandbox, 'app')
    expect(await service.openWorkspace(remote, { dir })).toMatchObject({ url: remote, baseCommit: commit })
    // Checkout runs the Git LFS smudge filter, which may download with the host token.
    expect(checkouts).toEqual([expect.objectContaining({ DSH_REPO_GIT_TOKEN: 'gh-token' })])
    let reads = 0
    const { requests } = fakeHttp([{ method: 'GET', path: '/user', reply: () => {
      reads += 1
      return reads === 1 ? { status: 403, body: { message: 'Resource not accessible by personal access token' } } : { body: { login: 'shared-bot', id: 42, name: null, email: null } }
    } }])

    writeFileSync(join(dir, 'app.ts'), 'export const a = 2\n')
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm', session: 'a\nb' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('会话') })
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm' })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('令牌账号') })
    expect(await service.workspaceChanges(dir)).toMatchObject({ uncommitted: true, commits: [] })

    for (const [trailer, reason] of [
      [{ token: 'Feishu User', value: 'x' }, '尾注名'],
      [{ token: 'dsh-session', value: 'x' }, 'DSH-Session'],
      [{ token: 'Feishu-User', value: 'a\nb' }, '控制字符'],
      [{ token: 'Feishu-User', value: '  ' }, '不能为空'],
    ] as const) {
      await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm', trailers: [trailer] })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining(reason) })
    }
    const many = Array.from({ length: 21 }, (_, index) => ({ token: `T${index}`, value: 'x' }))
    await expect(service.pushWorkspace(dir, { branch: 'fix/a', message: 'm', trailers: many })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('最多 20 条') })

    const pushed = await service.pushWorkspace(dir, {
      branch: 'fix/a', message: 'fix: a\n\nWhy.', session: 'sess-1', trailers: [{ token: 'Feishu-User', value: ' 张三 <u_1> ' }],
    })
    expect(requests[1]?.headers.get('authorization')).toBe('token gh-token')
    expect(git(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'fix/a')).toBe('shared-bot <42+shared-bot@users.noreply.github.com>|shared-bot <42+shared-bot@users.noreply.github.com>')
    expect(pushed.author).toEqual({ name: 'shared-bot', email: '42+shared-bot@users.noreply.github.com' })
    expect(git(bare, 'log', '-1', '--format=%B', 'fix/a')).toBe('fix: a\n\nWhy.\n\nDSH-Session: sess-1\nFeishu-User: 张三 <u_1>')
    expect(git(bare, 'rev-parse', 'fix/a^')).toBe(commit)

    writeFileSync(join(dir, 'more.ts'), 'export {}\n')
    const second = await service.pushWorkspace(dir, { message: 'feat: more', author: BOT })
    expect(git(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%B', 'fix/a').trim()).toBe('Bot <bot@example.com>|shared-bot <42+shared-bot@users.noreply.github.com>|feat: more')
    expect(second).toMatchObject({ committed: true, author: BOT })
    expect(second.commit).not.toBe(pushed.commit)
    writeFileSync(join(dir, 'last.ts'), 'export {}\n')
    await service.pushWorkspace(dir, { message: 'feat: last' })
    expect(git(bare, 'log', '-1', '--format=%an', 'fix/a')).toBe('shared-bot')
    expect(reads).toBe(2)
  })

  it.skipIf(!HAS_LFS)('uploads the Git LFS objects of pushed commits', async () => {
    const lfs = { 'filter.lfs.clean': 'git-lfs clean -- %f', 'filter.lfs.smudge': 'git-lfs smudge -- %f', 'filter.lfs.process': 'git-lfs filter-process', 'filter.lfs.required': 'true' }
    vi.stubEnv('GIT_CONFIG_COUNT', String(Object.keys(lfs).length))
    Object.entries(lfs).forEach(([key, value], index) => {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key)
      vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, value)
    })
    const { bare } = origin()
    const { sandbox, service } = setup()
    const dir = join(sandbox, 'app')
    await service.openWorkspace(bare, { dir })
    writeFileSync(join(dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(dir, 'model.bin'), 'large content\n')
    const pushed = await service.pushWorkspace(dir, { branch: 'lfs', message: 'add model', author: BOT })
    expect(git(bare, 'cat-file', '-p', `${pushed.commit}:model.bin`)).toContain('version https://git-lfs.github.com/spec/v1')
    const clone = mkdtempSync(join(tmpdir(), 'dsh-repo-ws-lfs-'))
    git(clone, 'clone', '--quiet', '--branch', 'lfs', bare, '.')
    expect(readFileSync(join(clone, 'model.bin'), 'utf8')).toBe('large content\n')
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
    const mirror = mirrorOf(kept)
    expect(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/dsh-repo/').split('\n')).toHaveLength(2)
    rmSync(gone, { recursive: true })
    await make().syncMirror(bare)
    expect(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/dsh-repo/').split('\n')).toHaveLength(1)
    expect((await service.workspaceChanges(kept)).files).toEqual([])
  })
})
