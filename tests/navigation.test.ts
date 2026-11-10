import { describe, expect, it } from 'vitest'
import { workspaceOpener } from '../src/client/navigation.ts'

describe('workspace opener', () => {
  it('opens the Workspace id the shell returns for the registered path', async () => {
    const calls: string[] = []
    const opener = workspaceOpener({
      workspaces: {
        create: async ({ path }) => {
          calls.push(`create ${path}`)
          return { workspaceId: 'ws-1' }
        },
      },
      uiWorkspace: { openWorkspace: async (id) => { calls.push(`open ${id}`) } },
    })
    await opener.open('/data/home/project/modem_cli')
    expect(calls).toEqual(['create /data/home/project/modem_cli', 'open ws-1'])
  })

  it('rejects without opening when the shell cannot register the path', async () => {
    const opened: string[] = []
    const opener = workspaceOpener({
      workspaces: { create: async () => { throw new Error('not a directory') } },
      uiWorkspace: { openWorkspace: async (id) => { opened.push(id) } },
    })
    await expect(opener.open('/missing')).rejects.toThrow('not a directory')
    expect(opened).toEqual([])
  })
})
