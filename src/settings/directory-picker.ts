/**
 * 宿主可选的 `directoryPicker` 服务的最小适配：只使用 `native` 后端（本机
 * GUI 会话里打开操作系统的目录选择框）。没有该服务或后端是 `browse`（远程、
 * 无头会话）时视为不可用，设置页只保留手动输入。
 *
 * @module dsh-repo/settings/directory-picker
 */

import type { HostContext } from '../host.ts'

/** The `native` capability of DSH's `directoryPicker` service. */
interface NativeCapability {
  readonly kind: 'native'
  pick(signal: AbortSignal): Promise<string | null>
}

/** The `ctx.directoryPicker` slice. */
interface DirectoryPickerService {
  capability(): { readonly kind: string }
}

/** The system directory dialog, when the Host has one. */
export interface DirectoryPicker {
  /** Whether a system dialog can be opened now. */
  readonly available: boolean
  /**
   * Open the system dialog; one at a time.
   * @param signal - closes the dialog when aborted.
   * @returns the chosen absolute path, or null when the user cancelled.
   * @throws Error when no dialog is available or one is already open.
   */
  pick(signal: AbortSignal): Promise<string | null>
}

/**
 * Resolve the Host's directory picker on each use, so a service mounted after
 * this plugin is still found.
 * @param ctx - plugin context.
 * @returns the picker.
 */
export function hostDirectoryPicker(ctx: HostContext): DirectoryPicker {
  const native = (): NativeCapability | undefined => {
    const service = ctx.get?.('directoryPicker') as DirectoryPickerService | undefined
    if (service === undefined) return undefined
    const capability = service.capability()
    return capability.kind === 'native' ? capability as NativeCapability : undefined
  }
  let picking = false
  return {
    get available() {
      return native() !== undefined
    },
    async pick(signal) {
      const capability = native()
      if (capability === undefined) throw new Error('当前宿主机不提供系统目录选择框，请手动输入路径')
      if (picking) throw new Error('已有目录选择框打开')
      picking = true
      try {
        return await capability.pick(signal)
      } finally {
        picking = false
      }
    },
  }
}
