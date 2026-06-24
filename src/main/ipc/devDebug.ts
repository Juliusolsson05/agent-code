import { ipcMain } from 'electron'

import { readRecentPasteSessions } from '../pasteDebugJournal.js'

export type DevDebugConfig = {
  enabled: boolean
}

function envFlag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes'
}

function isDevDebugEnabled(): boolean {
  return envFlag('AGENT_CODE_DEV_DEBUG')
}

export function registerDevDebugIpc(): void {
  ipcMain.handle('dev-debug:get-config', (): DevDebugConfig => {
    return {
      // WHY this flag lives in main instead of import.meta.env:
      // dev-debug modules are allowed to be noisy, temporary, and
      // sometimes performance-hostile. Gating them from the same
      // project-root `.env` loader as performance telemetry gives us a
      // runtime switch that works in Electron dev without requiring a
      // Vite-prefixed renderer variable or rebuild-time config.
      enabled: isDevDebugEnabled(),
    }
  })

  // Read side of the paste-debug journals, consumed by the ClaudePasteDetection
  // dev module (#90). The journals are write-only at runtime (the renderer
  // records events via record-paste-debug-event); this lets the module pull
  // them back to reconstruct issued→detected latency. Renderer-only modules get
  // main-process data exactly this way — a thin invoke handler, no per-module
  // channel proliferation.
  ipcMain.handle('dev-debug:read-paste-events', (_evt, limit?: number) => {
    // The renderer already hides DevDebugPanel when the flag is off, but IPC is
    // the trust boundary. Paste-debug journals contain timing, session, and
    // payload fingerprints for private user input; leaving this handler open
    // meant any renderer code with preload access could read them even when the
    // operator explicitly did not enable dev debugging.
    if (!isDevDebugEnabled()) return []
    return readRecentPasteSessions(typeof limit === 'number' ? limit : 30)
  })
}
