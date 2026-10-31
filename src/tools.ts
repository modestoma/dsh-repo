/**
 * Model tools over the `dshRepos` service: read code, history, issues, and
 * pull/merge requests, and, after the user approves each call, write them.
 *
 * - Every tool takes `repo` (URL or `host/path`); only configured hosts and
 *   repositories are reachable.
 * - Write tools ask once per call through `ctx.approval` when
 *   `tools.writes` is `ask`; without an approval service they refuse. With
 *   `off` they are not registered. The merge tool is registered only when
 *   `tools.merge` is true.
 * - A declined approval returns `{ status: 'declined' }`; a service failure
 *   throws with the failure code in brackets, e.g. `[not-found] …`.
 *
 * @module dsh-repo/tools
 */

import { z } from 'zod'
import type { DshRepoService } from './contract.ts'
import type { RepoConfig } from './config.ts'
import { RepoError } from './errors.ts'
import type { ContentBlock, HostApproval, ToolDefinition, ToolRunContext } from './host.ts'

/** Outcome of a write the user did not approve. */
export interface Declined {
  readonly status: 'declined'
  /** `rejected`, `cancelled`, or `unavailable` (no answerer). */
  readonly outcome: string
}

/** Collaborators of the tool set. */
export interface ToolDeps {
  readonly service: DshRepoService
  readonly config: RepoConfig
  /** DSH's approval service, looked up per call. */
  readonly approval: () => HostApproval | undefined
}

const repo = z.string().min(1).describe('Repository: web or clone URL (https://github.com/owner/name, git@gitlab.example.com:group/project.git) or host/path')
const number = z.number().int().min(1).describe('Issue or PR/MR number as shown in the web UI (GitLab IID)')
const page = z.number().int().min(1).optional().describe('1-based page, default 1')
const perPage = z.number().int().min(1).max(100).optional().describe('Items per page')
const labels = z.array(z.string().min(1)).optional()
const assignees = z.array(z.string().min(1)).optional().describe('Usernames')

interface Spec<S extends z.ZodType, V> {
  readonly name: string
  readonly description: string
  readonly schema: S
  /** Present on write tools: what the approval prompt says will happen. */
  readonly describe?: (args: z.output<S>) => { readonly zh: string; readonly en: string }
  readonly run: (args: z.output<S>, signal: AbortSignal) => Promise<V>
}

