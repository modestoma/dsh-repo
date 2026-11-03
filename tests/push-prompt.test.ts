/**
 * Approval text of `repo_workspace_push`: labelled lines and a short file list.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceChanges, WorkspaceFileChange } from '../src/contract.ts'
import { pushPrompt } from '../src/push-prompt.ts'

function changes(files: WorkspaceFileChange[], extra: Partial<WorkspaceChanges> = {}): WorkspaceChanges {
  return {
    workspace: { url: 'https://git.example.com/pe/app.git', dir: '/ws', baseBranch: 'main', baseCommit: '0098913c1c87ffff' },
    commits: [], uncommitted: true, diff: '', truncated: false, files, ...extra,
  }
}

describe('pushPrompt', () => {
  it('collapses moves of one directory into a single line and lists larger changes first', () => {
    const moved = Array.from({ length: 48 }, (_, index): WorkspaceFileChange => ({
      path: `.agents/skills/logalyze/evals/case-${index}/case.yaml`,
      previousPath: `.dsh/skills/logalyze/evals/case-${index}/case.yaml`,
      status: 'renamed', binary: false, additions: 0, deletions: 0,
    }))
    const prompt = pushPrompt(changes([
      { path: '.agents/skills/logalyze/evals/README.md', status: 'added', binary: false, additions: 15, deletions: 0 },
      ...moved,
      { path: '.dsh/skills/logalyze/SKILL.md', status: 'deleted', binary: false, additions: 0, deletions: 1560 },
    ]), 'logalyze/dedupe', 'refactor(skill): evals 并入 .agents\n\n- 夹具迁移\n- 删除旧目录')
    expect(prompt.zh.split('\n')).toEqual([
      '推送工作区改动到新分支 logalyze/dedupe',
      '仓库：https://git.example.com/pe/app.git',
      '起点：main @ 0098913c1c87',
      '提交说明：refactor(skill): evals 并入 .agents（另有 2 行正文）',
      '改动：50 个文件，+15 −1560（相对起点）',
      '  移动 .dsh/skills/logalyze/evals/ → .agents/skills/logalyze/evals/（48 个文件）',
      '  删除 .dsh/skills/logalyze/SKILL.md  −1560',
      '  新增 .agents/skills/logalyze/evals/README.md  +15',
    ])
    expect(prompt.en).toContain('  move .dsh/skills/logalyze/evals/ → .agents/skills/logalyze/evals/ (48 files)')
  })

  it('keeps a lone rename as its own line and summarizes lines beyond the cap', () => {
    const many = Array.from({ length: 14 }, (_, index): WorkspaceFileChange => ({ path: `src/f${index}.ts`, status: 'modified', binary: false, additions: 1, deletions: 1 }))
    const prompt = pushPrompt(changes([
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', binary: false, additions: 5, deletions: 0 },
      ...many,
    ], { uncommitted: false, workspace: { url: 'https://git.example.com/pe/app.git', dir: '/ws', baseBranch: 'main', baseCommit: 'abc', branch: 'fix/a' }, commits: [{ sha: 'd', subject: 's' }] }), 'fix/a', undefined)
    const lines = prompt.zh.split('\n')
    expect(lines[0]).toBe('推送工作区改动到分支 fix/a')
    expect(lines).toContain('此前已推送：1 个提交')
    expect(lines.some(line => line.startsWith('提交说明'))).toBe(false)
    expect(lines).toContain('  移动 src/old-name.ts → src/new-name.ts  +5')
    expect(lines.at(-1)).toBe('  …另有 3 项')
  })
})
