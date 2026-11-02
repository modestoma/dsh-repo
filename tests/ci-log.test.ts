import { describe, expect, it } from 'vitest'
import { LogCleaner, readLog } from '../src/ci/log.ts'
import type { LogQuery } from '../src/ci/log.ts'

/** A byte stream of the given chunks. */
function stream(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
}

const signal = new AbortController().signal

async function read(log: string | ReadableStream<Uint8Array>, query: Partial<LogQuery> = {}) {
  return await readLog(typeof log === 'string' ? stream(log) : log, { context: 3, maxBytes: 32 * 1024, ...query }, signal)
}

const GITLAB = [
  '\x1b[0KRunning with gitlab-runner 17.0.0',
  'section_start:1700000000:prepare_executor\r\x1b[0K\x1b[0K\x1b[36;1mPreparing the "docker" executor\x1b[0;m',
  'Using Docker executor',
  'section_end:1700000001:prepare_executor\r\x1b[0K',
  'section_start:1700000002:step_script[collapsed=false]\r\x1b[0K\x1b[0K\x1b[36;1mExecuting "step_script" stage of the job script\x1b[0;m',
  '$ npm test',
  'Downloading 10%\rDownloading 50%\rDownloading 100%\r',
  '\x1b[31mFAIL\x1b[0m src/a.test.ts',
  '  expected 1 to be 2',
  'section_end:1700000003:step_script\r\x1b[0K',
  '\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m',
].join('\n')

const GITHUB = [
  '﻿2026-11-02T10:00:00.0000000Z ##[group]Run actions/checkout@v4',
  '2026-11-02T10:00:00.1000000Z with:',
  '2026-11-02T10:00:00.2000000Z ##[endgroup]',
  '2026-11-02T10:00:01.0000000Z ##[group]Run npm test',
  '2026-11-02T10:00:01.1000000Z > vitest run',
  '2026-11-02T10:00:02.0000000Z ##[endgroup]',
  '2026-11-02T10:00:03.0000000Z ##[error]Process completed with exit code 1.',
].join('\n')

describe('LogCleaner', () => {
  it('turns GitLab section markers into titled lines and drops marker-only lines', () => {
    const cleaner = new LogCleaner()
    const lines = GITLAB.split('\n').map(raw => cleaner.line(raw).line?.text)
    expect(lines).toEqual([
      'Running with gitlab-runner 17.0.0',
      '▶ prepare_executor: Preparing the "docker" executor',
      'Using Docker executor',
      undefined,
      '▶ step_script: Executing "step_script" stage of the job script',
      '$ npm test',
      'Downloading 100%',
      'FAIL src/a.test.ts',
      '  expected 1 to be 2',
      undefined,
      'ERROR: Job failed: exit code 1',
    ])
  })

  it('removes GitHub timestamps and turns groups into titled lines', () => {
    const cleaner = new LogCleaner()
    const lines = GITHUB.split('\n').map(raw => cleaner.line(raw).line)
    expect(lines.map(line => line?.text)).toEqual(['▶ Run actions/checkout@v4', 'with:', undefined, '▶ Run npm test', '> vitest run', undefined, '##[error]Process completed with exit code 1.'])
    expect(lines[4]?.sections).toEqual(['Run npm test'])
    expect(lines[6]?.sections).toEqual([])
  })
})

describe('readLog', () => {
  it('returns the end of the log with line numbers of the cleaned log and the section titles', async () => {
    const excerpt = await read(GITLAB)
    expect(excerpt).toMatchObject({ totalLines: 9, fromLine: 1, toLine: 9, more: false, sections: ['prepare_executor', 'step_script'], sectionsTruncated: false })
    expect(excerpt.text.split('\n').at(-1)).toBe('ERROR: Job failed: exit code 1')
  })

  it('keeps only the last lines that fit the byte limit and pages back with beforeLine', async () => {
    const log = Array.from({ length: 100 }, (_, index) => `line ${String(index + 1).padStart(3, '0')}`).join('\n')
    const last = await read(log, { maxBytes: 90 })
    expect(last).toMatchObject({ totalLines: 100, fromLine: 91, toLine: 100, more: true })
    const before = await read(log, { maxBytes: 90, beforeLine: last.fromLine! })
    expect(before).toMatchObject({ fromLine: 81, toLine: 90, more: true })
    expect(before.text.split('\n')[0]).toBe('line 081')
  })

  it('returns matching lines with numbered context, separating excerpts, and counts every match', async () => {
    const log = ['a', 'b', 'error one', 'c', 'd', 'e', 'f', 'g', 'Error two', 'h'].join('\n')
    const excerpt = await read(log, { search: ['ERROR'], context: 1 })
    expect(excerpt.text).toBe(['2: b', '3: error one', '4: c', '--', '8: g', '9: Error two', '10: h'].join('\n'))
    expect(excerpt).toMatchObject({ matches: 2, fromLine: 2, toLine: 10, more: false })
    const tight = await read(log, { search: ['error'], context: 0, maxBytes: 16 })
    expect(tight).toMatchObject({ text: '3: error one', matches: 2, more: true })
  })

  it('drops leading context rather than the matching line when both do not fit', async () => {
    const excerpt = await read(`${'x'.repeat(1024)}\nerror: build failed`, { search: ['error'], maxBytes: 1024 })
    expect(excerpt).toMatchObject({ text: '2: error: build failed', matches: 1, fromLine: 2, more: false })
    const first = await read(`error ${'x'.repeat(2000)}`, { search: ['error'], maxBytes: 100 })
    expect(Buffer.byteLength(first.text) + 1).toBeLessThanOrEqual(100)
    expect(first.text.startsWith('1: error x')).toBe(true)
  })

  it('selects lines of matching sections only, keeping the whole log\'s numbering', async () => {
    const excerpt = await read(GITHUB, { section: 'npm test' })
    expect(excerpt).toMatchObject({ fromLine: 3, toLine: 4, text: '▶ Run npm test\n> vitest run', totalLines: 5 })
  })

  it('decodes characters split across chunks and cuts an overlong line', async () => {
    const bytes = new TextEncoder().encode('编译失败\n')
    const split = await read(stream(bytes.subarray(0, 4), bytes.subarray(4)))
    expect(split.text).toBe('编译失败')
    const long = await read(`${'x'.repeat(500)}\nnext`, { maxBytes: 100 })
    expect(long.text.split('\n')).toEqual(['next'])
    const kept = await read('x'.repeat(500), { maxBytes: 200 })
    expect(kept.text).toBe(`${'x'.repeat(197)}…`)
  })
})
