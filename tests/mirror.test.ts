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
import { credentials, testConfig } from './helpers.ts'

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
  const config = testConfig({ mirror: { otherHosts: options.otherHosts ?? true }, repos: ['github.com/modestoma/*', 'code.example.com/team/**'] })
  const service = new RepoService(config, {
    credentials: credentials(options.tokens ?? {}),
    hosts: new HostStore(config.hosts, join(root, 'hosts.json')),
    mirrors: new MirrorStore({ git: options.git ?? runGit, root: join(root, 'mirrors'), timeoutMs: 30_000, maxFileBytes: 64, maxTreeEntries: 10 }),
  })
  return { root, service }
}

describe('mirror addresses', () => {
  it('accepts git transports and lays mirrors out by host and path', () => {
    expect(isAcceptedGitUrl('git@github.com:modestoma/dsh-repo.git')).toBe(true)
    expect(isAcceptedGitUrl('ext::sh -c id')).toBe(false)
    expect(isAcceptedGitUrl('-u')).toBe(false)
    expect(mirrorPath('https://code.example.com:8443/gitlab/team/app.git')).toBe('code.example.com_8443/gitlab/team/app')
    expect(mirrorPath('git@github.com:modestoma/dsh-repo.git')).toBe('github.com/modestoma/dsh-repo')
    expect(mirrorPath('/srv/repos/app.git')).toMatch(/^local\/app-[0-9a-f]{8}$/)
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
    await expect(service.syncMirror('git@github.com:modestoma/app.git')).rejects.toMatchObject({ code: 'unavailable' })
    expect(calls[0]?.env).toEqual({})
    await expect(service.syncMirror('https://github.com/someone/app')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.syncMirror('https://ghe.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(setup({ git: fake, tokens: {} }).service.syncMirror('https://code.example.com/gitlab/team/app')).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(setup({ git: fake, otherHosts: false }).service.syncMirror('https://elsewhere.example.com/a/b')).rejects.toMatchObject({ code: 'not-allowed' })
    await expect(service.syncMirror('ext::sh')).rejects.toMatchObject({ code: 'invalid' })
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
