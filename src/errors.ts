/**
 * The service's single failure type and the mapping from Octokit and
 * GitBeaker errors to it.
 *
 * @module dsh-repo/errors
 */

import type { RepoErrorCode, RepoFailure } from './contract.ts'

/** Expected failure of a `dshRepos` call. */
export class RepoError extends Error implements RepoFailure {
  override readonly name = 'RepoError'

  /**
   * @param code - failure class.
   * @param message - readable reason.
   */
  constructor(readonly code: RepoErrorCode, message: string) {
    super(message)
  }
}

/** Status and host message read off an SDK error, when it carries a response. */
interface HttpFailure {
  readonly status?: number
  readonly message: string
  readonly rateLimited: boolean
}

function httpFailureOf(error: unknown): HttpFailure | undefined {
  if (!(error instanceof Error)) return undefined
  // Octokit `RequestError`: `status` plus `response.headers`.
  const octokit = error as Error & { status?: unknown; response?: { headers?: Record<string, string | number | undefined> } }
  if (error.name === 'HttpError' && typeof octokit.status === 'number') {
    const remaining = octokit.response?.headers?.['x-ratelimit-remaining']
    return { status: octokit.status, message: error.message, rateLimited: octokit.status === 429 || (octokit.status === 403 && String(remaining) === '0') }
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

/**
 * Classify an error thrown while calling a host.
 * @param error - the thrown value.
 * @param what - what was being done, for the message (e.g. `读取 issue #3`).
 * @returns the error to rethrow; a {@link RepoError} passes through unchanged.
 */
export function toRepoError(error: unknown, what: string): RepoError {
  if (error instanceof RepoError) return error
  const http = httpFailureOf(error)
  if (http !== undefined) {
    const detail = http.message === '' ? '' : `：${http.message}`
    if (http.rateLimited) return new RepoError('rate-limited', `${what}失败，已达到接口限流${detail}`)
    switch (http.status) {
      case 401: return new RepoError('unauthenticated', `${what}失败，令牌无效或已过期${detail}`)
      case 403: return new RepoError('forbidden', `${what}失败，令牌没有权限${detail}`)
      case 404: return new RepoError('not-found', `${what}失败，目标不存在或令牌无权查看${detail}`)
      case 405:
      case 406:
      case 409:
      case 412: return new RepoError('conflict', `${what}失败，状态已变化或不满足条件${detail}`)
      case 400:
      case 422: return new RepoError('invalid', `${what}失败，参数被拒绝${detail}`)
      default: return new RepoError('unavailable', `${what}失败${http.status === undefined ? '' : `（HTTP ${http.status}）`}${detail}`)
    }
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'GitbeakerTimeoutError')) {
    return new RepoError('unavailable', `${what}超时或被取消`)
  }
  return new RepoError('unavailable', `${what}失败：${error instanceof Error ? error.message : String(error)}`)
}
