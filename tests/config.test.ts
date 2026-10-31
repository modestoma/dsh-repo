import { describe, expect, it } from 'vitest'
import { apiBaseUrl, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('accepts an omitted config with safe defaults', () => {
    const config = resolveConfig(undefined)
    expect(config.hosts).toEqual([])
    expect(config.tools).toEqual({ enabled: true, writes: 'ask', merge: false, signature: '' })
  })

  it('normalizes host URLs and rejects invalid entries loudly', () => {
    expect(resolveConfig({ hosts: [{ kind: 'gitlab', url: 'https://Code.Example.com/gitlab/', tokenRef: 'T' }] }).hosts[0]?.url).toBe('https://code.example.com/gitlab')
    expect(() => resolveConfig({ hosts: [{ kind: 'github', url: 'https://u:p@github.com', tokenRef: 'T' }] })).toThrow(/主机地址不合法/)
    expect(() => resolveConfig({ hosts: [{ kind: 'github', url: 'https://github.com', tokenRef: 'ghp_value-here' }] })).toThrow(/令牌名称/)
    expect(() => resolveConfig({ hosts: [{ kind: 'gitlab', url: 'https://g.example.com', apiUrl: 'https://g.example.com/api', tokenRef: 'T' }] })).toThrow(/apiUrl/)
    expect(() => resolveConfig({ repos: ['github.com/*/x'] })).toThrow(/仓库格式/)
    expect(() => resolveConfig({ unknown: true })).toThrow()
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
