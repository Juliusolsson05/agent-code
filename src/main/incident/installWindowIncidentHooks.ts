import { app } from 'electron'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

// Window / child-process incident hooks.
//
// WHY app-level + per-window-on-create instead of editing mainWindow.ts:
// these signals must be captured for EVERY window/webContents, including any
// future secondary windows, and main must report them on its own — the renderer
// can't report its own crash once it's gone (a core invariant of the plan).
// Attaching via the `browser-window-created` app event means we instrument
// windows uniformly without coupling the journal to the window-creation code.

export function installWindowIncidentHooks(journal: AppRunJournal): void {
  // Renderer/GPU/utility process death. This is THE renderer-crash signal —
  // main observes it even though the renderer is already gone.
  app.on('render-process-gone', (_event, _webContents, details) => {
    // Skip 'clean-exit' entirely — it's routine teardown (window closed / app
    // quitting) and recording it would fill incidents.jsonl with steady noise
    // (plan: ignore clean-exit unless it happens in an unexpected phase).
    if (details.reason === 'clean-exit') return
    // 'killed' frequently occurs during macOS quit teardown, so it's a warning,
    // not a fatal — the genuinely fatal reasons are oom / crashed / abnormal-exit
    // / launch-failed / integrity-failure.
    const fatal = details.reason !== 'killed'
    journal.recordIncident({
      kind: 'window.render_process_gone',
      severity: fatal ? 'fatal' : 'warn',
      process: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  // Electron child processes (GPU, utility, pepper plugin, etc.) dying.
  app.on('child-process-gone', (_event, details) => {
    const clean = details.reason === 'clean-exit'
    journal.recordIncident({
      kind: 'electron.child_process_gone',
      severity: clean ? 'warn' : 'error',
      process: 'child',
      reason: details.reason,
      exitCode: details.exitCode,
      context: { type: details.type, name: details.name, serviceName: details.serviceName },
    })
  })

  app.on('browser-window-created', (_event, window) => {
    // Track when this window went unresponsive so 'responsive' can report how
    // long it was frozen. Keyed by window id; cleared on recovery.
    let unresponsiveSince: number | null = null

    window.on('unresponsive', () => {
      unresponsiveSince = Date.now()
      journal.recordIncident({
        kind: 'window.unresponsive',
        severity: 'error',
        process: 'renderer',
        context: { windowId: window.id },
      })
    })

    window.on('responsive', () => {
      const frozenMs = unresponsiveSince === null ? undefined : Date.now() - unresponsiveSince
      unresponsiveSince = null
      journal.recordIncident({
        kind: 'window.responsive',
        severity: 'warn',
        process: 'renderer',
        context: { windowId: window.id, frozenMs },
      })
    })

    window.webContents.on('preload-error', (_e, preloadPath, error) => {
      // A failed preload means the renderer boots without its IPC bridge — the
      // app is effectively broken even though the window "loaded".
      journal.recordIncident({
        kind: 'window.preload_error',
        severity: 'error',
        process: 'renderer',
        error,
        context: { preloadPath },
      })
    })

    window.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // ERR_ABORTED (-3) is the routine "navigation superseded / cancelled"
      // case (and fires constantly for cancelled sub-resource loads). Ignoring
      // it keeps did_fail_load meaningful — a main-frame failure is a real
      // "the app didn't load" incident; a sub-frame one is a warning.
      if (errorCode === -3) return
      journal.recordIncident({
        kind: 'window.did_fail_load',
        severity: isMainFrame ? 'error' : 'warn',
        process: 'renderer',
        reason: errorDescription,
        context: { errorCode, validatedURL, isMainFrame },
      })
    })
  })
}
