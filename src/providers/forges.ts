/**
 * The code host families dsh-repo supports, each a complete
 * {@link ForgeAdapter}: GitHub and GitLab.
 *
 * @module dsh-repo/providers/forges
 */

import type { ForgeKind } from '../contract.ts'
import { githubForge } from './github.ts'
import { gitlabForge } from './gitlab.ts'
import type { ForgeAdapter } from './types.ts'

const FORGES: Readonly<Record<ForgeKind, ForgeAdapter>> = { github: githubForge, gitlab: gitlabForge }

/**
 * The adapter of a host family.
 * @param kind - host kind.
 * @returns the adapter.
 */
export function forgeOf(kind: ForgeKind): ForgeAdapter {
  return FORGES[kind]
}
