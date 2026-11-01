import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGit } from '../src/mirror/git.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { SyncStore } from '../src/sync/store.ts'
import { LocalSyncer, RETRY_MS } from '../src/sync/syncer.ts'
import { credentials, hostStore, mirrorLimits, testConfig, testSettings, withMirrors } from './helpers.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** A repository whose `main` holds two skill directories, and a `beta` branch. */
function origin(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-sync-origin-'))
  git(dir, 'init', '--quiet', '--initial-branch=main')
  mkdirSync(join(dir, 'alpha', 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'alpha', 'SKILL.md'), 'alpha v1\n')
  writeFileSync(join(dir, 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  mkdirSync(join(dir, 'gamma'))
  writeFileSync(join(dir, 'gamma', 'SKILL.md'), 'gamma\n')
  const commit = commitAll(dir, 'init')
  git(dir, 'checkout', '--quiet', '-b', 'beta')
  writeFileSync(join(dir, 'beta.md'), 'beta only\n')
  commitAll(dir, 'beta')
  git(dir, 'checkout', '--quiet', 'main')
  return { dir, commit }
}

function setup(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-sync-'))
  const hosts = hostStore(testConfig(), root, testSettings())
  const service = new RepoService({
    credentials: credentials({}),
    hosts,
    ...withMirrors(new MirrorStore({ git: runGit, root: join(root, 'mirrors'), limits: mirrorLimits(1024 * 1024, 1000) })),
  })
  const make = () => new LocalSyncer({
    service,
    git: runGit,
    store: new SyncStore(join(root, 'syncs.json')),
    indexDir: join(root, 'syncs'),
    timeoutMs: () => 30_000,
    ...now === undefined ? {} : { now },
  })
  return { root, service, syncer: make(), make }
}

describe('local syncs', () => {
  it('expands the default branch into a directory as plain files and follows later commits', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const dir = join(root, 'shared', 'skills')
    const added = await syncer.add({ url: repo.dir, dir })
    expect(added).toMatchObject({ url: repo.dir, dir, intervalMinutes: 720, state: 'idle', commit: repo.commit, syncedBranch: 'main' })
    expect(added.error).toBeUndefined()
    expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v1\n')
    expect(statSync(join(dir, 'alpha', 'scripts', 'run.sh')).mode & 0o111).not.toBe(0)
    expect(existsSync(join(dir, '.git'))).toBe(false)
    expect(existsSync(join(dir, 'beta.md'))).toBe(false)

    writeFileSync(join(repo.dir, 'alpha', 'SKILL.md'), 'alpha v2\n')
    rmSync(join(repo.dir, 'gamma'), { recursive: true })
    mkdirSync(join(repo.dir, 'delta'))
    writeFileSync(join(repo.dir, 'delta', 'SKILL.md'), 'delta\n')
    const second = commitAll(repo.dir, 'second')
    writeFileSync(join(dir, 'mine.md'), 'kept\n')
    const synced = await syncer.syncNow(added.id)
    expect(synced.commit).toBe(second)
    expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v2\n')
    expect(existsSync(join(dir, 'gamma'))).toBe(false)
    expect(readFileSync(join(dir, 'delta', 'SKILL.md'), 'utf8')).toBe('delta\n')
    expect(readFileSync(join(dir, 'mine.md'), 'utf8')).toBe('kept\n')
  })

  it('restores files edited or deleted locally and leaves unchanged files untouched', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const dir = join(root, 'out')
    const { id } = await syncer.add({ url: repo.dir, dir })
    const untouched = statSync(join(dir, 'gamma', 'SKILL.md')).mtimeMs
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), 'edited locally\n')
    rmSync(join(dir, 'alpha', 'scripts'), { recursive: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    await syncer.syncNow(id)
    expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v1\n')
    expect(existsSync(join(dir, 'alpha', 'scripts', 'run.sh'))).toBe(true)
    expect(statSync(join(dir, 'gamma', 'SKILL.md')).mtimeMs).toBe(untouched)
  })

  it('follows a chosen branch and moves to another directory only when that one is empty', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const first = join(root, 'first')
    const added = await syncer.add({ url: repo.dir, branch: 'beta', dir: first })
    expect(added.syncedBranch).toBe('beta')
    expect(existsSync(join(first, 'beta.md'))).toBe(true)

    const busy = join(root, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'note.txt'), 'x')
    const refused = await syncer.update(added.id, { url: repo.dir, branch: 'beta', dir: busy })
    expect(refused.error).toContain('不是空目录')
    expect(readFileSync(join(busy, 'note.txt'), 'utf8')).toBe('x')
    expect(existsSync(join(busy, 'beta.md'))).toBe(false)

    const second = join(root, 'second')
    const moved = await syncer.update(added.id, { url: repo.dir, branch: '', dir: second })
    expect(moved).toMatchObject({ dir: second, syncedBranch: 'main' })
    expect(moved.branch).toBeUndefined()
    expect(moved.error).toBeUndefined()
    expect(existsSync(join(second, 'beta.md'))).toBe(false)
    expect(existsSync(join(first, 'beta.md'))).toBe(true)
  })

  it('refuses a non-empty directory on the first sync and reports the failure on the sync', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const dir = join(root, 'taken')
    mkdirSync(dir)
    writeFileSync(join(dir, 'SKILL.md'), 'mine\n')
    const added = await syncer.add({ url: repo.dir, dir })
    expect(added).toMatchObject({ state: 'idle', error: expect.stringContaining('不是空目录') })
    expect(added.commit).toBeUndefined()
    expect(added.failedAt).toBeDefined()
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('mine\n')
  })

  it('validates fields and refuses overlapping directories', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    await expect(syncer.add({ url: 'git@github.com:a/b.git', dir: join(root, 'x') })).rejects.toMatchObject({ code: 'invalid' })
    await expect(syncer.add({ url: repo.dir, dir: 'relative' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(syncer.add({ url: repo.dir, dir: '/' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'x'), branch: 'a..b' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'x'), intervalMinutes: 1 })).rejects.toMatchObject({ code: 'invalid' })
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'mirrors', 'inside') })).rejects.toMatchObject({ code: 'conflict' })
    await expect(syncer.add({ url: repo.dir, dir: root })).rejects.toMatchObject({ code: 'conflict' })
    await syncer.add({ url: repo.dir, dir: join(root, 'a') })
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'a', 'nested') })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('重叠') })
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'a', '..nested') })).rejects.toMatchObject({ code: 'conflict' })
    expect(syncer.list()).toHaveLength(1)
    expect((await syncer.add({ url: repo.dir, dir: join(root, '..a') })).error).toBeUndefined()
    expect(syncer.list()).toHaveLength(2)
    await expect(syncer.update('000000000000', { url: repo.dir, dir: join(root, 'b') })).rejects.toMatchObject({ code: 'not-found' })
    await expect(syncer.syncNow('000000000000')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('keeps tracking the old directory after a refused move, so upstream deletions still apply there', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const first = join(root, 'first')
    const { id } = await syncer.add({ url: repo.dir, dir: first })
    const busy = join(root, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'note.txt'), 'x')
    expect((await syncer.update(id, { url: repo.dir, dir: busy })).error).toContain('不是空目录')
    rmSync(join(repo.dir, 'gamma'), { recursive: true })
    commitAll(repo.dir, 'drop gamma')
    const back = await syncer.update(id, { url: repo.dir, dir: first })
    expect(back.error).toBeUndefined()
    expect(existsSync(join(first, 'gamma'))).toBe(false)
    expect(readFileSync(join(busy, 'note.txt'), 'utf8')).toBe('x')
  })

  it('retries a first sync that wrote files but did not record its result', async () => {
    const repo = origin()
    const { root, make } = setup()
    const dir = join(root, 'out')
    const syncer = make()
    const { id } = await syncer.add({ url: repo.dir, dir })
    // Simulate an interruption between writing files and recording the result.
    const file = join(root, 'syncs.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { syncs: Record<string, unknown>[] }
    const { last: _last, ...record } = stored.syncs[0] as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ syncs: [{ ...record, claimedDir: dir }] }))
    const restarted = make()
    const retried = await restarted.syncNow(id)
    expect(retried.error).toBeUndefined()
    expect(retried.commit).toBe(repo.commit)
    expect(JSON.parse(readFileSync(file, 'utf8')).syncs[0].claimedDir).toBeUndefined()
  })

  it('refuses directories that overlap through a symbolic link', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const out = join(root, 'data', 'out')
    await syncer.add({ url: repo.dir, dir: out })
    symlinkSync(out, join(root, 'data', 'alias'))
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'data', 'alias', 'nested') })).rejects.toMatchObject({ code: 'conflict' })
    symlinkSync(join(root, 'mirrors'), join(root, 'mirror-link'))
    await expect(syncer.add({ url: repo.dir, dir: join(root, 'mirror-link', 'x') })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses to sync once the mirror directory was moved over the sync directory', async () => {
    const repo = origin()
    const { root, service, syncer } = setup()
    const dir = join(root, 'out')
    const { id } = await syncer.add({ url: repo.dir, dir })
    await service.setMirrorDir(join(dir, 'mirrors'))
    const refused = await syncer.syncNow(id)
    expect(refused.error).toContain('镜像目录')
    expect(existsSync(join(dir, 'mirrors', 'local'))).toBe(false)
  })

  it('removes a sync with its index and keeps the files', async () => {
    const repo = origin()
    const { root, syncer } = setup()
    const dir = join(root, 'out')
    const { id } = await syncer.add({ url: repo.dir, dir })
    expect(readdirSync(join(root, 'syncs')).filter(name => name.startsWith(id))).toHaveLength(1)
    expect(await syncer.remove(id)).toBe(true)
    expect(await syncer.remove(id)).toBe(false)
    expect(syncer.list()).toEqual([])
    expect(readdirSync(join(root, 'syncs'))).toEqual([])
    expect(existsSync(join(dir, 'alpha', 'SKILL.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'syncs.json'), 'utf8'))).toEqual({ syncs: [] })
  })

  it('schedules the next sync from the stored last success across restarts', async () => {
    const repo = origin()
    let clock = Date.parse('2026-11-01T00:00:00.000Z')
    const { root, syncer, make } = setup(() => clock)
    syncer.start()
    const added = await syncer.add({ url: repo.dir, dir: join(root, 'out'), intervalMinutes: 60 })
    expect(added.nextAt).toBe('2026-11-01T01:00:00.000Z')
    await syncer.update(added.id, { url: repo.dir, dir: join(root, 'out'), intervalMinutes: 120 })
    expect(syncer.list()[0]?.nextAt).toBe('2026-11-01T02:00:00.000Z')
    await syncer.stop()

    clock = Date.parse('2026-11-01T00:30:00.000Z')
    const restarted = make()
    restarted.start()
    expect(restarted.list()[0]).toMatchObject({ syncedAt: '2026-11-01T00:00:00.000Z', nextAt: '2026-11-01T02:00:00.000Z', state: 'idle' })
    await restarted.stop()

    clock = Date.parse('2026-11-01T03:00:00.000Z')
    writeFileSync(join(repo.dir, 'new.md'), 'new\n')
    const head = commitAll(repo.dir, 'new')
    const overdue = make()
    overdue.start()
    expect(overdue.list()[0]?.nextAt).toBe('2026-11-01T02:00:00.000Z')
    await new Promise(resolve => setTimeout(resolve, 10))
    await overdue.idle()
    expect(overdue.list()[0]).toMatchObject({ commit: head, syncedAt: '2026-11-01T03:00:00.000Z', nextAt: '2026-11-01T05:00:00.000Z' })
    await overdue.stop()
  })

  it('retries a failed sync sooner than a long interval', async () => {
    const clock = Date.parse('2026-11-01T00:00:00.000Z')
    const { root, syncer } = setup(() => clock)
    syncer.start()
    const added = await syncer.add({ url: join(root, 'missing-repo'), dir: join(root, 'out') })
    expect(added.error).toBeDefined()
    expect(added.nextAt).toBe(new Date(clock + RETRY_MS).toISOString())
    await syncer.stop()
  })
})
