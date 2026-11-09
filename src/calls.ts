/**
 * What an operation knows about its caller, and the steps shared by the
 * writes that open or update a PR/MR: the body signature and watching the
 * PR/MR for the calling Session.
 *
 * @module dsh-repo/calls
 */

import type { CallerAgent, MrInfo } from './contract.ts'
import { RepoError } from './errors.ts'
import type { WatchInfo } from './settings/contract.ts'
import type { TrackRequest } from './watch/watcher.ts'

/** Who calls and how. */
export interface Caller {
  readonly origin: 'tool' | 'service'
  readonly agent?: CallerAgent
  readonly callId?: string
  readonly signal: AbortSignal
}

/** The PR/MR watcher as the operations use it. */
export interface WatchHooks {
  /** @returns whether watching is on and can start a turn of a Session. */
  readonly active: boolean
  track(request: TrackRequest): Promise<WatchInfo>
  untrack(repo: string, number: number, session: string): Promise<boolean>
  ownComment(repo: string, number: number, commentId: string): Promise<void>
}

/**
 * @param caller - who calls.
 * @returns the id of the calling Agent's Session, if any.
 */
export function sessionOf(caller: Caller): string | undefined {
  return caller.agent?.session?.header.id
}

/**
 * The calling Agent.
 * @param caller - who calls.
 * @param name - tool or method, for the message.
 * @returns the Agent.
 * @throws {RepoError} `invalid` without one.
 */
export function requireAgent(caller: Caller, name: string): CallerAgent {
  if (caller.agent === undefined) throw new RepoError('invalid', `${name} 需要由 Agent 调用`)
  return caller.agent
}

/**
 * A body with the configured signature appended after a blank line.
 * @param body - body as given.
 * @param signature - configured signature; empty adds none.
 * @returns the signed body, or undefined without a body.
 */
export function withSignature(body: string | undefined, signature: string): string | undefined {
  if (body === undefined || signature === '') return body
  return `${body}\n\n${signature}`
}

/**
 * Watch a PR/MR for the calling Session while watching is active. The write
 * already succeeded, so a failure is reported in the result, not thrown.
 * @param watch - the watcher, if any.
 * @param repo - repository target.
 * @param mr - the PR/MR as the host returned it.
 * @param caller - who calls.
 * @param source - why it is watched.
 * @param pushed - head commit dsh-repo pushed, so the watch does not report it as someone else's push.
 * @returns whether it is watched, and why not when tracking failed.
 */
export async function watchMr(watch: WatchHooks | undefined, repo: string, mr: MrInfo, caller: Caller, source: TrackRequest['source'], pushed?: string): Promise<{ watching: boolean; watchError?: string }> {
  const session = sessionOf(caller)
  if (watch === undefined || !watch.active || session === undefined || mr.state !== 'open') return { watching: false }
  try {
    await watch.track({ repo, mr, session, source, ...pushed === undefined ? {} : { pushed } })
    return { watching: true }
  } catch (error) {
    return { watching: false, watchError: error instanceof Error ? error.message : String(error) }
  }
}
