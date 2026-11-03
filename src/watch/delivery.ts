/**
 * Handing PR/MR activity to the Session that watches it.
 *
 * A turn is started through the `repo/resolve-agent` waterfall, whose final
 * step resolves the Session through `ctx.sessionController` (cold-resuming
 * it when no Agent is live): a plugin that owns how some Sessions are resumed
 * answers the event for its own Sessions and calls `next()` for the rest.
 * The message is acknowledged once Session persistence stored it.
 *
 * @module dsh-repo/watch/delivery
 */

import { randomUUID } from 'node:crypto'
import type { AgentRegistry, HostContext, LiveAgent, SessionController, SessionStore, UserMessage } from '../host.ts'
import type { WatchMessage } from './activity.ts'

/** Cordis waterfall resolving the live Agent of a Session for a watch; payload `(sessionId, next)`. */
export const RESOLVE_AGENT_EVENT = 'repo/resolve-agent'

/** Message source kind of PR/MR activity. */
export const ACTIVITY_SOURCE = 'repo-activity'

/** The outcome of one delivery. */
export type DeliveryOutcome =
  /** The Session has the message. */
  | 'delivered'
  /** A note waits: no Agent of the Session is live, and a note does not resume one. */
  | 'held'
  /** The Session no longer exists. */
  | 'gone'

/** Hands messages to Sessions. */
export interface WatchDelivery {
  /** @returns whether this composition can start a turn of a Session. */
  available(): boolean
  /**
   * Hand a message to a Session.
   * @param session - Session id.
   * @param message - the rendered activity.
   * @param wake - start a turn, or only add context to the next one.
   * @returns the outcome.
   * @throws when the Session could not be resolved or did not store the message.
   */
  deliver(session: string, message: WatchMessage, wake: boolean): Promise<DeliveryOutcome>
}

/** A Session that does not exist; the watch ends. */
class SessionGone extends Error {
  override readonly name = 'SessionGone'
}

/**
 * The user message carrying rendered activity.
 * @param message - the rendered activity.
 * @returns a message with a fresh id, source `repo-activity` in notice form.
 */
export function activityMessage(message: WatchMessage): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: message.text }],
    source: { kind: ACTIVITY_SOURCE, form: 'notice', summary: message.summary },
  }
}

/**
 * Delivery through the Host's Agents.
 * @param ctx - plugin context; services are looked up per delivery.
 * @returns the delivery.
 */
export function hostDelivery(ctx: HostContext): WatchDelivery {
  const resolveAgent = async (session: string): Promise<LiveAgent> => {
    const fallback = async (): Promise<LiveAgent> => {
      const controller = ctx.get?.('sessionController') as SessionController | undefined
      if (controller === undefined) throw new Error('当前 DSH 组合没有 sessionController，不能唤醒会话')
      const result = await controller.resolveAgent(session)
      if ('agent' in result) return result.agent
      if (result.error.code === 'session/not-found') throw new SessionGone(`会话 ${session} 不存在`)
      throw result.error
    }
    if (ctx.waterfall === undefined) return await fallback()
    return await (ctx.waterfall(RESOLVE_AGENT_EVENT, session, fallback) as Promise<LiveAgent>)
  }
  return {
    available: () => ctx.get?.('sessionController') !== undefined,
    async deliver(session, message, wake) {
      if (!wake) {
        const live = (ctx.get?.('agents') as AgentRegistry | undefined)?.get(session)
        if (live === undefined) return 'held'
        live.inject(activityMessage(message))
        return 'delivered'
      }
      let agent: LiveAgent
      try {
        agent = await resolveAgent(session)
      } catch (error) {
        if (error instanceof SessionGone) return 'gone'
        throw error
      }
      agent.followup(activityMessage(message))
      const sessions = ctx.get?.('sessions') as SessionStore | undefined
      if (sessions !== undefined && !await sessions.flush(agent.session)) throw new Error(`会话 ${session} 没有确认保存这条动态`)
      return 'delivered'
    },
  }
}
