/**
 * The service's single failure type and the mapping from Octokit and
 * GitBeaker errors to it.
 *
 * @module dsh-repo/errors
 */

import type { PartialMrReviewProgress, RepoErrorCode, RepoFailure } from './contract.ts'

/** Expected failure of a `dshRepos` call. */
export class RepoError extends Error implements RepoFailure {
  override readonly name = 'RepoError'
  readonly partialReview?: PartialMrReviewProgress

  /**
   * @param code - failure class.
   * @param message - readable reason.
   * @param options - optional partial progress attached by a multi-step write.
   */
  constructor(readonly code: RepoErrorCode, message: string, options?: { readonly partialReview?: PartialMrReviewProgress }) {
    super(message)
    if (options?.partialReview !== undefined) {
      this.partialReview = options.partialReview
    }
  }
}

/** Status and host message read off an SDK error, when it carries a response. */
interface HttpFailure {
  readonly status?: number
  readonly message: string
  readonly rateLimited: boolean
}

function graphqlStatusOf(type: string | undefined): number | undefined {
  switch (type) {
    case 'RATE_LIMITED': return 429
    case 'UNAUTHENTICATED': return 401
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPES': return 403
    case 'NOT_FOUND': return 404
    case 'CONFLICT': return 409
    case 'UNPROCESSABLE':
    case 'BAD_USER_INPUT':
    case 'VALIDATION_ERROR':
    case 'ARGUMENT_ERROR':
    case 'EXCESSIVE_PAGINATION': return 422
    default: return undefined
  }
}

function httpFailureOf(error: unknown): HttpFailure | undefined {
  if (!(error instanceof Error)) return undefined
  // Octokit `RequestError`: `status` plus `response.headers`.
  const octokit = error as Error & { status?: unknown; response?: { headers?: Record<string, string | number | undefined> } }
  if (error.name === 'HttpError' && typeof octokit.status === 'number') {
    const remaining = octokit.response?.headers?.['x-ratelimit-remaining']
    return { status: octokit.status, message: error.message, rateLimited: octokit.status === 429 || (octokit.status === 403 && String(remaining) === '0') }
  }
  // Octokit `@octokit/graphql` `GraphqlResponseError`: `errors[].type` plus `headers`.
  const graphql = error as Error & { errors?: readonly { readonly type?: string; readonly message?: string }[]; headers?: Record<string, string | number | undefined> }
  if (error.name === 'GraphqlResponseError') {
    const entries = Array.isArray(graphql.errors) ? graphql.errors : []
    const messages = entries.map(entry => entry?.message).filter((msg): msg is string => typeof msg === 'string' && msg !== '')
    const message = messages.length > 0 ? messages.join('; ') : error.message
    const status = entries.map(entry => graphqlStatusOf(entry?.type)).find((code): code is number => code !== undefined)
    const remaining = graphql.headers?.['x-ratelimit-remaining']
    const rateLimited = status === 429 || String(remaining) === '0'
    return { ...rateLimited ? { status: 429 } : status === undefined ? {} : { status }, message, rateLimited }
  }
  // GitBeaker `GitbeakerRequestError`: `cause.response`.
  const gitbeaker = error as Error & { cause?: { response?: { status?: unknown } } }
  if (error.name === 'GitbeakerRequestError' || gitbeaker.cause?.response !== undefined) {
    const status = gitbeaker.cause?.response?.status
    return { ...typeof status === 'number' ? { status } : {}, message: error.message, rateLimited: status === 429 }
  }
  if (error.name === 'GitbeakerRetryError') return { status: 429, message: error.message, rateLimited: true }
  return undefined
}

function partialSuffix(partial: PartialMrReviewProgress | undefined): string {
  if (partial === undefined) return ''
  const parts: string[] = []
  if (partial.postedComments > 0) parts.push(`已发布 ${partial.postedComments} 条行级评论`)
  if (partial.approved === true) parts.push('已完成 approve')
  if (partial.ownCommentIds.length > 0) parts.push(`已产生评论 ID [${partial.ownCommentIds.join(', ')}]`)
  return parts.length === 0 ? '' : `（部分评审已生效：${parts.join('，')}）`
}

/**
 * Classify an error thrown while calling a host.
 * @param error - the thrown value.
 * @param what - what was being done, for the message (e.g. `读取 issue #3`).
 * @returns the error to rethrow; a {@link RepoError} passes through unchanged.
 */
export function toRepoError(error: unknown, what: string): RepoError {
  if (error instanceof RepoError) return error
  const partialReview = (error as { readonly partialReview?: PartialMrReviewProgress } | null | undefined)?.partialReview
  const opts = partialReview === undefined ? undefined : { partialReview }
  const suffix = partialSuffix(partialReview)
  const http = httpFailureOf(error)
  if (http !== undefined) {
    const detail = http.message === '' ? '' : `：${http.message}`
    if (http.rateLimited) return new RepoError('rate-limited', `${what}失败，已达到接口限流${detail}${suffix}`, opts)
    switch (http.status) {
      case 401: return new RepoError('unauthenticated', `${what}失败，令牌无效或已过期${detail}${suffix}`, opts)
      case 403: return new RepoError('forbidden', `${what}失败，令牌没有权限${detail}${suffix}`, opts)
      case 404: return new RepoError('not-found', `${what}失败，目标不存在或令牌无权查看${detail}${suffix}`, opts)
      case 405:
      case 406:
      case 409:
      case 412: return new RepoError('conflict', `${what}失败，状态已变化或不满足条件${detail}${suffix}`, opts)
      case 400:
      case 422: return new RepoError('invalid', `${what}失败，参数被拒绝${detail}${suffix}`, opts)
      default: return new RepoError('unavailable', `${what}失败${http.status === undefined ? '' : `（HTTP ${http.status}）`}${detail}${suffix}`, opts)
    }
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'GitbeakerTimeoutError')) {
    return new RepoError('unavailable', `${what}超时或被取消${suffix}`, opts)
  }
  return new RepoError('unavailable', `${what}失败：${error instanceof Error ? error.message : String(error)}${suffix}`, opts)
}
