import { ipcMain, shell } from 'electron'

import type { CliUpdateOrchestrator } from '@main/setup/cliUpdateOrchestrator.js'
import { setCliUpdateBehavior } from '@main/setup/setupState.js'
import { sendToMainWindow } from '@main/window/mainWindow.js'
import type { CliUpdateBehavior, CliUpdateKind, CliUpdateSnapshot } from '@shared/types/cliUpdate.js'

// IPC layer for the CLI auto-updater.
//
// Shape mirrors other main-owned broadcasters:
//   - main-to-renderer push channel `cli-updates:state` for state changes.
//     Delivered via sendToMainWindow so the observer hook can spy on it if
//     dev-debug recording is on.
//   - request/response handlers `cli-updates:get` (initial snapshot after
//     the renderer connects), `cli-updates:refresh` (force a fresh probe
//     from a settings-page button), `cli-updates:set-behavior` (persist
//     the three-way setting), and `cli-updates:open-log` (open a failure
//     log in the OS default handler).
//
// WHY the initial snapshot is a request/response rather than a "reply to
// every subscribe with the current value" push:
//   The renderer subscribes on mount, which happens somewhere between
//   boot and the first probe finishing. If we relied purely on push,
//   there'd be a moment where the renderer had subscribed but received
//   no state, so the banner would flash empty then populate. A single
//   `cli-updates:get` at mount time is one round-trip and eliminates the
//   flash. Every subsequent transition still comes through the push
//   channel.

export function registerCliUpdatesIpc(orchestrator: CliUpdateOrchestrator): void {
  // Push every transition to the renderer. Registered before any handler
  // so a probe that finishes early has a live subscriber to hear it.
  orchestrator.on('state', (snapshot: CliUpdateSnapshot) => {
    sendToMainWindow('cli-updates:state', snapshot)
  })

  ipcMain.handle('cli-updates:get', async () => {
    return orchestrator.getSnapshot()
  })

  ipcMain.handle('cli-updates:refresh', async () => {
    return await orchestrator.refresh()
  })

  ipcMain.handle('cli-updates:update-now', async (_evt, cli: CliUpdateKind) => {
    // Boundary validation — the renderer is trusted but a version
    // skew could send an unknown kind; fall through with a no-op
    // rather than crash the main process.
    if (cli !== 'claude' && cli !== 'codex') return orchestrator.getSnapshot()
    return await orchestrator.updateOnce(cli)
  })

  ipcMain.handle('cli-updates:set-behavior', async (_evt, behavior: CliUpdateBehavior) => {
    // Validate at the boundary — the renderer is trusted but a
    // pre-release build might send a stale union value while both sides
    // migrate. Fall back to 'automatic' rather than throw: the setting
    // page will overwrite the invalid value on its next render because
    // the response snapshot carries the coerced behavior.
    const normalized: CliUpdateBehavior =
      behavior === 'automatic' || behavior === 'notify' || behavior === 'off'
        ? behavior
        : 'automatic'
    await setCliUpdateBehavior(normalized)
    await orchestrator.setBehavior(normalized)
    return orchestrator.getSnapshot()
  })

  ipcMain.handle('cli-updates:open-log', async (_evt, logPath: string) => {
    // shell.openPath returns '' on success, an error string on failure.
    // We don't propagate the string — the caller only needs to know the
    // click "did something". If the file is missing (log path predates a
    // debug-retention prune) the OS shell surfaces its own error dialog.
    try {
      await shell.openPath(logPath)
    } catch (err) {
      console.warn('[cli-updates] failed to open log:', err)
    }
  })
}
