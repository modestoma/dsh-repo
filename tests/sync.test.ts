import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepoInput } from '../src/settings/contract.ts'
import { MirrorStore } from '../src/mirror/store.ts'
import { RepoService } from '../src/service.ts'
import { SyncStore } from '../src/sync/store.ts'
import { LocalSyncer, RETRY_MS, syncRecords } from '../src/sync/syncer.ts'
import { credentials, settingsStore, mirrorLimits, testSettings } from './helpers.ts'
import { fileRemote, REMOTE_HOST, REMOTE_TOKENS, remoteConfig } from './remote.ts'

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' }).trim()
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** Stand-in remote holding every test's repositories. */
const remote = fileRemote()
let repos = 0

/** A repository of the stand-in remote whose `main` holds two skill directories, and a `beta` branch. */
function origin(): { url: string; dir: string; commit: string } {
  repos += 1
  const { url, dir } = remote.repo(`skills/repo-${repos}`, { 'alpha/SKILL.md': 'alpha v1\n', 'gamma/SKILL.md': 'gamma\n' })
  mkdirSync(join(dir, 'alpha', 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  const commit = commitAll(dir, 'script')
  git(dir, 'checkout', '--quiet', '-b', 'beta')
  writeFileSync(join(dir, 'beta.md'), 'beta only\n')
  commitAll(dir, 'beta')
  git(dir, 'checkout', '--quiet', 'main')
  return { url, dir, commit }
}

/** Catalog fields of a repository with its local sync enabled. */
function synced(url: string, dir: string, extra: { branch?: string; intervalMinutes?: number; enabled?: boolean } = {}): RepoInput {
  return {
    url,
    access: 'read',
    features: [],
    localSync: { enabled: extra.enabled ?? true, dir, ...extra.intervalMinutes === undefined ? {} : { intervalMinutes: extra.intervalMinutes }, ...extra.branch === undefined ? {} : { branch: extra.branch } },
  }
}

/** A service with a catalog, and syncers over it that follow catalog changes the way the plugin wires them. */
function setup(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repo-sync-'))
  const service = new RepoService({
    forbiddenMirrorRoots: [],
    credentials: credentials(REMOTE_TOKENS),
    store: settingsStore(remoteConfig(), root, testSettings()),
    mirrorStore: new MirrorStore({ git: remote.git, root: join(root, 'mirrors'), limits: mirrorLimits() }),
  })
  const { catalog } = service
  const make = (): LocalSyncer => {
    const syncer = new LocalSyncer({
      mirrors: service.mirrors,
      records: () => syncRecords(catalog.entries()),
      ids: () => new Set(catalog.entries().map(entry => entry.id)),
      git: remote.git,
      store: new SyncStore(join(root, 'local-syncs.json')),
      indexDir: join(root, 'syncs'),
      timeoutMs: () => 30_000,
      ...now === undefined ? {} : { now },
    })
    syncer.start()
    const unlisten = service.catalog.onChange(() => { syncer.reconcile() })
    const stop = syncer.stop.bind(syncer)
    syncer.stop = async () => {
      unlisten()
      await stop()
    }
    return syncer
  }
  const syncer = make()
  /** Add an entry and wait for the sync it starts. */
  const add = async (input: RepoInput, by = syncer) => {
    const entry = await catalog.add(input)
    await by.settled(entry.id)
    return { id: entry.id, status: by.status(entry.id) }
  }
  /** Change an entry and wait for the sync it starts. */
  const update = async (id: string, input: RepoInput, by = syncer) => {
    await catalog.update(id, input)
    await by.settled(id)
    return by.status(id)
  }
  return { root, service, catalog, syncer, make, add, update }
}

describe('local syncs', () => {
  it('expands the default branch into a directory as plain files and follows later commits', async () => {
    const repo = origin()
    const { root, syncer, add } = setup()
    const dir = join(root, 'shared', 'skills')
    const { id, status } = await add(synced(repo.url, dir))
    expect(status).toMatchObject({ state: 'idle', commit: repo.commit, syncedBranch: 'main' })
    expect(status?.error).toBeUndefined()
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
    await syncer.syncNow(id)
    expect(syncer.status(id)?.commit).toBe(second)
    expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v2\n')
    expect(existsSync(join(dir, 'gamma'))).toBe(false)
    expect(readFileSync(join(dir, 'delta', 'SKILL.md'), 'utf8')).toBe('delta\n')
    expect(readFileSync(join(dir, 'mine.md'), 'utf8')).toBe('kept\n')
    await syncer.stop()
  })

  it('restores files edited or deleted locally and leaves unchanged files untouched', async () => {
    const repo = origin()
    const { root, syncer, add } = setup()
    const dir = join(root, 'out')
    const { id } = await add(synced(repo.url, dir))
    const untouched = statSync(join(dir, 'gamma', 'SKILL.md')).mtimeMs
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), 'edited locally\n')
    rmSync(join(dir, 'alpha', 'scripts'), { recursive: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    await syncer.syncNow(id)
    expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v1\n')
    expect(existsSync(join(dir, 'alpha', 'scripts', 'run.sh'))).toBe(true)
    expect(statSync(join(dir, 'gamma', 'SKILL.md')).mtimeMs).toBe(untouched)
    await syncer.stop()
  })

  it('follows the catalog branch and moves to another directory only when that one is empty', async () => {
    const repo = origin()
    const { root, syncer, add, update } = setup()
    const first = join(root, 'first')
    const { id, status } = await add(synced(repo.url, first, { branch: 'beta' }))
    expect(status?.syncedBranch).toBe('beta')
    expect(existsSync(join(first, 'beta.md'))).toBe(true)

    const busy = join(root, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'note.txt'), 'x')
    const refused = await update(id, synced(repo.url, busy, { branch: 'beta' }))
    expect(refused?.error).toContain('不是空目录')
    expect(refused?.commit).toBeUndefined()
    expect(readFileSync(join(busy, 'note.txt'), 'utf8')).toBe('x')
    expect(existsSync(join(busy, 'beta.md'))).toBe(false)

    const second = join(root, 'second')
    const moved = await update(id, synced(repo.url, second, { branch: '' }))
    expect(moved).toMatchObject({ syncedBranch: 'main' })
    expect(moved?.error).toBeUndefined()
    expect(existsSync(join(second, 'beta.md'))).toBe(false)
    expect(existsSync(join(first, 'beta.md'))).toBe(true)
    await syncer.stop()
  })

  it('syncs the local sync\'s own branch, else the entry\'s baseline branch', () => {
    const entry = { id: '000000000001', url: 'https://git.test/a/b', access: 'read' as const, features: [], addedAt: 't', localSync: { enabled: true, dir: '/srv/b', intervalMinutes: 60 } }
    expect(syncRecords([entry])[0]).not.toHaveProperty('branch')
    expect(syncRecords([{ ...entry, base: 'dev' }])[0]).toMatchObject({ branch: 'dev' })
    expect(syncRecords([{ ...entry, base: 'dev', localSync: { ...entry.localSync, branch: 'release' } }])[0]).toMatchObject({ branch: 'release' })
    expect(syncRecords([{ ...entry, localSync: { ...entry.localSync, enabled: false } }])).toEqual([])
  })

  it('refuses a non-empty directory on the first sync and reports the failure on the sync', async () => {
    const repo = origin()
    const { root, syncer, add } = setup()
    const dir = join(root, 'taken')
    mkdirSync(dir)
    writeFileSync(join(dir, 'SKILL.md'), 'mine\n')
    const { status } = await add(synced(repo.url, dir))
    expect(status).toMatchObject({ state: 'idle', error: expect.stringContaining('不是空目录') })
    expect(status?.commit).toBeUndefined()
    expect(status?.failedAt).toBeDefined()
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('mine\n')
    await syncer.stop()
  })

  it('validates local sync fields and refuses overlapping directories of enabled syncs', async () => {
    const [one, two, three] = [origin(), origin(), origin()]
    const { root, catalog, syncer, add } = setup()
    const refused = async (input: RepoInput, code: string) => { await expect(catalog.add(input)).rejects.toMatchObject({ code }) }
    await refused(synced('git@github.com:a/b.git', join(root, 'x')), 'invalid')
    await refused(synced(one.url, 'relative'), 'invalid')
    await refused(synced(one.url, '/'), 'invalid')
    await refused(synced(one.url, ''), 'invalid')
    await refused(synced(one.url, join(root, 'x'), { branch: 'a..b' }), 'invalid')
    await refused(synced(one.url, join(root, 'x'), { intervalMinutes: 1 }), 'invalid')
    await refused(synced(one.url, join(root, 'mirrors', 'inside')), 'conflict')
    await refused(synced(one.url, root), 'conflict')
    const { id } = await add(synced(one.url, join(root, 'a')))
    await expect(catalog.add(synced(two.url, join(root, 'a', 'nested')))).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('重叠') })
    await refused(synced(two.url, join(root, 'a', '..nested')), 'conflict')
    await refused(synced(one.url, join(root, 'b')), 'conflict')
    expect(catalog.entries()).toHaveLength(1)
    expect((await add(synced(two.url, join(root, '..a')))).status?.error).toBeUndefined()
    // A disabled sync keeps its directory without claiming it, and needs none.
    await catalog.add(synced(three.url, join(root, 'a', 'later'), { enabled: false }))
    expect(catalog.entries().find(entry => entry.url === three.url)?.localSync).toEqual({ enabled: false, dir: join(root, 'a', 'later'), intervalMinutes: 720 })
    await expect(catalog.update(id, { url: one.url, access: 'read', features: [], localSync: { enabled: false, dir: '' } })).resolves.not.toHaveProperty('localSync')
    await expect(syncer.syncNow(id)).rejects.toMatchObject({ code: 'not-found' })
    expect(syncer.status(id)).toBeUndefined()
    await syncer.stop()
  })

  it('keeps tracking the old directory after a refused move, so upstream deletions still apply there', async () => {
    const repo = origin()
    const { root, syncer, add, update } = setup()
    const first = join(root, 'first')
    const { id } = await add(synced(repo.url, first))
    const busy = join(root, 'busy')
    mkdirSync(busy)
    writeFileSync(join(busy, 'note.txt'), 'x')
    expect((await update(id, synced(repo.url, busy)))?.error).toContain('不是空目录')
    rmSync(join(repo.dir, 'gamma'), { recursive: true })
    commitAll(repo.dir, 'drop gamma')
    const back = await update(id, synced(repo.url, first))
    expect(back?.error).toBeUndefined()
    expect(existsSync(join(first, 'gamma'))).toBe(false)
    expect(readFileSync(join(busy, 'note.txt'), 'utf8')).toBe('x')
    await syncer.stop()
  })

  it('keeps the progress of a disabled sync and continues in the same directory when enabled again', async () => {
    const repo = origin()
    const { root, syncer, add, update } = setup()
    const dir = join(root, 'out')
    const { id } = await add(synced(repo.url, dir))
    expect(await update(id, synced(repo.url, dir, { enabled: false }))).toBeUndefined()
    writeFileSync(join(repo.dir, 'later.md'), 'later\n')
    const head = commitAll(repo.dir, 'later')
    const again = await update(id, synced(repo.url, dir))
    expect(again).toMatchObject({ commit: head })
    expect(again?.error).toBeUndefined()
    expect(readFileSync(join(dir, 'later.md'), 'utf8')).toBe('later\n')
    await syncer.stop()
  })

  it('retries a first sync that wrote files but did not record its result', async () => {
    const repo = origin()
    const { root, syncer, make, add } = setup()
    const dir = join(root, 'out')
    const { id } = await add(synced(repo.url, dir))
    await syncer.stop()
    // Simulate an interruption between writing files and recording the result.
    const file = join(root, 'local-syncs.json')
    writeFileSync(file, JSON.stringify({ syncs: [{ id, claimedDir: dir }] }))
    const restarted = make()
    await restarted.syncNow(id)
    expect(restarted.status(id)?.error).toBeUndefined()
    expect(restarted.status(id)?.commit).toBe(repo.commit)
    expect(JSON.parse(readFileSync(file, 'utf8')).syncs[0].claimedDir).toBeUndefined()
    await restarted.stop()
  })

  it('refuses directories that overlap through a symbolic link', async () => {
    const [one, two] = [origin(), origin()]
    const { root, catalog, syncer, add } = setup()
    const out = join(root, 'data', 'out')
    await add(synced(one.url, out))
    symlinkSync(out, join(root, 'data', 'alias'))
    await expect(catalog.add(synced(two.url, join(root, 'data', 'alias', 'nested')))).rejects.toMatchObject({ code: 'conflict' })
    symlinkSync(join(root, 'mirrors'), join(root, 'mirror-link'))
    await expect(catalog.add(synced(two.url, join(root, 'mirror-link', 'x')))).rejects.toMatchObject({ code: 'conflict' })
    await syncer.stop()
  })

  it('refuses to sync once the mirror directory was moved over the sync directory', async () => {
    const repo = origin()
    const { root, service, syncer, add } = setup()
    const dir = join(root, 'out')
    const { id } = await add(synced(repo.url, dir))
    await service.mirrors.setDir(join(dir, 'mirrors'))
    await syncer.syncNow(id)
    expect(syncer.status(id)?.error).toContain('镜像目录')
    expect(existsSync(join(dir, 'mirrors', 'local'))).toBe(false)
    await syncer.stop()
  })

  it('forgets the progress and index of a repository removed from the catalog and keeps its files', async () => {
    const repo = origin()
    const { root, catalog, syncer, add } = setup()
    const dir = join(root, 'out')
    const { id } = await add(synced(repo.url, dir))
    expect(readdirSync(join(root, 'syncs')).filter(name => name.startsWith(id))).toHaveLength(1)
    await catalog.remove(id)
    await syncer.settled(id)
    expect(syncer.status(id)).toBeUndefined()
    expect(readdirSync(join(root, 'syncs'))).toEqual([])
    expect(existsSync(join(dir, 'alpha', 'SKILL.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'local-syncs.json'), 'utf8'))).toEqual({ syncs: [] })
    await syncer.stop()
  })

  it('schedules the next sync from the stored last success across restarts', async () => {
    const repo = origin()
    let clock = Date.parse('2026-11-01T00:00:00.000Z')
    const { root, syncer, make, add, update } = setup(() => clock)
    const dir = join(root, 'out')
    const { id, status } = await add(synced(repo.url, dir, { intervalMinutes: 60 }))
    expect(status?.nextAt).toBe('2026-11-01T01:00:00.000Z')
    expect((await update(id, synced(repo.url, dir, { intervalMinutes: 120 })))?.nextAt).toBe('2026-11-01T02:00:00.000Z')
    await syncer.stop()

    clock = Date.parse('2026-11-01T00:30:00.000Z')
    const restarted = make()
    expect(restarted.status(id)).toMatchObject({ syncedAt: '2026-11-01T00:00:00.000Z', nextAt: '2026-11-01T02:00:00.000Z', state: 'idle' })
    await restarted.stop()

    clock = Date.parse('2026-11-01T03:00:00.000Z')
    writeFileSync(join(repo.dir, 'new.md'), 'new\n')
    const head = commitAll(repo.dir, 'new')
    const overdue = make()
    expect(overdue.status(id)?.nextAt).toBe('2026-11-01T02:00:00.000Z')
    await new Promise(resolve => setTimeout(resolve, 10))
    await overdue.idle()
    expect(overdue.status(id)).toMatchObject({ commit: head, syncedAt: '2026-11-01T03:00:00.000Z', nextAt: '2026-11-01T05:00:00.000Z' })
    await overdue.stop()
  })

  it('retries a failed sync sooner than a long interval', async () => {
    const clock = Date.parse('2026-11-01T00:00:00.000Z')
    const { root, syncer, add } = setup(() => clock)
    const { status } = await add(synced(`${REMOTE_HOST}/skills/missing`, join(root, 'out')))
    expect(status?.error).toBeDefined()
    expect(status?.nextAt).toBe(new Date(clock + RETRY_MS).toISOString())
    await syncer.stop()
  })
})
