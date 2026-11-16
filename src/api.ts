/**
 * The `dshRepos` service object (contract version 8). Each method with a tool
 * runs that tool's operation through the shared pipeline
 * (`dsh-repo/operations`); the remaining methods serve plugins and the
 * settings page and delegate to the engine.
 *
 * @module dsh-repo/api
 */

import type {
  BranchDeleteParams, BranchGetParams, BranchInfo, BranchListParams, CallerAgent, CallOptions, CatalogRepo, CiActionParams, CiActionResult, CiGetParams, CiJobLog, CiListParams, CiLogParams,
  CiRun, CiRunDetail, CommentInfo, CommentParams, CommitInfo, CommitListParams, DiscussionNote, DshRepoService, FileContent, FileReadParams, HostCreate, HostInfo, HostsChange, IssueCreateParams,
  IssueDetail, IssueInfo, IssueListParams, IssueUpdateParams, MergedBranchDeletion, MergeResult, MrCompareParams, MrCreateParams, MrDetail, MrDiff, MrDiscussion, MrDiscussionReplyParams,
  MrDiscussionResolveParams, MrDiscussionResolveResult, MrDiscussionsParams, MrInfo, MrListParams, MrMergeParams, MrReviewParams, MrReviewResult, MrStatus, MrUpdateParams, MrWatchParams,
  MrWatchResult, NumberParams, Page, RepoFeature, RepoInfo, RepoListParams, RepoParams, RepoPublicSettings, RepoRef, RepoSettingsUpdate, RepoTarget, RepoUser, SnapshotAcquireParams,
  SnapshotLease, TreeListing, TreeListParams, WatchState, WorkspaceCreateParams, WorkspaceInfo, WorkspaceListParams, WorkspacePathParams, WorkspacePushParams, WorkspacePushResult,
  WorkspaceRemoveParams, WorkspaceRemoveResult, WorkspaceStatus, WriteOptions,
} from './contract.ts'
import { RepoError, toRepoError } from './errors.ts'
import { execute, operationOf } from './operations.ts'
import type { OperationDeps } from './operations.ts'
import type { RepoService } from './service.ts'
import { usableDirectory } from './workspace/panel.ts'

/** Collaborators of the service object beyond the operations'. */
export interface ApiDeps extends OperationDeps {
  /** The port the proxy listens on now. */
  readonly proxyPort: () => number | undefined
}

/** Signal of a call that passed none; it never aborts. */
const NEVER = new AbortController().signal

/** The `dshRepos` service. */
export class DshReposApi implements DshRepoService {
  readonly version = 8 as const
  private readonly service: RepoService

  /** @param deps - operation collaborators and proxy control. */
  constructor(private readonly deps: ApiDeps) {
    this.service = deps.service
  }

  repoList(params: RepoListParams & CallOptions = {}): Promise<readonly CatalogRepo[]> { return this.call('repoList', params) }
  repoGet(params: RepoParams & CallOptions): Promise<RepoInfo> { return this.call('repoGet', params) }
  branchList(params: BranchListParams & CallOptions): Promise<Page<BranchInfo>> { return this.call('branchList', params) }
  branchGet(params: BranchGetParams & CallOptions): Promise<BranchInfo | null> { return this.call('branchGet', params) }
  branchDelete(params: BranchDeleteParams & WriteOptions): Promise<MergedBranchDeletion> { return this.call('branchDelete', params) }
  commitList(params: CommitListParams & CallOptions): Promise<Page<CommitInfo>> { return this.call('commitList', params) }
  treeList(params: TreeListParams & CallOptions): Promise<TreeListing> { return this.call('treeList', params) }
  fileRead(params: FileReadParams & CallOptions): Promise<FileContent> { return this.call('fileRead', params) }
  issueList(params: IssueListParams & CallOptions): Promise<Page<IssueInfo>> { return this.call('issueList', params) }
  issueGet(params: NumberParams & CallOptions): Promise<IssueDetail> { return this.call('issueGet', params) }
  issueCreate(params: IssueCreateParams & WriteOptions): Promise<IssueInfo> { return this.call('issueCreate', params) }
  issueUpdate(params: IssueUpdateParams & WriteOptions): Promise<IssueInfo> { return this.call('issueUpdate', params) }
  issueComment(params: CommentParams & WriteOptions): Promise<CommentInfo> { return this.call('issueComment', params) }
  mrList(params: MrListParams & CallOptions): Promise<Page<MrInfo>> { return this.call('mrList', params) }
  mrGet(params: NumberParams & CallOptions): Promise<MrDetail> { return this.call('mrGet', params) }
  mrDiff(params: NumberParams & CallOptions): Promise<MrDiff> { return this.call('mrDiff', params) }
  mrCompare(params: MrCompareParams & CallOptions): Promise<MrDiff> { return this.call('mrCompare', params) }
  mrDiscussions(params: MrDiscussionsParams & CallOptions): Promise<Page<MrDiscussion>> { return this.call('mrDiscussions', params) }
  mrStatus(params: NumberParams & CallOptions): Promise<MrStatus> { return this.call('mrStatus', params) }
  mrCreate(params: MrCreateParams & WriteOptions): Promise<MrInfo & WatchState> { return this.call('mrCreate', params) }
  mrUpdate(params: MrUpdateParams & WriteOptions): Promise<MrInfo & Partial<WatchState>> { return this.call('mrUpdate', params) }
  mrComment(params: CommentParams & WriteOptions): Promise<CommentInfo> { return this.call('mrComment', params) }
  mrReview(params: MrReviewParams & WriteOptions): Promise<MrReviewResult> { return this.call('mrReview', params) }
  mrDiscussionReply(params: MrDiscussionReplyParams & WriteOptions): Promise<DiscussionNote> { return this.call('mrDiscussionReply', params) }
  mrDiscussionResolve(params: MrDiscussionResolveParams & WriteOptions): Promise<MrDiscussionResolveResult> { return this.call('mrDiscussionResolve', params) }
  mrMerge(params: MrMergeParams & WriteOptions): Promise<MergeResult> { return this.call('mrMerge', params) }
  mrWatch(params: MrWatchParams & CallOptions & { readonly agent: CallerAgent }): Promise<MrWatchResult> { return this.call('mrWatch', params) }
  ciList(params: CiListParams & CallOptions): Promise<Page<CiRun>> { return this.call('ciList', params) }
  ciGet(params: CiGetParams & CallOptions): Promise<CiRunDetail> { return this.call('ciGet', params) }
  ciLog(params: CiLogParams & CallOptions): Promise<CiJobLog> { return this.call('ciLog', params) }
  ciRetry(params: CiActionParams & WriteOptions): Promise<CiActionResult> { return this.call('ciRetry', params) }
  ciCancel(params: CiActionParams & WriteOptions): Promise<CiActionResult> { return this.call('ciCancel', params) }
  snapshotAcquire(params: SnapshotAcquireParams & CallOptions): Promise<SnapshotLease> { return this.call('snapshotAcquire', params) }
  workspaceCreate(params: WorkspaceCreateParams & WriteOptions & { readonly path: string }): Promise<WorkspaceInfo> { return this.call('workspaceCreate', params) }
  workspaceList(params: WorkspaceListParams & CallOptions = {}): Promise<readonly WorkspaceInfo[]> { return this.call('workspaceList', params) }
  workspaceStatus(params: WorkspacePathParams & CallOptions & { readonly path: string }): Promise<WorkspaceStatus> { return this.call('workspaceStatus', params) }
  workspacePush(params: WorkspacePushParams & WriteOptions & { readonly path: string }): Promise<WorkspacePushResult> { return this.call('workspacePush', params) }
  workspaceRemove(params: WorkspaceRemoveParams & CallOptions): Promise<WorkspaceRemoveResult> { return this.call('workspaceRemove', params) }

