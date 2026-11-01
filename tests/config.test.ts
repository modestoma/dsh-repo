import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, apiBaseUrl, resolveConfig, resolveSettings, settingsOverrides } from '../src/config.ts'

describe('resolveConfig', () => {
  it('accepts an omitted config with safe defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.hosts).toEqual([])
  })

  it('normalizes host URLs and rejects invalid entries loudly', () => {
    expect(resolveConfig({ hosts: [{ kind: 'gitlab', url: 'https://Code.Example.com/gitlab/', tokenRef: 'T' }] }).hosts[0]?.url).toBe('https://code.example.com/gitlab')
    expect(() => resolveConfig({ hosts: [{ kind: 'github', url: 'https://u:p@github.com', tokenRef: 'T' }] })).toThrow(/主机地址不合法/)
    expect(() => resolveConfig({ hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'ghp_value-here' }] })).toThrow(/令牌名称/)
    expect(() => resolveConfig({ hosts: [{ kind: 'gitlab', url: 'https://g.example.com', apiUrl: 'https://g.example.com/api', tokenRef: 'T' }] })).toThrow(/apiUrl/)
    expect(() => resolveConfig({ unknown: true })).toThrow()
  })

  it('keeps run-time settings out of cordis.yml', () => {
    expect(() => resolveConfig({ timeoutMs: 30_000 })).toThrow()
    expect(() => resolveConfig({ tools: { writes: 'allow' } })).toThrow()
  })
})

describe('resolveSettings', () => {
  it('fills every missing field with its default', () => {
    expect(DEFAULT_SETTINGS.tools).toEqual({ enabled: true, writes: 'ask', merge: false, deleteSourceBranch: true, signature: '' })
    expect(resolveSettings({ limits: { perPage: 50 } })).toEqual({ ...DEFAULT_SETTINGS, limits: { ...DEFAULT_SETTINGS.limits, perPage: 50 } })
  })

  it('rejects bad values as invalid, naming each field', () => {
    expect(() => resolveSettings({ repos: ['github.com/*/x'] })).toThrow(/仓库格式/)
    expect(() => resolveSettings({ limits: { perPage: 80, maxPerPage: 50 } })).toThrow(/limits\.perPage/)
    expect(() => resolveSettings({ timeoutMs: 10 })).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => resolveSettings({ unknown: 1 })).toThrow()
  })

  it('stores only the fields that differ from the defaults', () => {
    expect(settingsOverrides(DEFAULT_SETTINGS)).toEqual({})
    const settings = resolveSettings({ repos: ['github.com/a/*'], tools: { writes: 'off' }, mirror: { gitTimeoutMs: 60_000 } })
    expect(settingsOverrides(settings)).toEqual({ repos: ['github.com/a/*'], tools: { writes: 'off' }, mirror: { gitTimeoutMs: 60_000 } })
    expect(resolveSettings(settingsOverrides(settings))).toEqual(settings)
    const watch = resolveSettings({ watch: { idleDays: 3, events: { comment: 'note' } } })
    expect(watch.watch).toMatchObject({ enabled: true, idleDays: 3, activeIntervalMs: 60_000, events: { comment: 'note', ciFailed: 'wake', merged: 'wake', idle: 'wake' } })
    expect(settingsOverrides(watch)).toEqual({ watch: { idleDays: 3, events: { comment: 'note' } } })
    expect(resolveSettings(settingsOverrides(watch))).toEqual(watch)
    expect(() => resolveSettings({ watch: { activeIntervalMs: 1000 } })).toThrow(/watch\.activeIntervalMs/)
  })
})

describe('apiBaseUrl', () => {
  it('derives the REST base of github.com, GitHub Enterprise Server, and GitLab', () => {
    expect(apiBaseUrl({ kind: 'github', url: 'https://github.com' })).toBe('https://api.github.com')
    expect(apiBaseUrl({ kind: 'github', url: 'https://ghe.example.com' })).toBe('https://ghe.example.com/api/v3')
    expect(apiBaseUrl({ kind: 'github', url: 'https://ghe.example.com', apiUrl: 'https://api.ghe.example.com' })).toBe('https://api.ghe.example.com')
    expect(apiBaseUrl({ kind: 'gitlab', url: 'https://code.example.com/gitlab' })).toBe('https://code.example.com/gitlab')
  })
})
