import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import {
  SYSTEM_SUSPENSION_CHANNEL,
  SYSTEM_SUSPENSIONS_READ_CHANNEL,
} from '@shared/types/systemSuspension.js'
import type { SystemSuspension } from '@shared/types/systemSuspension.js'

// Window-chrome coordination, and the machine's power state.
//
// Window chrome: the macOS traffic-light (close/minimize/zoom) right-edge
// inset pushed from main as a CSS custom property so the tab bar can
// pad itself without magic pixel values. Zoom-safe, scale-safe.
// If we ever add more window-chrome concerns (fullscreen transitions,
// vibrancy recomputation), they cluster here.
//
// Power state (#963): when the machine was suspended, so the in-feed turn
// clock never counts a night of sleep as Thinking time. Main owns detection
// (SystemSuspensionTracker); a renderer only reads it.

export const systemApi = {
  onTrafficLightInset: (cb: (insetPx: number) => void): Unsub =>
    subscribe('traffic-light-inset', cb),
  /** Recent suspensions, oldest first. Read once on mount: a window that loads
   *  after a wake never saw the broadcast. */
  listSystemSuspensions: (): Promise<SystemSuspension[]> =>
    ipcRenderer.invoke(SYSTEM_SUSPENSIONS_READ_CHANNEL),
  onSystemSuspension: (cb: (suspension: SystemSuspension) => void): Unsub =>
    subscribe(SYSTEM_SUSPENSION_CHANNEL, cb),
}
