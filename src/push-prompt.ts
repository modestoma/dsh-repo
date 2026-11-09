/**
 * Approval text of `repo_workspace_push` / `workspacePush`: one headline, then `label：value`
 * lines (repository, starting point, commit message, totals) and indented
 * per-file lines. Approval answerers show it as-is, so every line stands on
 * its own and the file list stays short: renames that move a whole directory
 * collapse into one line.
 *
 * @module dsh-repo/push-prompt
 */

import type { WorkspaceFileChange, WorkspacePushParams, WorkspaceStatus } from './contract.ts'

/** Approval text in each supported language. */
export interface PushPrompt { readonly zh: string; readonly en: string }

/** File lines shown before the rest is summarized as a count. */
const FILE_LINES = 12

interface Entry {
  readonly status: WorkspaceFileChange['status']
  /** `path`, or `from → to` for a move. */
  readonly label: string
  /** Files this line stands for (more than one for a directory move). */
  readonly files: number
  readonly binary: boolean
  readonly additions: number
  readonly deletions: number
}

const STATUS: Record<WorkspaceFileChange['status'], { readonly zh: string; readonly en: string }> = {
  added: { zh: '新增', en: 'add' },
  modified: { zh: '修改', en: 'modify' },
  deleted: { zh: '删除', en: 'delete' },
  renamed: { zh: '移动', en: 'move' },
  'type-changed': { zh: '类型变更', en: 'type change' },
}

/** Leading `/`-separated directories shared by every path, with a trailing `/`; '' when none. */
function commonDirectory(paths: readonly string[]): string {
  const split = paths.map(path => path.split('/').slice(0, -1))
  const first = split[0] ?? []
  let length = 0
  while (length < first.length && split.every(parts => parts[length] === first[length])) length += 1
  return length === 0 ? '' : `${first.slice(0, length).join('/')}/`
}

/**
 * The part of a move that differs: `a/x/f` → `b/x/f` moves directory `a/`
 * to `b/`. Paths are compared segment by segment from the end.
 */
function moveRoots(from: string, to: string): { from: string; to: string } {
  const a = from.split('/')
  const b = to.split('/')
  let shared = 0
  while (shared < a.length - 1 && shared < b.length - 1 && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared += 1
  return { from: a.slice(0, a.length - shared).join('/'), to: b.slice(0, b.length - shared).join('/') }
}

/** One line per file, except that moves sharing the same moved directory collapse into one. */
function entries(files: readonly WorkspaceFileChange[]): Entry[] {
  const result: Entry[] = []
  const moves = new Map<string, WorkspaceFileChange[]>()
  for (const file of files) {
    if (file.status === 'renamed' && file.previousPath !== undefined) {
      const roots = moveRoots(file.previousPath, file.path)
      const key = `${roots.from}\u0000${roots.to}`
      moves.set(key, [...moves.get(key) ?? [], file])
      continue
    }
    result.push(single(file))
  }
  for (const group of moves.values()) {
    if (group.length === 1) {
      result.push(single(group[0]!))
      continue
    }
    result.push({
      status: 'renamed',
      label: `${commonDirectory(group.map(file => file.previousPath!))} → ${commonDirectory(group.map(file => file.path))}`,
      files: group.length,
      binary: false,
      additions: group.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: group.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    })
  }
  // Larger changes first: they are what the reviewer needs to see.
  return result.sort((x, y) => y.files - x.files || (y.additions + y.deletions) - (x.additions + x.deletions))
}

function single(file: WorkspaceFileChange): Entry {
  return {
    status: file.status,
    label: file.status === 'renamed' && file.previousPath !== undefined ? `${file.previousPath} → ${file.path}` : file.path,
    files: 1,
    binary: file.binary,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  }
}

/** `+3 −1`, `+15`, `−7`, or '' when no line changed. */
function lineCounts(additions: number, deletions: number): string {
  return [additions > 0 ? `+${additions}` : '', deletions > 0 ? `−${deletions}` : ''].filter(part => part !== '').join(' ')
}

function entryLine(entry: Entry, language: 'zh' | 'en'): string {
  const counts = lineCounts(entry.additions, entry.deletions)
  const size = entry.files > 1
    ? (language === 'zh' ? `（${entry.files} 个文件${counts === '' ? '' : `，${counts}`}）` : ` (${entry.files} files${counts === '' ? '' : `, ${counts}`})`)
    : entry.binary
      ? (language === 'zh' ? '（二进制）' : ' (binary)')
      : counts === '' ? '' : `  ${counts}`
  return `  ${STATUS[entry.status][language]} ${entry.label}${size}`
}

/**
 * Approval text of a push.
 * @param status - the workspace's changes relative to its start commit.
 * @param params - commit message, force, and the request to open.
 * @param created - whether the remote branch does not exist yet.
 * @returns the text in Chinese and English.
 */
export function pushPrompt(status: WorkspaceStatus, params: WorkspacePushParams, created: boolean): PushPrompt {
  const ws = status.workspace
  const additions = status.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
  const deletions = status.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
  const counts = lineCounts(additions, deletions)
  const list = entries(status.files)
  const shown = list.slice(0, FILE_LINES)
  const hidden = list.length - shown.length
  const message = params.message
  const subject = message?.split('\n', 1)[0] ?? ''
  const bodyLines = message === undefined ? 0 : message.split('\n').slice(1).filter(line => line.trim() !== '').length
  const commit = status.uncommitted && message !== undefined
  const base = `${ws.base} @ ${ws.baseCommit.slice(0, 12)}`
  const mr = params.mr
  const target = mr?.target ?? ws.base

  const zh = [
    `推送工作区到${created ? '新' : ''}分支 ${ws.branch}${params.forceWithLease === true ? '（必要时覆盖远端分支）' : ''}`,
    `仓库：${ws.repo}`,
    `起点：${base}`,
    ...commit ? [`提交说明：${subject}${bodyLines > 0 ? `（另有 ${bodyLines} 行正文）` : ''}`] : [],
    ...status.commits.length > 0 ? [`已有提交：${status.commits.length} 个`] : [],
    ...mr === undefined ? [] : [`没有打开中的 PR/MR 时创建${mr.draft === true ? '草稿 ' : ''}PR/MR：${ws.branch} → ${target}，标题：${mr.title}`],
    `改动：${status.files.length} 个文件${counts === '' ? '' : `，${counts}`}（相对起点）`,
    ...shown.map(entry => entryLine(entry, 'zh')),
    ...hidden > 0 ? [`  …另有 ${hidden} 项`] : [],
  ]
  const en = [
    `Push the workspace to ${created ? 'new ' : ''}branch ${ws.branch}${params.forceWithLease === true ? ' (replacing the remote branch if needed)' : ''}`,
    `Repository: ${ws.repo}`,
    `From: ${base}`,
    ...commit ? [`Commit message: ${subject}${bodyLines > 0 ? ` (+${bodyLines} body lines)` : ''}`] : [],
    ...status.commits.length > 0 ? [`Commits: ${status.commits.length}`] : [],
    ...mr === undefined ? [] : [`Unless one is open, open a ${mr.draft === true ? 'draft ' : ''}PR/MR: ${ws.branch} → ${target}, title: ${mr.title}`],
    `Changes: ${status.files.length} file(s)${counts === '' ? '' : `, ${counts}`} (since the starting point)`,
    ...shown.map(entry => entryLine(entry, 'en')),
    ...hidden > 0 ? [`  …${hidden} more`] : [],
  ]
  return { zh: zh.join('\n'), en: en.join('\n') }
}
