/**
 * Bridge from the settings page to the DSH Web shell: while the shell's
 * `workspaces` and `uiWorkspace` services are available, the page can register
 * a workspace directory as a DSH Workspace and open a new conversation there.
 *
 * @module dsh-repo/client/navigation
 */

import { useSyncExternalStore } from 'react'

/** The slice of the shell's `workspaces` service the page calls. */
export interface ShellWorkspaces {
  /** Register an existing path as a Workspace; idempotent for a path. */
  create(input: { path: string }): Promise<{ id: string }>
}

/** The slice of the shell's `uiWorkspace` service the page calls. */
export interface ShellNavigation {
  /** Connect a Workspace and open its Session unless a later navigation supersedes it. */
  openWorkspace(workspaceId: string): Promise<void>
}

/** Opens a directory as a DSH Workspace with a conversation ready. */
export interface WorkspaceOpener {
  open(path: string): Promise<void>
}

let current: WorkspaceOpener | undefined
const listeners = new Set<() => void>()

/**
 * Publish the opener built from the shell services, or its removal.
 * @param services - the shell services, or undefined once they are disposed.
 */
export function setShellServices(services: { workspaces: ShellWorkspaces; uiWorkspace: ShellNavigation } | undefined): void {
  current = services === undefined
    ? undefined
    : {
        open: async (path) => {
          const workspace = await services.workspaces.create({ path })
          await services.uiWorkspace.openWorkspace(workspace.id)
        },
      }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The current opener; undefined while the shell provides no Workspace services.
 * @returns the opener, re-rendering when it appears or goes away.
 */
export function useWorkspaceOpener(): WorkspaceOpener | undefined {
  return useSyncExternalStore(subscribe, () => current, () => current)
}
