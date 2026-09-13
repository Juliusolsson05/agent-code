import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { monitorCoordinator } from '@main/performance/MonitorCoordinator.js'
import { performanceTraceController } from '@main/performance/PerformanceTraceController.js'
import { mainOperations } from '@main/performance/operations.js'
import { getBuildInfo } from '@main/buildInfo.js'
import { windowForSession, windowIdFor } from '@main/window/windowRegistry.js'
import { parseMonitorRendererBatch } from '@shared/performance/monitorContracts.js'
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8'
import { mainProbe } from '@main/performance/MainProbe.js'
import { mkdir, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { moveArtifact } from '@main/performance/moveArtifact.js'

import { performanceService } from '@main/performance/PerformanceService.js'
import { ProcessTelemetry } from '@main/performance/ProcessTelemetry.js'
import { HEAP_SNAPSHOT_DIR, PERFORMANCE_CAPTURE_TEMP_DIR } from '@main/storage/paths.js'
import type { SessionManager } from '@main/sessionManager.js'
import type {
  PerformanceRecord,
  SystemPerformanceStats,
} from '@shared/performance/types.js'

const revealablePerformancePaths = new Set<string>()

function rememberRevealable(path: string): void {
  // Renderer callers may reveal only artifacts this process actually created.
  // A small insertion-ordered set avoids turning the convenience IPC into a
  // general filesystem browser while still covering several captures in one
  // diagnostic session.
  if (revealablePerformancePaths.size >= 32) {
    const oldest = revealablePerformancePaths.values().next().value
    if (oldest) revealablePerformancePaths.delete(oldest)
  }
  revealablePerformancePaths.add(path)
}

function traceStatusFor(windowId: number) {
  const status = performanceTraceController.status()
  // A trace is app-wide, so every window needs its state and lock owner. Its
  // user-selected filesystem destination belongs only to the initiating
  // renderer and is unnecessary for cross-window coordination.
  if (status.path && status.ownerWindowId === windowId) rememberRevealable(status.path)
  return status.ownerWindowId === windowId ? status : { ...status, ownerWindowId: null, path: null }
}

export function registerPerformanceIpc(manager: SessionManager): void {
  const processTelemetry = new ProcessTelemetry(manager)
  monitorCoordinator.startProcesses(() => manager.getProcessTelemetryTargets())
  ipcMain.handle('performance:monitor-incident', (event, id: number) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    return monitorCoordinator.readIncident(id)
  })
  ipcMain.handle('performance:monitor-history-incident', (event, at: number, id: number) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    return monitorCoordinator.readHistoryIncident(at, id)
  })
  ipcMain.handle('performance:monitor-history', (event, from: number, to: number, cursor?: unknown, limit?: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    // Renderer arguments are untyped at runtime; the coordinator validates the
    // limit and rejects a non-string cursor before anything reaches the helper.
    return monitorCoordinator.readHistory(from, to, typeof cursor === 'string' ? cursor : undefined, limit)
  })
  ipcMain.handle('performance:monitor-report-preview', (event, from: number, to: number) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    return monitorCoordinator.previewReport(from, to)
  })
  ipcMain.handle('performance:monitor-save-report', async (event, from: number, to: number) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { ok: false, code: 'unavailable' as const }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const selection = await dialog.showSaveDialog(window, {
      title: 'Save Performance Report',
      defaultPath: `agent-code-performance-${stamp}.json`,
      filters: [{ name: 'JSON report', extensions: ['json'] }],
    })
    if (selection.canceled || !selection.filePath) return { ok: false, code: 'cancelled' as const }
    // The renderer never supplies a filesystem path. Main receives the native
    // picker result and the worker receives only that explicit destination,
    // preventing this narrow report API from becoming arbitrary file write.
    const result = await monitorCoordinator.exportReport(from, to, selection.filePath, {
      ...getBuildInfo(), platform: process.platform, architecture: process.arch,
      electron: process.versions.electron ?? 'unknown', node: process.versions.node,
    })
    if (result.ok) rememberRevealable(selection.filePath)
    return result.ok ? { ...result, path: selection.filePath } : result
  })
  ipcMain.handle('performance:monitor-clear-history', async event => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Clear performance history?',
      message: 'Delete locally stored performance history and incident evidence?',
      detail: 'Live monitoring continues immediately. Saved reports and performance traces are not deleted.',
      buttons: ['Cancel', 'Clear History'], defaultId: 0, cancelId: 0, noLink: true,
    })
    return answer.response === 1 ? monitorCoordinator.clearHistory() : monitorCoordinator.readHistoryStatus()
  })
  ipcMain.handle('performance:monitor-trace-status', event => BrowserWindow.fromWebContents(event.sender) ? traceStatusFor(event.sender.id) : null)
  ipcMain.handle('performance:monitor-start-trace', async (event, mode: unknown, durationMs?: number) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || (mode !== 'chromium' && mode !== 'main-cpu')) return null
    const existing = performanceTraceController.status()
    if (existing.state === 'starting' || existing.state === 'recording' || existing.state === 'stopping') return traceStatusFor(event.sender.id)
    const label = mode === 'chromium' ? 'Chromium Performance Trace' : 'Main CPU Profile'
    const extension = mode === 'chromium' ? 'json' : 'cpuprofile'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const selection = await dialog.showSaveDialog(window, {
      title: `Save ${label}`, defaultPath: `agent-code-${mode}-${stamp}.${extension}`,
      filters: [{ name: label, extensions: [extension] }],
    })
    if (selection.canceled || !selection.filePath) return traceStatusFor(event.sender.id)
    // Closing the owner while Chromium or Inspector is still starting must not
    // leave a hidden app-wide profiler behind. The controller remembers this
    // cancellation even if startRecording has not resolved yet.
    const ownerId = event.sender.id
    event.sender.once('destroyed', () => { void performanceTraceController.cancelOwner(ownerId) })
    await performanceTraceController.start(ownerId, mode, selection.filePath, durationMs)
    return traceStatusFor(ownerId)
  })
  ipcMain.handle('performance:monitor-stop-trace', (event, cancel?: boolean) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    const ownerId = event.sender.id
    return performanceTraceController.stop(ownerId, cancel === true).then(() => traceStatusFor(ownerId))
  })
  ipcMain.handle('performance:monitor-processes', (event, offset?: number, sort?: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    return monitorCoordinator.readProcesses(offset, sort === 'memory' ? 'memory' : 'cpu')
  })

  ipcMain.handle('performance:monitor-snapshot', event => {
    if (!BrowserWindow.fromWebContents(event.sender)) return null
    return monitorCoordinator.read()
  })
  ipcMain.handle('performance:monitor-batch', (event, input: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return
    const records = parseMonitorRendererBatch(input)
    if (!records) return
    for (const record of records) {
      if (record.kind === 'operation') monitorCoordinator.operation(record, event.sender.id)
      else if (record.kind === 'loss') monitorCoordinator.sourceLoss(event.sender.id, record.source, record.dropped)
    }
  })
  ipcMain.on('performance:monitor-response-begin', (event, sessionId: unknown, operationId?: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender) || typeof sessionId !== 'string'
      || windowIdFor(event.sender) !== windowForSession(sessionId)) return
    manager.beginMonitorResponse(sessionId, typeof operationId === 'string' ? operationId : undefined)
  })
  // No cancel channel: renderer cancellations are local. Main never starts a
  // renderer-requested timer before acceptance, and main-delivered prompts
  // cancel themselves from the delivery result, so a per-commit cancel IPC
  // from hidden tiles was pure main-process traffic.

  ipcMain.handle('performance:get-config', () => performanceService.getConfig())

  ipcMain.handle('performance:batch', async (_evt, records: PerformanceRecord[]) => {
    if (!Array.isArray(records) || records.length === 0) return
    performanceService.recordBatch(records)
  })

  ipcMain.handle('performance:flush', async () => {
    await performanceService.flush()
  })

  ipcMain.handle('performance:snapshot', async () => performanceService.snapshot())

  ipcMain.handle('performance:pane-stats', async (_evt, sessionIds?: string[]) =>
    processTelemetry.snapshot(Array.isArray(sessionIds) ? sessionIds : undefined),
  )

  // Keep the legacy endpoint compatible, but UI reads now share the same
  // timestamped sample as the monitor and journal and never reset a window.
  ipcMain.handle('performance:system-stats', (): SystemPerformanceStats => ({
    ...mainProbe.read(), enabled: performanceService.getConfig().enabled,
  }))

  // On-demand heap snapshot. Writes a .heapsnapshot file the user
  // can load into Chrome DevTools' Memory tab to see retainer chains
  // and per-constructor instance counts — the gold-standard
  // diagnostic when the live numbers say "leak" but you need to know
  // WHICH object is being retained.
  //
  // WHY this is a separate handler instead of folding it into the
  // 1 Hz system-stats poll: writeHeapSnapshot is a multi-second
  // stop-the-world operation that produces a 100 MB-to-3 GB file. It
  // is appropriate behind an explicit "user clicked Capture" gesture,
  // never as a passive sample.
  //
  // WHY we return the file path: the popover's button can then call
  // shell.showItemInFolder via a follow-up IPC (or the user can
  // navigate to it manually). Returning the path also makes the
  // operation testable without scraping log output.
  //
  // WHY no AGENT_CODE_PERF gate: heap snapshots are a debugging
  // escape hatch, not telemetry. If the user has the popover open
  // (which already implies the flag is on, since the popover only
  // renders when enabled), letting them capture is the right move
  // regardless of the broader telemetry pipeline state.
  ipcMain.handle('performance:write-heap-snapshot', async (event): Promise<{
    ok: true
    path: string
  } | {
    ok: false
    error: string
  }> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { ok: false, error: 'Heap snapshot is unavailable.' }
    const usedHeap = getHeapStatistics().used_heap_size
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Capture heap snapshot?',
      message: 'Agent Code may pause while the main JavaScript heap is written.',
      detail: `The file is usually at least ${(usedHeap / 1024 ** 2).toFixed(0)} MiB. Heap snapshots can contain sensitive application memory. Capture only when you intend to inspect the file locally.`,
      buttons: ['Cancel', 'Choose Location…'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (answer.response !== 1) return { ok: false, error: 'Capture cancelled.' }
    try {
      await mkdir(HEAP_SNAPSHOT_DIR, { recursive: true })
      await mkdir(PERFORMANCE_CAPTURE_TEMP_DIR, { recursive: true, mode: 0o700 })
    } catch (err) {
      console.warn('[perf-snapshot] mkdir failed', err)
      return { ok: false, error: 'Snapshot storage is unavailable.' }
    }
    // WHY a picker: snapshots used to land silently in app state, so the user
    // saw "saved locally" with no idea where a multi-hundred-megabyte file
    // went. The default still points at the retention-managed root.
    const selection = await dialog.showSaveDialog(window, {
      title: 'Save Heap Snapshot',
      defaultPath: join(HEAP_SNAPSHOT_DIR, `agent-code-main-${new Date().toISOString().replace(/[:.]/g, '-')}.heapsnapshot`),
      filters: [{ name: 'Heap snapshot', extensions: ['heapsnapshot'] }],
    })
    if (selection.canceled || !selection.filePath) return { ok: false, error: 'Capture cancelled.' }
    const destination = selection.filePath
    const temporary = join(PERFORMANCE_CAPTURE_TEMP_DIR, `heap-${process.pid}-${Date.now()}.tmp`)
    let finishSnapshot: ReturnType<typeof mainOperations.begin> | null = null
    try {
      // WHY headroom instead of a hard size cap: a large heap is exactly the
      // leak this capture diagnoses, so refusing big snapshots would defeat
      // it. Instead require space for the estimate on both the scratch volume
      // and the destination volume (a cross-volume move copies the file).
      const required = Math.max(512 * 1024 * 1024, usedHeap * 3)
      for (const dir of new Set([PERFORMANCE_CAPTURE_TEMP_DIR, dirname(destination)])) {
        const disk = await statfs(dir)
        if (disk.bavail * disk.bsize < required) return { ok: false, error: 'Not enough free disk space for a heap snapshot.' }
      }
      finishSnapshot = mainOperations.begin('heap.snapshot')
      writeHeapSnapshot(temporary)
      await moveArtifact(temporary, destination)
      finishSnapshot()
      rememberRevealable(destination)
      return { ok: true, path: destination }
    } catch (err) {
      finishSnapshot?.('error')
      await rm(temporary, { force: true }).catch(() => {})
      console.warn('[perf-snapshot] write failed', err)
      return {
        ok: false,
        error: 'Heap snapshot could not be written.',
      }
    }
  })

  // Reveal the snapshot file in Finder / Explorer.
  //
  // WHY a separate handler instead of doing shell.showItemInFolder
  // inside write-heap-snapshot: writing the file can take seconds.
  // If we revealed inside the same handler, the renderer would block
  // on a long IPC roundtrip while the user is also waiting on the
  // snapshot. Splitting them means the renderer can show a "Captured
  // → click to reveal" state immediately after the path is returned,
  // and reveal becomes a separate near-instant IPC.
  ipcMain.handle('performance:reveal-path', async (_evt, path: string): Promise<void> => {
    if (typeof path !== 'string' || !revealablePerformancePaths.has(path)) return
    shell.showItemInFolder(path)
  })
}