  repoResolve(repo: RepoTarget): RepoRef {
    return this.service.forge.resolve(repo)
  }

  async currentBotUser(params: RepoParams & CallOptions): Promise<RepoUser> {
    const repo = (params as { repo?: unknown } | undefined)?.repo
    if (typeof repo !== 'string' || repo.trim() === '') throw new RepoError('invalid', 'currentBotUser 参数不合法：repo 不能为空')
    try {
      return await this.service.forge.currentBotUser(repo, { ...params.signal === undefined ? {} : { signal: params.signal } })
    } catch (error) {
      throw error instanceof RepoError ? error : toRepoError(error, 'currentBotUser')
    }
  }

  repoOnChange(listener: () => void): () => void {
    return this.service.catalog.onChange(listener)
  }

  hostList(): Promise<readonly HostInfo[]> {
    return this.service.hosts.list()
  }

  hostAdd(params: HostCreate): Promise<HostInfo> {
    return this.service.hosts.add(params)
  }

  hostRemove(params: { readonly url: string }): Promise<void> {
    return this.service.hosts.remove(params.url)
  }

  hostSetToken(params: { readonly url: string; readonly token: string | null }): Promise<HostInfo> {
    return this.service.hosts.setToken(params.url, params.token ?? undefined)
  }

  hostOnChange(listener: (change: HostsChange) => void): () => void {
    return this.service.hosts.onChange(listener)
  }

  featureRegister(feature: RepoFeature): () => void {
    return this.service.catalog.registerFeature(feature)
  }

  settingsGet(): RepoPublicSettings {
    const mirror = this.service.mirrors.settings()
    const { workspace } = this.service.settings.current
    const listening = this.deps.proxyPort()
    return {
      mirrorDir: mirror.dir,
      ...mirror.problem === undefined ? {} : { mirrorProblem: mirror.problem },
      workspaceDir: this.service.settings.workspaceDir(),
      proxyPort: workspace.proxyPort,
      ...listening === undefined ? {} : { proxyListening: listening },
      commitName: workspace.commitName,
      commitEmail: workspace.commitEmail,
    }
  }

  async settingsUpdate(update: RepoSettingsUpdate): Promise<RepoPublicSettings> {
    if (update.mirrorDir !== undefined) await this.service.mirrors.setDir(update.mirrorDir ?? undefined)
    if (update.workspaceDir !== undefined) await this.service.settings.setWorkspaceDir(update.workspaceDir === null ? undefined : await usableDirectory(update.workspaceDir))
    if (update.proxyPort !== undefined || update.commitName !== undefined || update.commitEmail !== undefined) {
      const current = this.service.settings.current
      await this.service.settings.update({
        ...current,
        workspace: {
          proxyPort: update.proxyPort ?? current.workspace.proxyPort,
          commitName: update.commitName ?? current.workspace.commitName,
          commitEmail: update.commitEmail ?? current.workspace.commitEmail,
        },
      })
    }
    return this.settingsGet()
  }

  private async call<R>(method: string, params: (CallOptions & { readonly agent?: CallerAgent; readonly callId?: string }) | undefined): Promise<R> {
    try {
      return await execute(operationOf(method), params, this.deps, {
        origin: 'service',
        signal: params?.signal ?? NEVER,
        ...params?.agent === undefined ? {} : { agent: params.agent },
        ...params?.callId === undefined ? {} : { callId: params.callId },
      }) as R
    } catch (error) {
      throw error instanceof RepoError ? error : toRepoError(error, method)
    }
  }
}
