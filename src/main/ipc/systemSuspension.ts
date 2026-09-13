import { ipcMain } from 'electron'

import type { SystemSuspensionTracker } from '@main/systemSuspension/SystemSuspensionTracker.js'
import { broadcastToWindows } from '@main/window/windowRegistry.js'
import {
  SYSTEM_SUSPENSION_CHANNEL,
  SYSTEM_SUSPENSIONS_READ_CHANNEL,
} from '@shared/types/systemSuspension.js'
import type { SystemSuspension } from '@shared/types/systemSuspension.js'

// Renderer access to the machine's suspensions (#963).
//
// WHY broadcast rather than route to one window: a suspension is app-wide state
// (windowRegistry's routing rule) — every window's turn clock must learn the
// machine slept, not only the focused one.
//
// WHY a read handler as well as the broadcast: a window created or reloaded after
// the wake never saw the event, yet a turn that was live across the sleep is still
// on screen there. It reads the recent list once on mount.
//
// No sender guard: the payload is three numbers about the machine's power state,
// available to any local process through `sysctl`, and it confers no authority.
export function registerSystemSuspensionIpc(tracker: SystemSuspensionTracker): void {
  ipcMain.handle(SYSTEM_SUSPENSIONS_READ_CHANNEL, (): SystemSuspension[] => tracker.list())
  tracker.on('suspension', (suspension: SystemSuspension) => {
    broadcastToWindows(SYSTEM_SUSPENSION_CHANNEL, suspension)
  })
}
