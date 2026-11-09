/**
 * Snapshot leases taken by the `repo_snapshot_acquire` tool. A tool result
 * cannot hand a release function to the model, so the plugin holds the
 * lease: one per Session and repository, replaced by the next acquisition,
 * released after {@link TOOL_LEASE_MS}, and all released when the plugin is
 * disposed.
 *
 * @module dsh-repo/mirror/tool-leases
 */

/** Tool snapshot leases are released after this long. */
export const TOOL_LEASE_MS = 12 * 60 * 60 * 1000

/** Snapshot leases the plugin holds for tools. */
export class ToolLeases {
  private readonly held = new Map<string, { release(): void }>()

  /**
   * Hold a lease under `key`, releasing the one held there before.
   * @param key - Session and repository.
   * @param release - releases the lease; called once.
   */
  hold(key: string, release: () => void): void {
    this.held.get(key)?.release()
    const timer = setTimeout(() => { entry.release() }, TOOL_LEASE_MS)
    timer.unref?.()
    const entry = {
      release: () => {
        clearTimeout(timer)
        if (this.held.get(key) === entry) this.held.delete(key)
        release()
      },
    }
    this.held.set(key, entry)
  }

  /** Release every held lease. */
  releaseAll(): void {
    for (const entry of [...this.held.values()]) entry.release()
  }
}
