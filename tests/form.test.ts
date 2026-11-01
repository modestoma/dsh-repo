import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { displayNumber, formatBytes, formatInterval, fromDraft, intervalHoursText, parseIntervalHours, sameDraft, toDraft } from '../src/client/form.ts'

describe('settings form', () => {
  it('shows times in seconds and sizes in KiB, and saves them back in stored units', () => {
    const draft = toDraft(DEFAULT_SETTINGS)
    expect(draft.numbers).toMatchObject({ timeoutMs: '30', gitTimeoutMs: '600', maxFileBytes: '1024', maxDiffBytes: '512', perPage: '30' })
    expect(displayNumber('maxDiffBytes', 512 * 1024)).toBe('512 KiB')
    expect(fromDraft(draft)).toEqual({ ok: true, settings: DEFAULT_SETTINGS })
    const edited = fromDraft({ ...draft, numbers: { ...draft.numbers, timeoutMs: '1.5', maxFileBytes: '2048' }, repos: ' GitHub.com/A/*\n\ngithub.com/a/*\n' })
    expect(edited).toMatchObject({ ok: true, settings: { timeoutMs: 1500, limits: { maxFileBytes: 2 * 1024 * 1024 }, repos: ['github.com/a/*'] } })
  })

  it('rejects out-of-range numbers and a default page larger than the cap', () => {
    const draft = toDraft(DEFAULT_SETTINGS)
    const result = fromDraft({ ...draft, numbers: { ...draft.numbers, timeoutMs: '0.5', maxComments: 'x', perPage: '80', maxPerPage: '50' } })
    expect(result).toEqual({
      ok: false,
      errors: {
        timeoutMs: '接口调用超时须在 1 秒 到 2147483.647 秒 之间',
        maxComments: '附带评论条数要填数字，须在 1 条 到 100 条 之间',
        perPage: '默认每页条数不能大于每页上限',
      },
    })
  })

  it('compares drafts by the settings they save', () => {
    const draft = toDraft(DEFAULT_SETTINGS)
    expect(sameDraft(draft, toDraft(DEFAULT_SETTINGS))).toBe(true)
    expect(sameDraft(draft, { ...draft, merge: true })).toBe(false)
  })

  it('takes local sync intervals in hours and shows sizes in binary units', () => {
    expect(parseIntervalHours('12')).toEqual({ ok: true, minutes: 720 })
    expect(parseIntervalHours(' 0.5 ')).toEqual({ ok: true, minutes: 30 })
    expect(parseIntervalHours('0.01')).toEqual({ ok: false, message: '同步间隔须在 5 分钟 到 30 天 之间' })
    expect(parseIntervalHours('x')).toMatchObject({ ok: false, message: expect.stringContaining('要填小时数') })
    expect(intervalHoursText(90)).toBe('1.5')
    expect([formatInterval(720), formatInterval(45), formatInterval(2880)]).toEqual(['12 小时', '45 分钟', '2 天'])
    expect([formatBytes(512), formatBytes(1536), formatBytes(300 * 1024 * 1024), formatBytes(3.25 * 1024 ** 3)]).toEqual(['512 B', '1.5 KiB', '300 MiB', '3.3 GiB'])
  })
})
