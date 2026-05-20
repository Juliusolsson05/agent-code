// Side-effect import — MUST be first so `.env` is loaded into
// `process.env` before PerformanceService (and anything else that
// reads env flags at module load) is imported. See
// `./loadEnv.ts` for the rationale.
import '@main/loadEnv.js'

import { app, BrowserWindow, dialog } from 'electron'
import { readFile } from 'fs/promises'
import { performance } from 'perf_hooks'

import { SessionManager } from '@main/sessionManager.js'
import { LspManager } from '@main/lspManager.js'
import { compactAllGhostLogs, GhostJournalRegistry } from '@main/ghostJournal.js'
import {
  DictationDebugJournalRegistry,
  pruneOldDictationDebugLogs,
} from '@main/dictationJournal.js'
import {
  PasteDebugJournalRegistry,
  pruneOldPasteDebugLogs,
} from '@main/pasteDebugJournal.js'
import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { reconcile, type PersistedTerminalRef } from '@main/tmux/tmuxRecovery.js'

import { STATE_FILE } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
import { cleanupClaudeImageCacheDir } from '@main/storage/claudeImageCache.js'
import { acquireStateProcessLock, type StateProcessLock } from '@main/storage/processLock.js'
import { createMainWindow, focusMainWindow, sendToMainWindow } from '@main/window/mainWindow.js'
import { wireSessionForwarder } from '@main/sessions/forwarder.js'
import { registerAllIpc } from '@main/ipc/index.js'
import { cleanupDictationIpcResources } from '@main/ipc/dictation.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { startMainHeapWatchdog, stopMainHeapWatchdog } from '@main/performance/heapWatchdog.js'
import { resolveBundledTool } from '@main/setup/runtimeTools.js'
import { initializeToolchain } from '@main/setup/toolchain.js'
import { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import { CaffeinateController } from '@main/caffeinate/CaffeinateController.js'

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
// Per-dictation-session debug-dump registry. Mirrors `ghostJournals`:
// constructed before IPC handlers register, flushed on before-quit. See
// `src/main/dictationJournal.ts` for the on-disk shape and the
// rationale for cloning the ghost-journal pattern instead of refactoring
// them into a single shared writer.
const dictationDebugJournals = new DictationDebugJournalRegistry()
// Per-paste debug-dump registry. Same lifecycle as dictationDebugJournals:
// constructed before IPC handlers register, flushed on before-quit,
// pruned on startup. Diagnostic for the "first Enter does nothing"
// paste-submit bug; see docs/superpowers/plans/2026-05-11-paste-submit-
// harness-findings-and-fix.md for context.
const pasteDebugJournals = new PasteDebugJournalRegistry()
const worktreeActivityIndex = new WorktreeActivityIndex()
const builtInMcpHost = new BuiltInMcpHttpHost()
const orchestrationBridge = new OrchestrationBridge()
const aiWorkspaceRegistry = new AiWorkspaceRegistry()
const caffeinateController = new CaffeinateController()

// SessionManager is constructed inside whenReady so we can await
// TmuxRegistry.detectAvailability() first — terminal sessions need
// to know during spawn whether a tmux backend is available, and
// detection requires a child-process roundtrip. The 'let' is
// load-bearing: every other module-scope reference is inside
// callbacks that fire after the assignment.
let manager: SessionManager | null = null
let tmuxRegistry: TmuxRegistry | null = null
let stateProcessLock: Extract<StateProcessLock, { acquired: true }> | null = null

// WHY Agent Code is intentionally single-primary-process:
//
// The renderer persists the whole workspace as one `workspace.json` snapshot,
// main keeps AI Workspace and worktree-index state in process-local maps, and
// provider resume starts real Claude/Codex processes that tail native
// transcripts. Making 2+ Electron mains safe would require database-style
// revision/merge semantics and provider-session ownership across all of those
// surfaces. The current product shape is one primary process with one window;
// a future multi-window UI should add windows to THIS process, not launch more
// mains against the same `~/.config/agent-code` state root.
//
// Electron's single-instance lock handles the normal "user opened the app
// again" path and lets us focus the existing window. The state-process lock in
// `startApp()` is a second belt for dev/prod or app-identity splits where
// Electron might consider the processes different but our STATE_DIR is still
// shared. If that lock ever feels too strict, the storage model must be changed
// first; deleting the guard alone would make last-writer-wins corruption
// possible again.
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  void app.whenReady().then(startApp)
}

// ---------- App lifecycle ----------

