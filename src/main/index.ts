import { app, BrowserWindow } from 'electron'
import { readFile } from 'fs/promises'
import { performance } from 'perf_hooks'

import { SessionManager } from '@main/sessionManager.js'
import { LspManager } from '@main/lspManager.js'
import { GhostJournalRegistry } from '@main/ghostJournal.js'
import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { reconcile, type PersistedTerminalRef } from '@main/tmux/tmuxRecovery.js'

import { STATE_FILE } from '@main/storage/paths.js'
import { cleanupClaudeImageCacheDir } from '@main/storage/claudeImageCache.js'
import { createMainWindow } from '@main/window/mainWindow.js'
import { wireSessionForwarder } from '@main/sessions/forwarder.js'
import { registerAllIpc } from '@main/ipc/index.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getToolPath, initializeToolchain } from '@main/setup/toolchain.js'
import { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'

// Main process — thin Electron host.
//
// Responsibilities kept here (anything that isn't a domain concern of
// its own lives in these few lines):
//   1. Construct the long-lived service singletons (LspManager,
//      GhostJournalRegistry) before anything else needs them.
//   2. Detect tmux availability and reconcile persisted terminal
//      sessions BEFORE SessionManager is built — spawn recovery
//      needs to know which tmux sessions are already alive.
//   3. Build the BrowserWindow, wire the SessionManager → renderer
//      forwarder, and register every IPC handler.
//   4. Kill all sessions cleanly on app quit.
//
// Everything else is delegated:
//   - IPC handlers: main/ipc/*.ts
//   - SessionManager → renderer forwarding: main/sessions/forwarder.ts
//   - Window creation + send helper: main/window/mainWindow.ts
//   - Disk paths, image cache, feed-debug writer: main/storage/*
//   - History chunk loader + jsonl coalescer: main/sessions/*
//
// The tile tree itself lives in the renderer — main has no idea what
// a "tab" or a "split" is. It just manages PTYs and shuffles bytes.

const lspManager = new LspManager()
// Ghost log writer — one queue per session. Writes are batched at
// 100 ms and persisted under `<userData>/ghost-logs/<sessionId>.ghost.jsonl`.
// See `./ghostJournal.ts` for the full rationale; see
// `src/renderer/src/workspace/ghosts.ts` for the renderer side.
const ghostJournals = new GhostJournalRegistry()
const worktreeActivityIndex = new WorktreeActivityIndex()

// SessionManager is constructed inside whenReady so we can await
// TmuxRegistry.detectAvailability() first — terminal sessions need
// to know during spawn whether a tmux backend is available, and
// detection requires a child-process roundtrip. The 'let' is
// load-bearing: every other module-scope reference is inside
// callbacks that fire after the assignment.
let manager: SessionManager = null as unknown as SessionManager
let tmuxRegistry: TmuxRegistry | null = null

void performanceService.start().catch(err => {
  console.warn('[performance] failed to start:', err)
})

// ---------- App lifecycle ----------

app.whenReady().then(async () => {
  performanceService.mark('app.main.whenReady.start')
  await initializeToolchain()
  await cleanupClaudeImageCacheDir().catch(err => {
    console.warn('[images] failed to clean Claude image cache:', err)
    performanceService.error('app.main.imageCache.cleanup.error', err)
  })
  // Tmux availability is checked once at startup. The cost is a
  // child-process roundtrip on `tmux -V` — cheap enough to await
  // before any IPC is wired. Result is cached on the registry; call
  // sites use isAvailable() synchronously thereafter.
  tmuxRegistry = new TmuxRegistry({ tmuxBinary: getToolPath('tmux', 'tmux') })
  const tmuxDetectStarted = performance.now()
  const tmuxAvailable = await tmuxRegistry.detectAvailability()
  performanceService.record({
    kind: 'span_end',
    process: 'main',
    area: 'app.tmux',
    name: 'app.tmux.detect',
    durationMs: performance.now() - tmuxDetectStarted,
    data: { available: tmuxAvailable },
  })
  console.log(
    tmuxAvailable
      ? '[tmux] available — terminals will persist across restarts'
      : '[tmux] not installed — terminals will use direct PTY (non-persistent)',
  )

  // Recovery runs BEFORE SessionManager is constructed so the
  // renderer's first session-spawn can ask to recover an alive
  // tmux session by name. Reads the persisted workspace.json
  // directly — it's the same file the renderer will load shortly
  // via workspace:load IPC, but we need the tmuxName values earlier.
  if (tmuxAvailable) {
    try {
      const raw = await readFile(STATE_FILE, 'utf8')
      // workspace.json is wrapped: { workspace: { sessions: {...} } }.
      // The renderer's saveWorkspace() writes { workspace: workspaceState }
      // — so persisted sessions live one level deep, not at the root.
      // Reading parsed.sessions directly (as the original code did)
      // always returned undefined, which is why recovery silently
      // reported "0 recoverable" even when tmuxName WAS persisted.
      const parsed = JSON.parse(raw) as {
        workspace?: {
          sessions?: Record<string, { kind?: string; tmuxName?: string }>
        }
      }
      const persisted: PersistedTerminalRef[] = Object.entries(
        parsed.workspace?.sessions ?? {},
      )
        .filter(([, meta]) => meta?.kind === 'terminal' && typeof meta?.tmuxName === 'string')
        .map(([sessionId, meta]) => ({ sessionId, tmuxName: meta!.tmuxName! }))
      const recoveryReport = await reconcile(tmuxRegistry, persisted)
      performanceService.mark('app.tmux.recovery.complete', {
        recoverable: recoveryReport.recoverable.length,
        lost: recoveryReport.lost.length,
        orphans: recoveryReport.orphans.length,
      })
      console.log(
        `[tmux] recovery: ${recoveryReport.recoverable.length} recoverable, ${recoveryReport.lost.length} lost, ${recoveryReport.orphans.length} orphans cleaned`,
      )
    } catch (err) {
      // Missing/corrupt workspace.json is fine — fresh launch falls
      // through with empty buckets. Log so a real failure is visible.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[tmux] recovery failed (treating all sessions as fresh):', err)
        performanceService.error('app.tmux.recovery.error', err)
      }
    }
  }

  manager = new SessionManager(tmuxAvailable ? tmuxRegistry : null)
  performanceService.mark('app.main.sessionManager.created')

  wireSessionForwarder(manager, lspManager)
  registerAllIpc({ manager, lspManager, ghostJournals, worktreeActivityIndex })
  performanceService.mark('app.main.ipc.registered')
  createMainWindow()
  performanceService.mark('app.main.window.created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  void manager.killAll()
  void lspManager.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  performanceService.mark('app.main.beforeQuit')
  void manager.killAll()
  void lspManager.dispose()
  // Flush pending ghost writes. Fire-and-forget is fine — Electron's
  // quit path gives us a tick before teardown. 100 ms queue depth is
  // worst-case; in practice drains are empty at quit time because
  // streaming is idle.
  void ghostJournals.flushAll()
  performanceService.stop()
})
