import { ipcMain } from 'electron'

import type { AgentOverlaySnapshot } from '@shared/types/agentOverlay.js'
import { focusMainWindow, sendToMainWindow } from '@main/window/mainWindow.js'
import {
  isAgentOverlayEnabled,
  persistAgentOverlayExpanded,
  publishAgentOverlaySnapshot,
  resizeAgentOverlayContent,
  toggleAgentOverlay,
} from '@main/window/overlayWindow.js'

// IPC for the floating agent-status overlay. Three distinct flows share
// the agent-overlay:* prefix — worth keeping straight:
//
//   main renderer → main:   report (snapshot publishing), toggle/get-enabled
//   overlay       → main:   set-expanded, resize, focus-session
//   main → overlay:         agent-overlay:state (sent by overlayWindow.ts,
//                           NOT from here — it goes to the overlay window's
//                           webContents, not through sendToMainWindow)
//   main → main renderer:   enabled-changed, focus-session relay
//
// send (fire-and-forget) vs handle (invoke) split: everything on the hot
// path (snapshot reports, resize on every render) is send — the sender
// never needs an answer and awaiting one would just serialize the stream.

export function registerAgentOverlayIpc(): void {
  ipcMain.handle('agent-overlay:toggle', () => toggleAgentOverlay())
  ipcMain.handle('agent-overlay:get-enabled', () => isAgentOverlayEnabled())

  ipcMain.on('agent-overlay:report', (_event, snapshot: AgentOverlaySnapshot) => {
    publishAgentOverlaySnapshot(snapshot)
  })

  ipcMain.on('agent-overlay:set-expanded', (_event, expanded: unknown) => {
    persistAgentOverlayExpanded(expanded === true)
  })

  ipcMain.on('agent-overlay:resize', (_event, size: { width?: unknown; height?: unknown }) => {
    // Defensive narrowing rather than a cast: this arrives from renderer JS
    // and feeds straight into window geometry — NaN here means an invisible
    // or unusable window with no error anywhere.
    const width = typeof size?.width === 'number' && Number.isFinite(size.width) ? size.width : null
    const height = typeof size?.height === 'number' && Number.isFinite(size.height) ? size.height : null
    if (width === null || height === null) return
    resizeAgentOverlayContent({ width, height })
  })

  ipcMain.on('agent-overlay:focus-session', (_event, payload: { sessionId?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null
    if (!sessionId) return
    // Main owns the OS-level part (raise + focus the app window); the
    // renderer owns the workspace part (which tab/pane that session lives
    // in) — main has no idea about tabs, so it relays.
    focusMainWindow()
    sendToMainWindow('agent-overlay:focus-session', { sessionId })
  })
}
