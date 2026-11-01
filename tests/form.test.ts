import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/config.ts'
import { displayNumber, fromDraft, sameDraft, toDraft } from '../src/client/form.ts'

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
})