function render(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function withSignature(body: string | undefined, signature: string): string | undefined {
  if (body === undefined || signature === '') return body
  return `${body}\n\n${signature}`
}

/**
 * Build the tool definitions the configuration enables.
 * @param deps - service, configuration, and approval lookup.
 * @returns the definitions to register.
 */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { service, config } = deps
  const sign = (body: string | undefined) => withSignature(body, config.tools.signature)
  const signRequired = (body: string) => withSignature(body, config.tools.signature) ?? body

  const reads: ToolDefinition[] = [
    define(deps, {
      name: 'repo_info',
      description: 'Show a repository\'s default branch, visibility, description, and clone URL on GitHub or GitLab.',
      schema: z.object({ repo }).strict(),
      run: (args, signal) => service.repoInfo(args.repo, { signal }),
    }),
    define(deps, {
      name: 'repo_list_branches',
      description: 'List branches with their head commit and protection.',
      schema: z.object({ repo, search: z.string().optional().describe('Substring of the branch name'), page, perPage }).strict(),
      run: (args, signal) => service.listBranches(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_list_commits',
      description: 'List commits newest first, optionally on a branch/tag/SHA and touching a path.',
      schema: z.object({ repo, ref: z.string().optional(), path: z.string().optional(), page, perPage }).strict(),
      run: (args, signal) => service.listCommits(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_list_tree',
      description: 'List files and directories under a path at a ref (default: repository root on the default branch).',
      schema: z.object({ repo, path: z.string().optional(), ref: z.string().optional(), recursive: z.boolean().optional() }).strict(),
      run: (args, signal) => service.listTree(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_read_file',
      description: 'Read one text file at a ref (default: the default branch). Long files are cut at the configured size limit.',
      schema: z.object({ repo, path: z.string().min(1), ref: z.string().optional() }).strict(),
      run: (args, signal) => service.readFile(args.repo, args.path, { ...args.ref === undefined ? {} : { ref: args.ref }, signal }),
    }),
    define(deps, {
      name: 'repo_issue_list',
      description: 'List issues (pull/merge requests excluded).',
      schema: z.object({ repo, state: z.enum(['open', 'closed', 'all']).optional(), labels, assignee: z.string().optional(), page, perPage }).strict(),
      run: (args, signal) => service.listIssues(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_issue_get',
      description: 'Read one issue with its comments.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.getIssue(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_mr_list',
      description: 'List pull requests (GitHub) or merge requests (GitLab).',
      schema: z.object({ repo, state: z.enum(['open', 'closed', 'merged', 'all']).optional(), sourceBranch: z.string().optional(), targetBranch: z.string().optional(), page, perPage }).strict(),
      run: (args, signal) => service.listChanges(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_mr_get',
      description: 'Read one pull/merge request with its conversation comments.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.getChange(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_mr_diff',
      description: 'Read the unified diff of a pull/merge request. Long diffs are cut at the configured size limit.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.changeDiff(args.repo, args.number, { signal }),
    }),
    define(deps, {
      name: 'repo_mr_status',
      description: 'Read CI checks/pipeline and mergeability of a pull/merge request, with its head SHA.',
      schema: z.object({ repo, number }).strict(),
      run: (args, signal) => service.changeStatus(args.repo, args.number, { signal }),
    }),
  ]
  if (config.tools.writes === 'off') return reads

  const writes: ToolDefinition[] = [
    define(deps, {
      name: 'repo_commit_files',
      description: 'Commit file writes and deletions to a branch in one commit. A missing branch is created from `base` (default: the default branch). Never commits to the default or a protected branch; open a PR/MR afterwards. Requires user approval.',
      schema: z.object({
        repo,
        branch: z.string().min(1),
        base: z.string().optional(),
        message: z.string().min(1),
        files: z.array(z.discriminatedUnion('action', [
          z.object({ action: z.literal('write'), path: z.string().min(1), content: z.string() }).strict(),
          z.object({ action: z.literal('delete'), path: z.string().min(1) }).strict(),
        ])).min(1),
      }).strict(),
      describe: args => ({
        zh: `向 ${args.repo} 的分支 ${args.branch} 提交 ${args.files.length} 个文件（${args.files.map(file => `${file.action === 'delete' ? '删除' : '写入'} ${file.path}`).join('，')}）：${args.message.split('\n', 1)[0]}`,
        en: `Commit ${args.files.length} file(s) to ${args.repo} branch ${args.branch}: ${args.message.split('\n', 1)[0]}`,
      }),
      run: (args, signal) => service.commitFiles(args.repo, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_issue_create',
      description: 'Create an issue. Requires user approval.',
      schema: z.object({ repo, title: z.string().min(1), body: z.string().optional(), labels, assignees }).strict(),
      describe: args => ({ zh: `在 ${args.repo} 创建 issue：${args.title}`, en: `Create an issue in ${args.repo}: ${args.title}` }),
      run: (args, signal) => service.createIssue(args.repo, { ...args, ...args.body === undefined ? {} : { body: sign(args.body) }, signal }),
    }),
    define(deps, {
      name: 'repo_issue_update',
      description: 'Change an issue\'s title, body, labels, or assignees, or close/reopen it. Labels and assignees replace the current ones. Requires user approval.',
      schema: z.object({ repo, number, title: z.string().min(1).optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), labels, assignees }).strict(),
      describe: args => ({ zh: `修改 ${args.repo} 的 issue #${args.number}${args.state === 'closed' ? '（关闭）' : args.state === 'open' ? '（重新打开）' : ''}`, en: `Update issue #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.updateIssue(args.repo, args.number, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_issue_comment',
      description: 'Comment on an issue. Requires user approval.',
      schema: z.object({ repo, number, body: z.string().min(1) }).strict(),
      describe: args => ({ zh: `评论 ${args.repo} 的 issue #${args.number}`, en: `Comment on issue #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.commentIssue(args.repo, args.number, signRequired(args.body), { signal }),
    }),
    define(deps, {
      name: 'repo_mr_create',
      description: 'Open a pull request (GitHub) or merge request (GitLab) from a pushed branch. Requires user approval.',
      schema: z.object({ repo, title: z.string().min(1), body: z.string().optional(), sourceBranch: z.string().min(1), targetBranch: z.string().optional(), draft: z.boolean().optional(), labels, assignees }).strict(),
      describe: args => ({
        zh: `在 ${args.repo} 创建${args.draft === true ? '草稿 ' : ''}PR/MR：${args.sourceBranch} → ${args.targetBranch ?? '默认分支'}，标题「${args.title}」`,
        en: `Open a ${args.draft === true ? 'draft ' : ''}PR/MR in ${args.repo}: ${args.sourceBranch} → ${args.targetBranch ?? 'default branch'}, "${args.title}"`,
      }),
      run: (args, signal) => service.createChange(args.repo, { ...args, ...args.body === undefined ? {} : { body: sign(args.body) }, signal }),
    }),
    define(deps, {
      name: 'repo_mr_update',
      description: 'Change a pull/merge request\'s title, body, target branch, labels, or assignees, or close/reopen it. Requires user approval.',
      schema: z.object({ repo, number, title: z.string().min(1).optional(), body: z.string().optional(), state: z.enum(['open', 'closed']).optional(), targetBranch: z.string().optional(), labels, assignees }).strict(),
      describe: args => ({ zh: `修改 ${args.repo} 的 PR/MR #${args.number}${args.state === 'closed' ? '（关闭）' : args.state === 'open' ? '（重新打开）' : ''}`, en: `Update PR/MR #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.updateChange(args.repo, args.number, { ...args, signal }),
    }),
    define(deps, {
      name: 'repo_mr_comment',
      description: 'Comment on a pull/merge request conversation. Requires user approval.',
      schema: z.object({ repo, number, body: z.string().min(1) }).strict(),
      describe: args => ({ zh: `评论 ${args.repo} 的 PR/MR #${args.number}`, en: `Comment on PR/MR #${args.number} in ${args.repo}` }),
      run: (args, signal) => service.commentChange(args.repo, args.number, signRequired(args.body), { signal }),
    }),
  ]
  if (config.tools.merge) {
    writes.push(define(deps, {
      name: 'repo_mr_merge',
      description: 'Merge a pull/merge request, only while its head is still `headSha` (read it with repo_mr_status first). Requires user approval.',
      schema: z.object({ repo, number, headSha: z.string().min(40), method: z.enum(['merge', 'squash', 'rebase']).optional() }).strict(),
      describe: args => ({ zh: `合并 ${args.repo} 的 PR/MR #${args.number}（head ${args.headSha.slice(0, 12)}${args.method === undefined ? '' : `，方式 ${args.method}`}）`, en: `Merge PR/MR #${args.number} in ${args.repo} at ${args.headSha.slice(0, 12)}` }),
      run: (args, signal) => service.mergeChange(args.repo, args.number, { headSha: args.headSha, ...args.method === undefined ? {} : { method: args.method }, signal }),
    }))
  }
  return [...reads, ...writes]
}

function define<S extends z.ZodType, V>(deps: ToolDeps, spec: Spec<S, V>): ToolDefinition<V | Declined> {
  const parameters = z.toJSONSchema(spec.schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  delete parameters.$schema
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => render(value) },
    isConcurrencySafe: () => spec.describe === undefined,
    execute: async (raw: unknown, exec: ToolRunContext): Promise<V | Declined> => {
      const parsed = spec.schema.safeParse(raw)
      if (!parsed.success) throw new Error(`[invalid] ${spec.name} 参数不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`).join('；')}`)
      const args = parsed.data
      if (spec.describe !== undefined && deps.config.tools.writes === 'ask') {
        const outcome = await approve(deps, spec.name, spec.describe(args), exec)
        if (outcome !== 'allowed-once') return { status: 'declined', outcome }
      }
      try {
        return await spec.run(args, exec.signal)
      } catch (error) {
        if (error instanceof RepoError) throw new Error(`[${error.code}] ${error.message}`)
        throw error
      }
    },
  }
}

async function approve(deps: ToolDeps, toolName: string, text: { readonly zh: string; readonly en: string }, exec: ToolRunContext): Promise<string> {
  const approval = deps.approval()
  if (approval === undefined) throw new Error(`[forbidden] 当前 DSH 组合没有审批服务（@deepseek-ai/dsh-user-approval），dsh-repo 不会在未经授权时执行 ${toolName}；或把 tools.writes 设为 allow`)
  if (exec.agent === undefined) throw new Error(`[forbidden] ${toolName} 需要由 Agent 调用`)
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    ...exec.callId === undefined ? {} : { callId: exec.callId },
    reason: text.zh,
    displayReason: { en: text.en, zh: text.zh },
    signal: exec.signal,
  })
  if (outcome === 'cancelled') exec.signal.throwIfAborted()
  return outcome
}