async function startApp(): Promise<void> {
  const lock = await acquireStateProcessLock()
  if (!lock.acquired) {
    console.warn(
      '[app] refusing to start a second Agent Code main process for shared state:',
      {
        lockPath: lock.path,
        reason: lock.reason,
        ownerPid: lock.owner?.pid ?? null,
        ownerStartedAt: lock.owner?.startedAt ?? null,
      },
    )
    dialog.showErrorBox(
      'Agent Code is already running',
      'Another Agent Code process appears to own the shared app state. Close the existing app window before starting a second copy.',
    )
    app.quit()
    return
  }
  stateProcessLock = lock

  void performanceService.start().catch(err => {
    console.warn('[performance] failed to start:', err)
  })
  performanceService.mark('app.main.whenReady.start')
  // Heap watchdog and debug-storage retention run as early as possible:
  // the watchdog so any pre-toolchain startup stall has forensic coverage,
  // and the retention sweep so stale debug artifacts are off disk before
  // fresh writers start appending. Retention is deliberately fire-and-forget:
  // losing a prune race is acceptable; blocking app boot on a large cache
  // traversal would make the diagnostic system harm the product again.
  startMainHeapWatchdog()
  // Dictation debug logs grow per-press. The pruner trims files older
  // than 14 days at startup; fire-and-forget — a slow or failing
  // prune must NOT delay window creation. See dictationJournal.ts.
  void pruneOldPasteDebugLogs().catch(err => {
    console.warn('[paste-debug] prune failed (non-fatal):', err)
  })
  void pruneOldDictationDebugLogs().catch(err => {
    console.warn('[dictation] prune failed (non-fatal):', err)
  })
  // Ghost-log reads are now streaming, but a years-long append-only
  // file still makes every future restore pay O(file-size) parse CPU.
  // Startup compaction is conservative because this sweep is async:
  // a resumed session may create its writer while the directory pass is
  // still reading a large file. The registry check is repeated inside
  // the compactor before rename so a newly-live session keeps append-only
  // safety and can compact on dispose instead.
  void compactAllGhostLogs(sessionId => ghostJournals.has(sessionId)).catch(err => {
    console.warn('[ghostJournal] startup compact failed (non-fatal):', err)
  })
  scheduleDebugStoragePrune('startup')
  await initializeToolchain()
  await cleanupClaudeImageCacheDir().catch(err => {
    console.warn('[images] failed to clean Claude image cache:', err)
    performanceService.error('app.main.imageCache.cleanup.error', err)
  })
  // Tmux availability is checked once at startup. The cost is a
  // child-process roundtrip on `tmux -V` — cheap enough to await
  // before any IPC is wired. Result is cached on the registry; call
  // sites use isAvailable() synchronously thereafter.
  // WHY bundled-only with no PATH fallback:
  //   Agent Code ships its own tmux 3.6a (see issue #120 and
  //   third_party/tmux/). Falling back to whatever `tmux` resolves on
  //   PATH would re-introduce the exact "works on my machine"
  //   pathology that bundling was meant to fix — different versions,
  //   incompatible session formats, Homebrew dylib drift.
  //
  //   When the bundled binary cannot be resolved (dev build without
  //   `runtime:prepare:mac`, or a corrupted asar.unpacked), we pass
  //   `tmuxBinary: undefined` to TmuxRegistry. The registry then
  //   short-circuits `detectAvailability()` to `false` WITHOUT
  //   spawning anything — terminals fall back to direct-PTY mode,
  //   same as a machine without tmux installed. No silent
  //   system-tmux usage, no PATH lookup, no sentinel-string trickery.
  const bundledTmux = await resolveBundledTool('tmux')
  tmuxRegistry = new TmuxRegistry({ tmuxBinary: bundledTmux ?? undefined })
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

  await builtInMcpHost.start()
  manager = new SessionManager(tmuxAvailable ? tmuxRegistry : null, builtInMcpHost)
  builtInMcpHost.setDependencies({
    orchestrationBridge,
    aiWorkspaceRegistry,
    openAiWorkspace: workspaceId => {
      // WHY this is a one-way UI request rather than a main-owned UI state:
      //
      // MCP tools run in main because providers talk to the built-in MCP host
      // there, but the Global Editor overlay is renderer-owned workspace UI.
      // Main validates the workspace exists through the registry, then emits a
      // narrow "open this id" request. The renderer decides how to present it,
      // preserving the existing rule that layout/chrome state stays renderer
      // local instead of turning main into a second UI store.
      sendToMainWindow('ai-workspace:open-request', { workspaceId })
    },
    sessionManager: manager,
  })
  performanceService.mark('app.main.sessionManager.created')

  wireSessionForwarder(manager, lspManager)
  registerAllIpc({
    manager,
    lspManager,
    ghostJournals,
    dictationDebugJournals,
    pasteDebugJournals,
    worktreeActivityIndex,
    orchestrationBridge,
    aiWorkspaceRegistry,
    caffeinateController,
  })
  performanceService.mark('app.main.ipc.registered')
  createMainWindow()
  performanceService.mark('app.main.window.created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

app.on('window-all-closed', () => {
  void manager?.killAll()
  void builtInMcpHost.stop()
  void lspManager.dispose()
  caffeinateController.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  performanceService.mark('app.main.beforeQuit')
  void manager?.killAll()
  void builtInMcpHost.stop()
  void lspManager.dispose()
  caffeinateController.dispose()
  cleanupDictationIpcResources()
  stopMainHeapWatchdog()
  // Flush pending ghost writes. Fire-and-forget is fine — Electron's
  // quit path gives us a tick before teardown. 100 ms queue depth is
  // worst-case; in practice drains are empty at quit time because
  // streaming is idle.
  void ghostJournals.flushAll()
  // Same rationale as ghostJournals — Electron gives us one tick before
  // teardown. 100 ms queue depth is the worst case; in practice the
  // dictation journal is idle at quit unless the user is pressing Fn
  // at the exact moment of app shutdown.
  void dictationDebugJournals.flushAll()
  void pasteDebugJournals.flushAll()
  performanceService.stop()
  stateProcessLock?.releaseSync()
  stateProcessLock = null
})
