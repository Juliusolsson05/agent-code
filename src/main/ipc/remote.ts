import { ipcMain } from 'electron'

import type { RemoteController } from '@main/remote/RemoteController.js'
import { sendToMainWindow } from '@main/window/mainWindow.js'

// remote:* IPC — the desktop's control channel for the remote mobile
// companion (spec: docs/superpowers/specs/2026-07-06-remote-mobile-
// companion-design.md). This file is one of the sanctioned holes in the
// remote isolation wall: core registers these handlers, but every one is a
// one-liner onto RemoteController — no remote logic leaks into core.
//
// WHY there is no `remote:send-prompt` here: the desktop drives sessions
// through its own SessionFeed (IPC transport); this surface only manages
// the SERVER — enable/disable, pairing, devices. Phones talk to
// RemoteServer over WebSocket, never through these handlers.

export function registerRemoteIpc(controller: RemoteController): void {
  ipcMain.handle('remote:get-status', () => controller.getStatus())
  ipcMain.handle('remote:enable', (_evt, mode?: 'lan' | 'tunnel') =>
    controller.enable(mode ?? 'lan'),
  )
  ipcMain.handle('remote:disable', () => controller.disable())
  ipcMain.handle('remote:issue-pairing-code', () => controller.issuePairingCode())
  ipcMain.handle('remote:revoke-device', (_evt, deviceId: string) =>
    controller.revokeDevice(deviceId),
  )
  ipcMain.handle('remote:set-theme-settings', (_evt, settings: unknown) => {
    controller.setThemeSettings(
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? settings as Record<string, unknown>
        : null,
    )
  })

  // Push status transitions (enable/disable, device paired/revoked, phone
  // connected/disconnected) so RemotePanel live-updates without polling —
  // same push pattern caffeinate uses.
  controller.on('status-changed', status => {
    sendToMainWindow('remote:status-changed', status)
  })
}
