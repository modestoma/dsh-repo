/**
 * dsh-repo 使用的 DSH 宿主接口的最小结构声明。
 *
 * 只声明本插件实际调用的字段，不在运行时 import 任何 `@deepseek-ai/dsh-*`
 * 包；字段含义以 DSH 源码为准（`packages/core/tools`、
 * `packages/credentials/credentials`、`packages/interaction/user-approval`、
 * `packages/api/gateway`）。
 *
 * @module dsh-repo/host
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** One model-facing content block (text is the only kind this plugin produces). */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/** The calling Agent as seen by a tool execution. */
export interface Agent {
  readonly id: string
  /** The Agent's Session; its header `cwd` is the original project directory and the sandbox's writable root. */
  readonly session?: { readonly header: { readonly id: string; readonly cwd?: string } }
}

/**
 * The `ctx.workingDirectory` slice (`@deepseek-ai/dsh-working-directory`):
 * one Session's effective directory. Changing it does not move the sandbox's
 * writable root, which stays at the Session header `cwd`.
 */
export interface WorkingDirectoryService {
  /** @returns the existing effective directory, restoring the original project when it disappeared. */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
  /** @returns the canonical directory now recorded as the Session's working directory. */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

/** Per-call execution context handed to `execute`. */
export interface ToolRunContext {
  readonly signal: AbortSignal
  readonly agent?: Agent
  /** Model-requested call id; approval answerers use it to show the call being decided. */
  readonly callId?: string
}

/** Canonical output declaration of one tool. */
export interface ToolOutputDefinition<V> {
  readonly schema: Record<string, unknown>
  render(args: unknown, value: V): ContentBlock[]
}

/** One raw JSON-schema tool registration. */
export interface ToolDefinition<V = unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutputDefinition<V>
  execute(args: unknown, exec: ToolRunContext): Promise<V>
  isConcurrencySafe?(args: unknown): boolean
}

/** The step a tool's activation condition is evaluated for. */
export interface ToolActivationContext {
  readonly agent: Agent
  readonly signal: AbortSignal
}

/** The `ctx.tools` registry slice. */
export interface ToolRegistry {
  register<V>(
    definition: ToolDefinition<V>,
    options?: { when?: (context: ToolActivationContext) => boolean | Promise<boolean> },
  ): () => void
}

/**
 * The `ctx.credentials` slice (`@deepseek-ai/dsh-credentials`). References
 * are environment-variable names; DSH brands them, which is a compile-time
 * marker only.
 */
export interface HostCredentials {
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>
  describe(ref: string): Promise<HostCredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** Source and writability of one credential reference — never its value. */
export interface HostCredentialInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/**
 * Closed approval outcomes of `@deepseek-ai/dsh-user-approval`; only
 * `allowed-once` grants the action.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One decision request; DSH requires an open turn of the agent's session. */
export interface ApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: string
  /** Audit-logged explanation of what will happen. */
  readonly reason?: string
  /** Localized presentation-only text; answerers prefer it over `reason`. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Aborting withdraws the question (`cancelled`). */
  readonly signal?: AbortSignal
}

/** The optional `ctx.approval` slice. */
export interface HostApproval {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>
}

/** The optional `ctx.webServer` slice. */
export interface HostWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The optional `ctx.connection` slice: DSH's Host/Origin fence plus login check. */
export interface HostRequestGate {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Cordis logger slice. */
export interface HostLogger {
  info?(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
  error?(message: string, ...args: unknown[]): void
}

/** The plugin context slice this plugin uses. */
export interface HostContext {
  readonly tools: ToolRegistry
  readonly credentials: HostCredentials
  readonly logger?: HostLogger
  get?(name: string): unknown
  provide?(name: string, value: unknown): void
  effect(callback: () => (() => void) | void, label?: string): () => unknown
  /**
   * Run every listener of a Cordis event concurrently and wait for all of
   * them; rejects with an `AggregateError` of the listeners that threw.
   */
  parallel?(name: string, ...args: unknown[]): Promise<void>
  /** Run `callback` with a context that has every named service, again whenever they are replaced. */
  inject?(dependencies: string[], callback: (child: HostContext) => void): unknown
}
