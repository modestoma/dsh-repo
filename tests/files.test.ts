import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { JsonFile } from '../src/files.ts'
import { WorkspaceRegistry } from '../src/workspace/registry.ts'

const schema = z.object({ items: z.array(z.string()) }).strict()

function file(content?: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repo-files-'))
  const path = join(dir, 'data.json')
  if (content !== undefined) writeFileSync(path, content)
  return { dir, path }
}

describe('JsonFile', () => {
  it('starts empty without a file and writes each change before keeping it', async () => {
    const { path } = file()
    const json = new JsonFile({ file: path, label: '测试文件', schema, empty: { items: [] }, invalid: 'set-aside' })
    expect(json.value).toEqual({ items: [] })
    const results = await Promise.all([
      json.update(current => ({ value: { items: [...current.items, 'a'] }, result: 1 })),
      json.update(current => ({ value: { items: [...current.items, 'b'] }, result: 2 })),
    ])
    expect(results).toEqual([1, 2])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ items: ['a', 'b'] })
    expect(new JsonFile({ file: path, label: '测试文件', schema, empty: { items: [] }, invalid: 'fail' }).value).toEqual({ items: ['a', 'b'] })
  })

  it('sets an invalid file aside and reports it, or refuses to start on it', () => {
    const { dir, path } = file('{"items": [1]}')
    expect(() => new JsonFile({ file: path, label: '测试文件', schema, empty: { items: [] }, invalid: 'fail' })).toThrow(/测试文件 .* 内容不合法/)
    const warn = vi.fn()
    const json = new JsonFile({ file: path, label: '测试文件', schema, empty: { items: [] }, invalid: 'set-aside', logger: { warn } })
    expect(json.value).toEqual({ items: [] })
    expect(readdirSync(dir).filter(name => name.startsWith('data.json.invalid-'))).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已移到'))
  })

  it('keeps the value when the file cannot be written, and when a change throws', async () => {
    const { path } = file()
    mkdirSync(join(path, 'occupied'), { recursive: true })
    const json = new JsonFile({ file: path, label: '测试文件', schema, empty: { items: [] }, invalid: 'set-aside' })
    await expect(json.update(() => ({ value: { items: ['x'] }, result: undefined }))).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('无法写入测试文件') })
    await expect(json.update(() => { throw new Error('refused') })).rejects.toThrow('refused')
    expect(json.value).toEqual({ items: [] })
  })
})

describe('WorkspaceRegistry', () => {
  it('sets an unreadable workspaces.json aside instead of overwriting its records', async () => {
    const { dir } = file()
    const path = join(dir, 'workspaces.json')
    writeFileSync(path, '{"workspaces": [{"id": "broken"}]}')
    const registry = new WorkspaceRegistry(path)
    expect(registry.list()).toEqual([])
    const aside = readdirSync(dir).find(name => name.startsWith('workspaces.json.invalid-'))
    expect(aside).toBeDefined()
    await registry.setPort(4567)
    expect(readFileSync(join(dir, aside ?? ''), 'utf8')).toContain('broken')
    expect(new WorkspaceRegistry(path).port()).toBe(4567)
  })
})
