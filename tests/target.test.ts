import { describe, expect, it } from 'vitest'
import { resolveTarget } from '../src/target.ts'
import { testConfig } from './helpers.ts'

const hosts = testConfig().hosts

describe('resolveTarget', () => {
  it('reads web, clone, and bare GitHub addresses', () => {
    for (const input of [
      'https://github.com/modestoma/dsh-repo',
      'https://github.com/modestoma/dsh-repo.git',
      'https://github.com/modestoma/dsh-repo/pull/3/files',
      'git@github.com:modestoma/dsh-repo.git',
      'ssh://git@github.com/modestoma/dsh-repo.git',
      'github.com/modestoma/dsh-repo',
    ]) {
      expect(resolveTarget(input, hosts), input).toMatchObject({ kind: 'github', host: 'github.com', path: 'modestoma/dsh-repo', webUrl: 'https://github.com/modestoma/dsh-repo' })
    }
  })

  it('reads nested GitLab groups below the instance path prefix and drops web suffixes', () => {
    expect(resolveTarget('https://code.example.com/gitlab/team/backend/orders/-/merge_requests/7', hosts)).toMatchObject({
      kind: 'gitlab', host: 'code.example.com', path: 'team/backend/orders', webUrl: 'https://code.example.com/gitlab/team/backend/orders',
    })
    expect(resolveTarget('git@code.example.com:team/orders.git', hosts).path).toBe('team/orders')
  })

  it('serves GitHub Enterprise as its own host', () => {
    expect(resolveTarget('https://ghe.example.com/platform/api', hosts).spec.tokenRef).toBe('GHE_TOKEN')
  })

  it('refuses unknown hosts and malformed paths', () => {
    expect(() => resolveTarget('https://gitlab.com/a/b', hosts)).toThrow(expect.objectContaining({ code: 'not-allowed' }))
    expect(() => resolveTarget('https://github.com/only-owner', hosts)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => resolveTarget('not a repo', hosts)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(resolveTarget('github.com/ModestoMa/Repo', hosts).path).toBe('ModestoMa/Repo')
  })
})
