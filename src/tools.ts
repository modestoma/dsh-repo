/**
 * Model tools: one per entry of the operation registry
 * (`dsh-repo/operations`), each running the same pipeline as its `dshRepos`
 * method.
 *
 * - Every tool is built; {@link toolOffered} decides from the current
 *   settings and the catalog whether the model sees it.
 * - A declined approval returns `{ status: 'declined' }`; a failure throws
 *   with its code in brackets, e.g. `[not-found] …`.
 *
 * @module dsh-repo/tools
 */

import { z } from 'zod'
import { RepoError } from './errors.ts'
import type { ContentBlock, ToolDefinition } from './host.ts'
import { DeclinedError, execute, OPERATIONS, toolOffered } from './operations.ts'
import type { Declined, Operation, OperationDeps, ToolAccess } from './operations.ts'

export { toolOffered }
export type { Declined, ToolAccess }

/** One built tool and the settings that offer it. */
export interface RepoTool {
  readonly definition: ToolDefinition
  readonly access: ToolAccess
}

/** Tools that change local directories, which must not run beside another call of the same Agent. */
const LOCAL_WRITES = new Set(['repo_workspace_create', 'repo_workspace_remove'])

function render(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build every tool definition with its access class.
 * @param deps - collaborators of the operations.
 * @returns the tools to register, each offered while {@link toolOffered} holds.
 */
export function createTools(deps: OperationDeps): RepoTool[] {
  return OPERATIONS.map(operation => ({ access: operation.access, definition: toolDefinition(operation, deps) }))
}

function toolDefinition(operation: Operation, deps: OperationDeps): ToolDefinition<unknown> {
  // The JSON round trip drops the non-enumerable `~standard` member Zod adds; the harness rejects tool parameters JSON would lose data from.
  const parameters = JSON.parse(JSON.stringify(z.toJSONSchema(operation.schema, { target: 'draft-2020-12' }))) as Record<string, unknown>
  delete parameters.$schema
  return {
    name: operation.tool,
    description: operation.description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => render(value) },
    isConcurrencySafe: () => operation.write === undefined && !LOCAL_WRITES.has(operation.tool),
    execute: async (raw, exec): Promise<unknown> => {
      try {
        return await execute(operation, raw, deps, {
          origin: 'tool',
          signal: exec.signal,
          ...exec.agent === undefined ? {} : { agent: exec.agent },
          ...exec.callId === undefined ? {} : { callId: exec.callId },
        })
      } catch (error) {
        if (error instanceof DeclinedError) return { status: 'declined', outcome: error.outcome } satisfies Declined
        if (error instanceof RepoError) throw new Error(`[${error.code}] ${error.message}`)
        throw error
      }
    },
  }
}
