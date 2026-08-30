import { ipcMain } from 'electron'

import type { CaffeinateController } from '@main/caffeinate/CaffeinateController.js'
import { broadcastToWindows } from '@main/window/windowRegistry.js'

export function registerCaffeinateIpc(controller: CaffeinateController): void {
  // WHY this is explicit status/toggle IPC instead of a generic
  // "run command" bridge:
  // caffeinate is a long-lived OS assertion, not a one-shot shell
  // command. Main must own duplicate prevention, lifecycle cleanup,
  // and state broadcasts so a renderer reload cannot leave the user
  // with an invisible sleep-prevention process.
  ipcMain.handle('caffeinate:get-status', () => controller.getStatus())
  ipcMain.handle('caffeinate:start', () => controller.start())
  ipcMain.handle('caffeinate:stop', () => controller.stop())
  ipcMain.handle('caffeinate:toggle', () => controller.toggle())

  controller.on('state-changed', status => {
    broadcastToWindows('caffeinate:state-changed', status)
  })
}
