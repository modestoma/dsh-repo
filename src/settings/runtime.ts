/**
 * The run-time settings and the workspace directory as the rest of the
 * plugin reads and changes them. Values are read from the settings file's
 * store on every access, so a saved setting takes effect for the next call
 * without a reload.
 *
 * @module dsh-repo/settings/runtime
 */

import { DEFAULT_SETTINGS, resolveSettings } from '../config.ts'
import type { RepoSettings } from '../config.ts'
import { RepoError } from '../errors.ts'
import type { SettingsStore } from './store.ts'

/** Listener of saved settings changes. */
export type SettingsListener = (next: RepoSettings, previous: RepoSettings) => Promise<void>

/** Run-time settings and the workspace directory. */
export class RuntimeSettings {
  private readonly listeners = new Set<SettingsListener>()

  /** @param store - settings file. */
  constructor(private readonly store: SettingsStore) {}

  /** @returns the run-time settings now in effect. */
  get current(): RepoSettings {
    return this.store.settings()
  }

  /** @returns the value of every setting while nothing is stored. */
  get defaults(): RepoSettings {
    return DEFAULT_SETTINGS
  }

  /** @returns absolute path of the settings file. */
  get file(): string {
    return this.store.file
  }

  /**
   * Validate and persist the run-time settings, or return to the defaults
   * with undefined, then run every {@link onChange} listener in registration
   * order.
   * @param input - complete settings from the settings page.
   * @returns the settings now in effect.
   * @throws {RepoError} `invalid` naming every bad field, `unavailable` when the file cannot be written or a listener failed after the save.
   */
  async update(input: unknown): Promise<RepoSettings> {
    const previous = this.current
    const next = input === undefined ? DEFAULT_SETTINGS : resolveSettings(input)
    await this.store.setSettings(next)
    const failures: string[] = []
    for (const listener of this.listeners) {
      try {
        await listener(next, previous)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (failures.length > 0) throw new RepoError('unavailable', `设置已保存，但没有全部生效：${failures.join('；')}`)
    return next
  }

  /**
   * Run a listener after every saved settings change, awaited by {@link update}.
   * @param listener - receives the new and the previous settings; a rejection is reported to the saving caller.
   * @returns a function that removes the listener.
   */
  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns the default parent directory of new workspaces, or undefined while none is chosen. */
  workspaceDir(): string | undefined {
    return this.store.workspaceDir()
  }

  /**
   * Persist the default parent directory of new workspaces.
   * @param dir - usable absolute directory, or undefined to clear it.
   * @throws {RepoError} `unavailable` when the file cannot be written.
   */
  async setWorkspaceDir(dir: string | undefined): Promise<void> {
    await this.store.setWorkspaceDir(dir)
  }
}
