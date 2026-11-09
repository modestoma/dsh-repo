import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostStore } from '../src/hosts.ts'
import { credentialEnvironment, runGit } from '../src/mirror/git.ts'
import type { GitRunner } from '../src/mirror/git.ts'
import { isAcceptedGitUrl, mirrorPath, MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { allow, catalogEntries, credentials, hostStore, mirrorLimits, testConfig, testSettings } from './helpers.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

/** A repository with a `main` branch holding a file, a script, and a link. */
function origin(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-origin-'))
  git(dir, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  execFileSync('mkdir', ['-p', join(dir, 'docs')])
  writeFileSync(join(dir, 'docs', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  execFileSync('ln', ['-s', 'README.md', join(dir, 'link')])
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', 'init')
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') }
}

function setup(options: { git?: GitRunner; tokens?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-mirrors-'))
  const config = testConfig()
  const service = new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials(options.tokens ?? {}),
    hosts: hostStore(config, root, testSettings(), catalogEntries(['https://code.example.com/gitlab/team/app', 'https://github.com/modestoma/app'])),
    mirrors: new MirrorStore({ git: options.git ?? runGit, root: join(root, 'mirrors'), limits: mirrorLimits() }),
  })
  return { root, service }
}

describe('mirror addresses', () => {
  it('accepts only HTTPS, file URLs, and local paths, and lays mirrors out by host and path', () => {
    expect(isAcceptedGitUrl('https://github.com/modestoma/dsh-repo.git')).toBe(true)
    expect(isAcceptedGitUrl('file:///srv/repos/app.git')).toBe(true)
    expect(isAcceptedGitUrl('/srv/repos/app.git')).toBe(true)
    expect(isAcceptedGitUrl('git@github.com:modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('ssh://git@github.com/modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('git://github.com/modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('http://github.com/modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('ext::sh -c id')).toBe(false)
    expect(isAcceptedGitUrl('-u')).toBe(false)
    expect(mirrorPath('https://code.example.com:8443/gitlab/team/app.git')).toBe('code.example.com_8443/gitlab/team/app.git')
    expect(mirrorPath('/srv/repos/app.git')).toMatch(/^local\/app-[0-9a-f]{8}\.git$/)
    expect(mirrorPath('https://github.com/team/.github.git')).toMatch(/^github\.com\/team\/github-[0-9a-f]{6}\.git$/)
    expect(mirrorPath('https://github.com/team/github.git')).toBe('github.com/team/github.git')
  })

  it('hands the token of a configured host to HTTPS network commands only', async () => {
    const calls: { args: readonly string[]; env: Readonly<Record<string, string>> }[] = []
    const fake: GitRunner = async (args, options) => {
      calls.push({ args, env: options.env ?? {} })
      throw new Error('stop')
    }
    const { service } = setup({ git: fake, tokens: { GITLAB_TOKEN: 'gl' } })
    await expect(service.syncMirror('https://code.example.com/gitlab/team/app.git')).rejects.toMatchObject({ code: 'unavailable' })
    expect(calls[0]?.args[0]).toBe('clone')
    expect(calls[0]?.env).toEqual(credentialEnvironment('https://code.example.com/gitlab', 'oauth2', 'gl', process.env))
    calls.length = 0
    await expect(service.syncMirror('git@github.com:modestoma/app.git')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('https') })
    expect(calls).toEqual([])
    await expect(service.syncMirror('https://elsewhere.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.syncMirror('https://github.com/someone/app')).rejects.toMatchObject({ code: 'not-allowed', message: expect.stringContaining('不在 dsh-repo 的仓库清单中') })
    await expect(service.syncMirror('https://ghe.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    expect(calls).toEqual([])
    await expect(setup({ git: fake, tokens: {} }).service.syncMirror('https://code.example.com/gitlab/team/app')).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(service.syncMirror('ext::sh')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('cuts stdout at maxOutputBytes and lets git finish, and reports failures with their output', async () => {
    const { dir } = origin()
    const big = 'x'.repeat(200_000)
    writeFileSync(join(dir, 'big.txt'), big)
    const full = await runGit(['diff', '--no-index', '--', '/dev/null', 'big.txt'], { cwd: dir, timeoutMs: 30_000 }).catch((error: unknown) => (error as { output: string }).output)
    expect(full.length).toBeGreaterThan(200_000)
    await expect(runGit(['hash-object', 'big.txt'], { cwd: dir, timeoutMs: 30_000, maxOutputBytes: 8 })).resolves.toHaveLength(8)
    await expect(runGit(['cat-file', '-p', 'HEAD:missing'], { cwd: dir, timeoutMs: 30_000 })).rejects.toMatchObject({ output: expect.stringContaining('missing') })
    await expect(runGit(['status'], { cwd: dir, timeoutMs: 30_000, signal: AbortSignal.abort() })).rejects.toMatchObject({ output: expect.stringContaining('取消') })
  })

  it('builds the credential helper environment after existing config entries', () => {
    expect(credentialEnvironment('https://h.example.com/x', 'oauth2', 't', { GIT_CONFIG_COUNT: '1' })).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'credential.https://h.example.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.https://h.example.com.helper',
      DSH_REPO_GIT_USERNAME: 'oauth2',
      DSH_REPO_GIT_TOKEN: 't',
    })
  })
})

describe('mirror store', () => {
  it('clones a bare mirror, fetches, and shares read-only snapshots of a commit', async () => {
    const repo = origin()
    const { service } = setup()
    await expect(service.syncMirror(repo.dir)).rejects.toMatchObject({ code: 'not-allowed' })
    await allow(service, [repo.dir], 'read')
    const first = await service.syncMirror(repo.dir)
    expect(first).toMatchObject({ url: repo.dir, branch: 'main', defaultBranch: 'main', commit: repo.commit })
    expect(first.dir.endsWith('.git')).toBe(true)
    expect(git(first.dir, 'rev-parse', '--is-bare-repository')).toBe('true')
    expect(git(first.dir, 'config', 'gc.auto')).toBe('0')
    expect(existsSync(join(first.dir, 'README.md'))).toBe(false)

    const a = await service.mirrors.acquire(repo.dir, repo.commit)
    const b = await service.mirrors.acquire(repo.dir, repo.commit)
    expect(a.dir).toBe(b.dir)
    expect(readFileSync(join(a.dir, 'README.md'), 'utf8')).toBe('hello\n')
    expect(statSync(join(a.dir, 'docs', 'run.sh')).mode & 0o111).not.toBe(0)
    expect(lstatSync(join(a.dir, 'link')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(a.dir, '.git'))).toBe(false)
    await expect(service.mirrors.acquire(repo.dir, 'f'.repeat(40))).rejects.toMatchObject({ code: 'not-found' })

    writeFileSync(join(repo.dir, 'README.md'), 'changed\n')
    git(repo.dir, 'commit', '--quiet', '-am', 'change')
    const second = await service.syncMirror(repo.dir)
    expect(second.commit).not.toBe(repo.commit)
    expect(await service.mirrors.resolveRef(repo.dir, 'main')).toBe(second.commit)
    expect(await service.mirrors.resolveRef(repo.dir, repo.commit)).toBe(repo.commit)
    await expect(service.mirrors.resolveRef(repo.dir, 'nope')).rejects.toMatchObject({ code: 'not-found' })
    a.release()
    a.release()
    expect(existsSync(a.dir)).toBe(true)
    b.release()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(a.dir)).toBe(false)
  })

  it('removes snapshots left by an earlier process, and follows a changed default branch', async () => {
    const repo = origin()
    const config = testConfig()
    const root = mkdtempSync(join(tmpdir(), 'dsh-repo-restart-'))
    const make = () => new RepoService({
      forbiddenMirrorRoots: [],
      credentials: credentials({}),
      hosts: new HostStore(config.hosts, join(root, 'hosts.json')),
      mirrors: new MirrorStore({ git: runGit, root: join(root, 'mirrors'), limits: mirrorLimits() }),
    })
    const before = make()
    await allow(before, [repo.dir])
    const leftover = await before.mirrors.acquire(repo.dir, (await before.syncMirror(repo.dir)).commit)
    const restarted = make()
    await restarted.syncMirror(repo.dir)
    const lease = await restarted.mirrors.acquire(repo.dir, repo.commit)
    expect(existsSync(leftover.dir)).toBe(false)
    expect(existsSync(join(lease.dir, 'README.md'))).toBe(true)

    git(repo.dir, 'checkout', '--quiet', '-b', 'next')
    writeFileSync(join(repo.dir, 'NEXT.md'), 'next\n')
    git(repo.dir, 'add', '.')
    git(repo.dir, 'commit', '--quiet', '-m', 'next')
    const moved = await restarted.syncMirror(repo.dir)
    expect(moved).toMatchObject({ branch: 'next', defaultBranch: 'next', commit: git(repo.dir, 'rev-parse', 'HEAD') })
    expect(git(moved.dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/next')
    expect(existsSync(join(lease.dir, 'README.md'))).toBe(true)
    lease.release()
  })

  it('reports a missing branch and an invalid one', async () => {
    const repo = origin()
    const { service } = setup()
    await allow(service, [`file://${repo.dir}`])
    await expect(service.syncMirror(repo.dir, { branch: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.syncMirror(repo.dir, { branch: '-x' })).rejects.toMatchObject({ code: 'invalid' })
    git(repo.dir, 'branch', 'dev')
    expect(await service.syncMirror(repo.dir, { branch: 'dev' })).toMatchObject({ branch: 'dev', defaultBranch: 'main', commit: repo.commit })
  })
})

describe('mirror directory changes', () => {
  it('clones into the new directory and keeps held snapshots beside the old mirror', async () => {
    const { dir: source, commit } = origin()
    const { root, service } = setup()
    await allow(service, [source])
    const first = await service.syncMirror(source)
    expect(first.dir.startsWith(join(root, 'mirrors'))).toBe(true)
    const lease = await service.mirrors.acquire(source, commit)
    expect(lease.dir.startsWith(join(root, 'mirrors', '.snapshots'))).toBe(true)

    const moved = join(root, 'moved')
    expect(await service.setMirrorDir(moved)).toEqual({ dir: moved })
    expect(existsSync(lease.dir)).toBe(true)
    const second = await service.syncMirror(source)
    expect(second.dir.startsWith(moved)).toBe(true)
    expect(second.commit).toBe(commit)
    expect(existsSync(first.dir)).toBe(true)
    lease.release()
    expect((await service.mirrors.acquire(source, commit)).dir.startsWith(join(moved, '.snapshots'))).toBe(true)
    await expect(service.setMirrorDir('~nobody/x')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses every mirror operation while no directory is chosen, and resumes after one is', async () => {
    const { dir: source, commit } = origin()
    const { root, service } = setup()
    await allow(service, [source])
    expect(await service.setMirrorDir(undefined)).toEqual({ dir: undefined })
    expect(service.mirrorSettings().dir).toBeUndefined()
    await expect(service.syncMirror(source)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('镜像目录未设置') })
    await expect(service.mirrors.acquire(source, commit)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.mirrorUsage()).rejects.toMatchObject({ code: 'unavailable' })
    await service.setMirrorDir(join(root, 'chosen'))
    expect((await service.syncMirror(source)).commit).toBe(commit)
  })

  it('refuses a directory in a forbidden root, also through a symbolic link, and leaves the choice unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repo-forbidden-'))
    const home = join(root, 'dsh-home')
    mkdirSync(home)
    symlinkSync(home, join(root, 'home-link'))
    const service = new RepoService({
      forbiddenMirrorRoots: [home, '/tmp/surely-missing-root'],
      credentials: credentials({}),
      hosts: new HostStore(testConfig().hosts, join(root, 'hosts.json')),
      mirrors: new MirrorStore({ git: runGit, root: undefined, limits: mirrorLimits() }),
    })
    for (const dir of [home, join(home, 'dsh-repo', 'mirrors'), join(home, '..mirrors'), join(root, 'home-link', 'mirrors'), '/tmp/surely-missing-root/x']) {
      await expect(service.setMirrorDir(dir)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('不能是') })
    }
    expect(service.mirrorSettings()).toEqual({ dir: undefined })
    expect(existsSync(join(home, 'dsh-repo'))).toBe(false)
    const allowed = join(root, 'mirrors')
    expect(await service.setMirrorDir(allowed)).toEqual({ dir: allowed })
  })

  it('leaves a stored directory that breaks the rules unused and reports why', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repo-stored-'))
    const home = join(root, 'dsh-home')
    writeFileSync(join(root, 'hosts.json'), `${JSON.stringify({ hosts: [], mirrorDir: join(home, 'mirrors') })}\n`)
    const errors: unknown[] = []
    const service = new RepoService({
      forbiddenMirrorRoots: [home],
      credentials: credentials({}),
      logger: { error: (_message, ...args) => { errors.push(...args) } },
      hosts: new HostStore(testConfig().hosts, join(root, 'hosts.json')),
      mirrors: new MirrorStore({ git: runGit, root: undefined, limits: mirrorLimits() }),
    })
    expect(service.mirrorSettings()).toEqual({ dir: undefined, problem: expect.stringContaining(join(home, 'mirrors')) })
    expect(errors).toHaveLength(1)
  })
})
