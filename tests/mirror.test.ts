import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/settings/store.ts'
import { credentialEnvironment, runGit } from '../src/mirror/git.ts'
import type { GitRunner } from '../src/mirror/git.ts'
import { isAcceptedGitUrl, mirrorPath, MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { allow, catalogEntries, credentials, settingsStore, mirrorLimits, testConfig, testSettings } from './helpers.ts'
import { fileRemote, REMOTE_TOKENS, remoteConfig } from './remote.ts'
import type { Remote } from './remote.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

/** A repository of the stand-in remote with a `main` branch holding a file, a script, and a link. */
function origin(remote: Remote, path = 'team/origin'): { url: string; dir: string; commit: string } {
  const { url, dir } = remote.repo(path)
  execFileSync('mkdir', ['-p', join(dir, 'docs')])
  writeFileSync(join(dir, 'docs', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  execFileSync('ln', ['-s', 'README.md', join(dir, 'link')])
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', 'files')
  return { url, dir, commit: git(dir, 'rev-parse', 'HEAD') }
}

/** Hosts of the provider tests plus the stand-in remote. */
function config() {
  return remoteConfig(testConfig().hosts)
}

function setup(options: { git?: GitRunner; tokens?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-mirrors-'))
  const remote = fileRemote()
  const service = new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials(options.tokens ?? REMOTE_TOKENS),
    store: settingsStore(config(), root, testSettings(), catalogEntries(['https://code.example.com/gitlab/team/app', 'https://github.com/modestoma/app'])),
    mirrorStore: new MirrorStore({ git: options.git ?? remote.git, root: join(root, 'mirrors'), limits: mirrorLimits() }),
  })
  return { root, service, remote }
}

describe('mirror addresses', () => {
  it('accepts only HTTPS addresses and lays mirrors out by host and path', () => {
    expect(isAcceptedGitUrl('https://github.com/modestoma/dsh-repo.git')).toBe(true)
    expect(isAcceptedGitUrl('file:///srv/repos/app.git')).toBe(false)
    expect(isAcceptedGitUrl('/srv/repos/app.git')).toBe(false)
    expect(isAcceptedGitUrl('git@github.com:modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('ssh://git@github.com/modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('git://github.com/modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('http://github.com/modestoma/dsh-repo.git')).toBe(false)
    expect(isAcceptedGitUrl('ext::sh -c id')).toBe(false)
    expect(isAcceptedGitUrl('-u')).toBe(false)
    expect(mirrorPath('https://code.example.com:8443/gitlab/team/app.git')).toBe('code.example.com_8443/gitlab/team/app.git')
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
    await expect(service.mirrors.sync('https://code.example.com/gitlab/team/app.git')).rejects.toMatchObject({ code: 'unavailable' })
    expect(calls[0]?.args[0]).toBe('clone')
    expect(calls[0]?.env).toEqual(credentialEnvironment('https://code.example.com/gitlab', 'oauth2', 'gl', process.env))
    calls.length = 0
    await expect(service.mirrors.sync('git@github.com:modestoma/app.git')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('https') })
    expect(calls).toEqual([])
    await expect(service.mirrors.sync('https://elsewhere.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.mirrors.sync('https://github.com/someone/app')).rejects.toMatchObject({ code: 'not-allowed', message: expect.stringContaining('不在 dsh-repo 的仓库清单中') })
    await expect(service.mirrors.sync('https://ghe.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    expect(calls).toEqual([])
    await expect(setup({ git: fake, tokens: {} }).service.mirrors.sync('https://code.example.com/gitlab/team/app')).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(service.mirrors.sync('ext::sh')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('cuts stdout at maxOutputBytes and lets git finish, and reports failures with their output', async () => {
    const { dir } = origin(fileRemote())
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
    const { service, remote } = setup()
    const repo = origin(remote)
    await expect(service.mirrors.sync(repo.url)).rejects.toMatchObject({ code: 'not-allowed' })
    await allow(service, [repo.url], 'read')
    const first = await service.mirrors.sync(repo.url)
    expect(first).toMatchObject({ url: repo.url, branch: 'main', defaultBranch: 'main', commit: repo.commit })
    expect(first.dir.endsWith('.git')).toBe(true)
    expect(git(first.dir, 'rev-parse', '--is-bare-repository')).toBe('true')
    expect(git(first.dir, 'config', 'gc.auto')).toBe('0')
    expect(existsSync(join(first.dir, 'README.md'))).toBe(false)

    const a = await service.mirrors.store.acquire(repo.url, repo.commit)
    const b = await service.mirrors.store.acquire(repo.url, repo.commit)
    expect(a.dir).toBe(b.dir)
    expect(readFileSync(join(a.dir, 'README.md'), 'utf8')).toBe('hello\n')
    expect(statSync(join(a.dir, 'docs', 'run.sh')).mode & 0o111).not.toBe(0)
    expect(lstatSync(join(a.dir, 'link')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(a.dir, '.git'))).toBe(false)
    await expect(service.mirrors.store.acquire(repo.url, 'f'.repeat(40))).rejects.toMatchObject({ code: 'not-found' })

    writeFileSync(join(repo.dir, 'README.md'), 'changed\n')
    git(repo.dir, 'commit', '--quiet', '-am', 'change')
    const second = await service.mirrors.sync(repo.url)
    expect(second.commit).not.toBe(repo.commit)
    expect(await service.mirrors.store.resolveRef(repo.url, 'main')).toBe(second.commit)
    expect(await service.mirrors.store.resolveRef(repo.url, repo.commit)).toBe(repo.commit)
    await expect(service.mirrors.store.resolveRef(repo.url, 'nope')).rejects.toMatchObject({ code: 'not-found' })
    a.release()
    a.release()
    expect(existsSync(a.dir)).toBe(true)
    b.release()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(a.dir)).toBe(false)
  })

  it('removes snapshots left by an earlier process, and follows a changed default branch', async () => {
    const remote = fileRemote()
    const repo = origin(remote)
    const root = mkdtempSync(join(tmpdir(), 'dsh-repo-restart-'))
    const make = () => new RepoService({
      forbiddenMirrorRoots: [],
      credentials: credentials(REMOTE_TOKENS),
      store: new SettingsStore(config().hosts, join(root, 'hosts.json')),
      mirrorStore: new MirrorStore({ git: remote.git, root: join(root, 'mirrors'), limits: mirrorLimits() }),
    })
    const before = make()
    await allow(before, [repo.url])
    const leftover = await before.mirrors.store.acquire(repo.url, (await before.mirrors.sync(repo.url)).commit)
    const restarted = make()
    await restarted.mirrors.sync(repo.url)
    const lease = await restarted.mirrors.store.acquire(repo.url, repo.commit)
    expect(existsSync(leftover.dir)).toBe(false)
    expect(existsSync(join(lease.dir, 'README.md'))).toBe(true)

    git(repo.dir, 'checkout', '--quiet', '-b', 'next')
    writeFileSync(join(repo.dir, 'NEXT.md'), 'next\n')
    git(repo.dir, 'add', '.')
    git(repo.dir, 'commit', '--quiet', '-m', 'next')
    const moved = await restarted.mirrors.sync(repo.url)
    expect(moved).toMatchObject({ branch: 'next', defaultBranch: 'next', commit: git(repo.dir, 'rev-parse', 'HEAD') })
    expect(git(moved.dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/next')
    expect(existsSync(join(lease.dir, 'README.md'))).toBe(true)
    lease.release()
  })

  it('reports a missing branch and an invalid one', async () => {
    const { service, remote } = setup()
    const repo = origin(remote)
    await allow(service, [repo.url])
    await expect(service.mirrors.sync(repo.url, { branch: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.mirrors.sync(repo.url, { branch: '-x' })).rejects.toMatchObject({ code: 'invalid' })
    git(repo.dir, 'branch', 'dev')
    expect(await service.mirrors.sync(repo.url, { branch: 'dev' })).toMatchObject({ branch: 'dev', defaultBranch: 'main', commit: repo.commit })
  })
})

describe('mirror fetch state', () => {
  it('records each fetch, keeps a missing branch from counting as a failed fetch, and forgets everything when the directory changes', async () => {
    const { root, service, remote } = setup()
    const repo = origin(remote)
    await allow(service, [repo.url])
    expect(service.mirrors.status(repo.url)).toBeUndefined()
    await service.mirrors.prefetch(repo.url)
    const ready = service.mirrors.status(repo.url)
    expect(ready).toEqual({ state: 'ready', fetchedAt: expect.any(String) })
    await expect(service.mirrors.sync(repo.url, { branch: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    expect(service.mirrors.status(repo.url)).toMatchObject({ state: 'ready' })
    expect(await service.mirrors.branches(repo.url)).toEqual({ branches: ['main'], defaultBranch: 'main' })
    // A repository outside the catalog says nothing about the mirror.
    await expect(service.mirrors.sync('https://git.test/team/other')).rejects.toMatchObject({ code: 'not-allowed' })
    expect(service.mirrors.status('https://git.test/team/other')).toBeUndefined()
    await service.mirrors.setDir(join(root, 'moved'))
    expect(service.mirrors.status(repo.url)).toBeUndefined()
    expect(await service.mirrors.branches(repo.url)).toEqual({ branches: [] })
  })

  it('records a failed fetch with its reason, keeping the time of the last success', async () => {
    let fail = false
    const remote = fileRemote()
    const { service } = setup({ git: async (args, options) => { if (fail && args.includes('fetch')) throw new Error('remote hung up'); return await remote.git(args, options) } })
    const repo = origin(remote)
    await allow(service, [repo.url])
    await service.mirrors.prefetch(repo.url)
    const fetchedAt = service.mirrors.status(repo.url)?.fetchedAt
    fail = true
    await service.mirrors.prefetch(repo.url)
    expect(service.mirrors.status(repo.url)).toEqual({ state: 'failed', fetchedAt, error: expect.stringContaining('remote hung up') })
  })

  it('checks that a repository can be reached and has the branches an entry names, before it is in the catalog', async () => {
    const { service, remote } = setup()
    const repo = origin(remote)
    git(repo.dir, 'branch', 'dev')
    await service.mirrors.checkRemote(repo.url, [{ name: 'dev', label: '基线分支' }, { name: 'main', label: '本地同步分支' }])
    await expect(service.mirrors.checkRemote(repo.url, [{ name: 'release', label: '基线分支' }])).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('没有分支 release（基线分支）') })
    await expect(service.mirrors.checkRemote('https://git.test/team/missing', [])).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('mirror directory changes', () => {
  it('clones into the new directory and keeps held snapshots beside the old mirror', async () => {
    const { root, service, remote } = setup()
    const { url: source, commit } = origin(remote)
    await allow(service, [source])
    const first = await service.mirrors.sync(source)
    expect(first.dir.startsWith(join(root, 'mirrors'))).toBe(true)
    const lease = await service.mirrors.store.acquire(source, commit)
    expect(lease.dir.startsWith(join(root, 'mirrors', '.snapshots'))).toBe(true)

    const moved = join(root, 'moved')
    expect(await service.mirrors.setDir(moved)).toEqual({ dir: moved })
    expect(existsSync(lease.dir)).toBe(true)
    const second = await service.mirrors.sync(source)
    expect(second.dir.startsWith(moved)).toBe(true)
    expect(second.commit).toBe(commit)
    expect(existsSync(first.dir)).toBe(true)
    lease.release()
    expect((await service.mirrors.store.acquire(source, commit)).dir.startsWith(join(moved, '.snapshots'))).toBe(true)
    await expect(service.mirrors.setDir('~nobody/x')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses every mirror operation while no directory is chosen, and resumes after one is', async () => {
    const { root, service, remote } = setup()
    const { url: source, commit } = origin(remote)
    await allow(service, [source])
    expect(await service.mirrors.setDir(undefined)).toEqual({ dir: undefined })
    expect(service.mirrors.settings().dir).toBeUndefined()
    await expect(service.mirrors.sync(source)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('镜像目录未设置') })
    await expect(service.mirrors.store.acquire(source, commit)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.mirrors.usage()).rejects.toMatchObject({ code: 'unavailable' })
    await service.mirrors.setDir(join(root, 'chosen'))
    expect((await service.mirrors.sync(source)).commit).toBe(commit)
  })

  it('refuses a directory in a forbidden root, also through a symbolic link, and leaves the choice unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-repo-forbidden-'))
    const home = join(root, 'dsh-home')
    mkdirSync(home)
    symlinkSync(home, join(root, 'home-link'))
    const service = new RepoService({
      forbiddenMirrorRoots: [home, '/tmp/surely-missing-root'],
      credentials: credentials({}),
      store: new SettingsStore(testConfig().hosts, join(root, 'hosts.json')),
      mirrorStore: new MirrorStore({ git: runGit, root: undefined, limits: mirrorLimits() }),
    })
    for (const dir of [home, join(home, 'dsh-repo', 'mirrors'), join(home, '..mirrors'), join(root, 'home-link', 'mirrors'), '/tmp/surely-missing-root/x']) {
      await expect(service.mirrors.setDir(dir)).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('不能是') })
    }
    expect(service.mirrors.settings()).toEqual({ dir: undefined })
    expect(existsSync(join(home, 'dsh-repo'))).toBe(false)
    const allowed = join(root, 'mirrors')
    expect(await service.mirrors.setDir(allowed)).toEqual({ dir: allowed })
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
      store: new SettingsStore(testConfig().hosts, join(root, 'hosts.json')),
      mirrorStore: new MirrorStore({ git: runGit, root: undefined, limits: mirrorLimits() }),
    })
    expect(service.mirrors.settings()).toEqual({ dir: undefined, problem: expect.stringContaining(join(home, 'mirrors')) })
    expect(errors).toHaveLength(1)
  })
})
