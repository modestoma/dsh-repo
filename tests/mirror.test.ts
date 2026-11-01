import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostStore } from '../src/hosts.ts'
import { credentialEnvironment, runGit } from '../src/mirror/git.ts'
import type { GitRunner } from '../src/mirror/git.ts'
import { isAcceptedGitUrl, mirrorPath, MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { credentials, hostStore, mirrorLimits, testConfig, testSettings, withMirrors } from './helpers.ts'

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

function setup(options: { git?: GitRunner; otherHosts?: boolean; tokens?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-mirrors-'))
  const config = testConfig()
  const settings = testSettings({ mirror: { otherHosts: options.otherHosts ?? true }, repos: ['github.com/modestoma/*', 'code.example.com/team/**'] })
  const service = new RepoService({
    credentials: credentials(options.tokens ?? {}),
    hosts: hostStore(config, root, settings),
    ...withMirrors(new MirrorStore({ git: options.git ?? runGit, root: join(root, 'mirrors'), limits: mirrorLimits(64, 10) }), options.git ?? runGit),
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
    expect(mirrorPath('https://code.example.com:8443/gitlab/team/app.git')).toBe('code.example.com_8443/gitlab/team/app')
    expect(mirrorPath('/srv/repos/app.git')).toMatch(/^local\/app-[0-9a-f]{8}$/)
    expect(mirrorPath('https://github.com/team/.github.git')).toMatch(/^github\.com\/team\/github-[0-9a-f]{6}$/)
    expect(mirrorPath('https://github.com/team/github.git')).toBe('github.com/team/github')
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
    await expect(service.syncMirror('https://elsewhere.example.com/a/b')).rejects.toMatchObject({ code: 'unavailable' })
    expect(calls[0]?.env).toEqual({})
    await expect(service.syncMirror('https://github.com/someone/app')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.syncMirror('https://ghe.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(setup({ git: fake, tokens: {} }).service.syncMirror('https://code.example.com/gitlab/team/app')).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(setup({ git: fake, otherHosts: false }).service.syncMirror('https://elsewhere.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
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
  it('clones, fetches, reads files and trees, and shares snapshots', async () => {
    const repo = origin()
    const { service } = setup()
    const first = await service.syncMirror(repo.dir)
    expect(first).toMatchObject({ url: repo.dir, branch: 'main', commit: repo.commit })
    expect(existsSync(join(first.dir, '.git'))).toBe(true)
    expect(existsSync(join(first.dir, 'README.md'))).toBe(false)

    expect(await service.readMirrorFile(repo.dir, repo.commit, 'README.md')).toBe('hello\n')
    expect(await service.readMirrorFile(repo.dir, repo.commit, 'missing.md')).toBeUndefined()
    await expect(service.readMirrorFile(repo.dir, repo.commit, 'link')).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.readMirrorFile(repo.dir, repo.commit, 'docs')).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.readMirrorFile(repo.dir, repo.commit, '../x')).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.readMirrorFile(repo.dir, 'f'.repeat(40), 'README.md')).rejects.toMatchObject({ code: 'not-found' })
    expect(await service.listMirrorTree(repo.dir, repo.commit, 'docs')).toEqual([{ path: 'docs/run.sh', type: 'file', executable: true }])
    expect((await service.listMirrorTree(repo.dir, repo.commit, '')).map(entry => entry.type).sort()).toEqual(['dir', 'file', 'file', 'symlink'])

    const a = await service.acquireSnapshot(repo.dir, repo.commit)
    const b = await service.acquireSnapshot(repo.dir, repo.commit)
    expect(a.dir).toBe(b.dir)
    expect(existsSync(join(a.dir, 'README.md'))).toBe(true)

    writeFileSync(join(repo.dir, 'README.md'), 'changed\n')
    git(repo.dir, 'commit', '--quiet', '-am', 'change')
    const second = await service.syncMirror(repo.dir)
    expect(second.commit).not.toBe(repo.commit)
    a.release()
    a.release()
    expect(existsSync(a.dir)).toBe(true)
    b.release()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(a.dir)).toBe(false)
  })

  it('keeps a lease taken before the first sync of this process, and follows a changed default branch', async () => {
    const repo = origin()
    const config = testConfig()
    const root = mkdtempSync(join(tmpdir(), 'dsh-repo-restart-'))
    const make = () => new RepoService({
      credentials: credentials({}),
      hosts: new HostStore(config.hosts, join(root, 'hosts.json')),
      ...withMirrors(new MirrorStore({ git: runGit, root: join(root, 'mirrors'), limits: mirrorLimits(64, 10) })),
    })
    const leftover = await make().acquireSnapshot(repo.dir, (await make().syncMirror(repo.dir)).commit)
    const restarted = make()
    const lease = await restarted.acquireSnapshot(repo.dir, repo.commit)
    expect(existsSync(leftover.dir)).toBe(false)
    expect(existsSync(join(lease.dir, 'README.md'))).toBe(true)
    await restarted.syncMirror(repo.dir)
    expect(existsSync(join(lease.dir, 'README.md'))).toBe(true)

    git(repo.dir, 'checkout', '--quiet', '-b', 'next')
    writeFileSync(join(repo.dir, 'NEXT.md'), 'next\n')
    git(repo.dir, 'add', '.')
    git(repo.dir, 'commit', '--quiet', '-m', 'next')
    expect(await restarted.syncMirror(repo.dir)).toMatchObject({ branch: 'next', commit: git(repo.dir, 'rev-parse', 'HEAD') })
    lease.release()
  })

  it('reports a missing branch, an unsynced mirror, and a large file', async () => {
    const repo = origin()
    const { service } = setup()
    await expect(service.readMirrorFile(repo.dir, repo.commit, 'README.md')).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.syncMirror(repo.dir, { branch: 'nope' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.syncMirror(repo.dir, { branch: '-x' })).rejects.toMatchObject({ code: 'invalid' })
    writeFileSync(join(repo.dir, 'big.txt'), 'x'.repeat(100))
    git(repo.dir, 'add', '.')
    git(repo.dir, 'commit', '--quiet', '-m', 'big')
    const state = await service.syncMirror(repo.dir, { branch: 'main' })
    await expect(service.readMirrorFile(repo.dir, state.commit, 'big.txt')).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('mirror directory changes', () => {
  it('clones into the new directory and keeps held snapshots beside the old mirror', async () => {
    const { dir: source, commit } = origin()
    const { root, service } = setup()
    const first = await service.syncMirror(source)
    expect(first.dir.startsWith(join(root, 'mirrors'))).toBe(true)
    const lease = await service.acquireSnapshot(source, commit)
    expect(lease.dir.startsWith(join(root, 'mirrors', '.snapshots'))).toBe(true)

    const moved = join(root, 'moved')
    expect(await service.setMirrorDir(moved)).toEqual({ dir: moved, defaultDir: join(root, 'mirrors') })
    expect(existsSync(lease.dir)).toBe(true)
    const second = await service.syncMirror(source)
    expect(second.dir.startsWith(moved)).toBe(true)
    expect(second.commit).toBe(commit)
    expect(existsSync(first.dir)).toBe(true)
    lease.release()
    expect((await service.acquireSnapshot(source, commit)).dir.startsWith(join(moved, '.snapshots'))).toBe(true)
    await expect(service.setMirrorDir('~nobody/x')).rejects.toMatchObject({ code: 'invalid' })
  })
})
