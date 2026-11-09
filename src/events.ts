/**
 * Cordis events dsh-repo dispatches to other plugins before it writes for a
 * Session: `access/authorize` asks whether the Session may act at all, and
 * `repo/commit-trailers` collects the trailers and the author of a pushed
 * commit. Both go through `ctx.parallel`; without it no plugin listens and
 * every write is allowed with no extra trailers.
 *
 * @module dsh-repo/events
 */

import type { AuthorizeEvent, CommitAuthor, CommitDetails, CommitTrailer, CommitTrailersEvent } from './contract.ts'
import { RepoError } from './errors.ts'

/** Cordis event other plugins listen to for allowing or refusing a write made for a Session; payload {@link AuthorizeEvent}. */
export const ACCESS_AUTHORIZE_EVENT = 'access/authorize'

/** Cordis event other plugins listen to for extra trailers and the author of a pushed commit; payload {@link CommitTrailersEvent}. */
export const COMMIT_TRAILERS_EVENT = 'repo/commit-trailers'

/** `ctx.parallel`: run every listener of an event and wait for all; rejects with an `AggregateError` of the listeners that threw. */
export type ParallelDispatch = (name: string, ...args: unknown[]) => Promise<void>

/**
 * Ask the `access/authorize` listeners whether a Session may make one write.
 * @param parallel - `ctx.parallel`; undefined means no listeners, so allowed.
 * @param event - the Session, the level, and what it is about to do.
 * @throws {RepoError} `forbidden` naming every listener's reason when any listener refused.
 */
export async function authorize(parallel: ParallelDispatch | undefined, event: AuthorizeEvent): Promise<void> {
  try {
    await parallel?.(ACCESS_AUTHORIZE_EVENT, event)
  } catch (error) {
    throw new RepoError('forbidden', `${event.action} 未获授权，没有执行：${reasons(error).join('；')}`)
  }
}

/**
 * Collect the trailers and the author the `repo/commit-trailers` listeners add.
 * @param parallel - `ctx.parallel`; undefined means no listeners.
 * @param request - Session and workspace of the push.
 * @returns the trailers in the order they were added, and the author when a listener set one.
 * @throws {RepoError} `unavailable` naming the listener failures; `invalid` when more than one author was set.
 */
export async function collectDetails(parallel: ParallelDispatch | undefined, request: { readonly session: string; readonly path: string }): Promise<CommitDetails> {
  const trailers: CommitTrailer[] = []
  const authors: CommitAuthor[] = []
  let open = true
  const event: CommitTrailersEvent = {
    ...request,
    add: (token, value) => { if (open) trailers.push({ token, value }) },
    setAuthor: (name, email) => { if (open) authors.push({ name, email }) },
  }
  try {
    await parallel?.(COMMIT_TRAILERS_EVENT, event)
  } catch (error) {
    throw new RepoError('unavailable', `${COMMIT_TRAILERS_EVENT} 监听者出错，没有提交：${reasons(error).join('；')}`)
  } finally {
    open = false
  }
  if (authors.length > 1) throw new RepoError('invalid', `${COMMIT_TRAILERS_EVENT} 监听者设置了 ${authors.length} 个提交作者，只能有一个，没有提交：${authors.map(author => `${author.name} <${author.email}>`).join('、')}`)
  return { trailers, ...authors[0] === undefined ? {} : { author: authors[0] } }
}

/** The messages of the listeners that threw. */
function reasons(error: unknown): string[] {
  const errors = error instanceof AggregateError ? error.errors : [error]
  return errors.map(reason => reason instanceof Error ? reason.message : String(reason))
}
