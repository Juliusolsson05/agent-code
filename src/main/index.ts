// Side-effect import — MUST be first so `.env` is loaded into
// `process.env` before PerformanceService (and anything else that
// reads env flags at module load) is imported. See
// `./loadEnv.ts` for the rationale.
import '@main/loadEnv.js'

import { app, BrowserWindow, crashReporter, dialog, Menu } from 'electron'
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
import { buildAppMenu } from '@main/menu/appMenu.js'
import { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { installProcessCrashHooks } from '@main/incident/installCrashHooks.js'
import { installWindowIncidentHooks } from '@main/incident/installWindowIncidentHooks.js'
import { classifyPreviousRun } from '@main/incident/previousRunClassifier.js'

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
let appRunJournal: AppRunJournal | null = null

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

  void app.whenReady().then(startApp).catch((err) => {
    // A throw out of startApp (toolchain or MCP-host init failure, or a disk
    // error while the journal itself starts) would otherwise become an
    // unhandledRejection: the process keeps running with no window and never
    // quits, so `will-quit` never fires and the state-process lock is leaked
    // while THIS pid stays alive. That makes the NEXT launch refuse to start —
    // acquireStateProcessLock sees a live owner and shows "Agent Code is already
    // running" until the zombie is force-killed. Convert a fatal startup error
    // into a clean exit: journal it, flush + release the lock, and quit so a
    // relaunch can proceed. We intentionally do NOT write the clean-shutdown
    // marker — this run WAS unclean, and a future prior-run classifier should
    // see it that way.
    console.error('[app] fatal startup error — releasing lock and quitting:', err)
    // Record as an INCIDENT (synchronous flush) so the failed boot lands in
    // incidents.jsonl and the NEXT launch's classifier can attribute it — a plain
    // event would only hit the async events.jsonl that never flushes before quit.
    appRunJournal?.recordIncident({
      kind: 'app.startup_failed',
      severity: 'fatal',
      process: 'main',
      error: err,
    })
    appRunJournal?.stop()
    // Null the handle BEFORE app.quit(): quit fires the will-quit handler, whose
    // markCleanShutdown() would otherwise write the clean-shutdown marker and make
    // this CRASHED boot look CLEAN on the next launch. (The crash-hook path uses
    // process.exit, which bypasses will-quit; this path uses app.quit, which does
    // NOT — hence the explicit null here, mirroring stateProcessLock below.)
    appRunJournal = null
    stateProcessLock?.releaseSync()
    stateProcessLock = null
    app.quit()
  })
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
  appRunJournal = new AppRunJournal({
    appVersion: app.getVersion(),
    perfEnabled: performanceService.getConfig().enabled,
    lock,
  })
  await appRunJournal.start()
  appRunJournal.record({
    area: 'state.lock',
    name: 'state_lock.acquired',
    data: { path: lock.path },
  })

  // Always-on crash/freeze capture, installed as early as possible so a fault
  // anywhere in the rest of startup is still recorded. The process hooks get a
  // synchronous lock release so a fatal main crash (which exits immediately,
  // bypassing before-quit/will-quit) doesn't strand the lock and block relaunch.
  installProcessCrashHooks({
    journal: appRunJournal,
    releaseLockSync: () => {
      stateProcessLock?.releaseSync()
      stateProcessLock = null
    },
  })
  installWindowIncidentHooks(appRunJournal)
  orchestrationBridge.setJournal(appRunJournal)
  try {
    // Native crashes (V8 aborts, SIGSEGV in native addons, GPU-process death)
    // never reach JS, so the JSONL hooks above cannot see them. Crashpad writes
    // local minidumps for those. uploadToServer:false keeps everything local
    // and privacy-preserving — this is diagnostics, not telemetry.
    crashReporter.start({ uploadToServer: false })
    appRunJournal.record({ area: 'incident.crashreporter', name: 'crashreporter.started' })
  } catch (err) {
    appRunJournal.recordError('crashreporter.start.error', err)
  }

  // Classify how the PREVIOUS run ended, now that this run's journal exists to
  // record the verdict. A missing clean-shutdown marker on the last run becomes
  // an app.prior_unclean_shutdown incident here — the crash that had no living
  // process to report it gets attributed on the next launch instead.
  try {
    const priorRun = classifyPreviousRun(appRunJournal.appRunId)
    if (priorRun && priorRun.classification !== 'clean') {
      const crashLike =
        priorRun.classification === 'main_crash_suspected' ||
        priorRun.classification === 'renderer_crash_suspected'
      appRunJournal.recordIncident({
        kind: 'app.prior_unclean_shutdown',
        severity: crashLike ? 'error' : 'warn',
        reason: priorRun.classification,
        context: {
          priorRunId: priorRun.priorRunId,
          priorRunDir: priorRun.priorRunDir,
          ...priorRun.evidence,
        },
      })
    } else if (priorRun) {
      appRunJournal.record({
        area: 'incident.prior_run',
        name: 'prior_run.clean',
        data: { priorRunId: priorRun.priorRunId },
      })
    }
  } catch (err) {
    // Classification is best-effort forensics — never let it block startup.
    appRunJournal.recordError('prior_run.classify.error', err)
  }

  void performanceService.start().catch(err => {
    console.warn('[performance] failed to start:', err)
    appRunJournal?.recordError('performance.start.error', err)
  })
  performanceService.mark('app.main.whenReady.start')
  // Heap watchdog and debug-storage retention run as early as possible:
  // the watchdog so any pre-toolchain startup stall has forensic coverage,
  // and the retention sweep so stale debug artifacts are off disk before
  // fresh writers start appending. Retention is deliberately fire-and-forget:
  // losing a prune race is acceptable; blocking app boot on a large cache
  // traversal would make the diagnostic system harm the product again.
  startMainHeapWatchdog({
    onHeapPressure: (info) => {
      // Near-OOM is exactly the kind of incident users need to diagnose later.
      // The watchdog already writes the heap snapshot; this records the durable
      // incident that points at it.
      appRunJournal?.recordIncident({
        kind: 'heap.pressure',
        severity: 'error',
        process: 'main',
        context: info,
      })
    },
  })
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
  appRunJournal.record({ area: 'setup.toolchain', name: 'toolchain.start' })
  try {
    await initializeToolchain()
    appRunJournal.record({ area: 'setup.toolchain', name: 'toolchain.end' })
  } catch (err) {
    appRunJournal.recordError('toolchain.error', err)
    throw err
  }
  await cleanupClaudeImageCacheDir().catch(err => {
    console.warn('[images] failed to clean Claude image cache:', err)
    performanceService.error('app.main.imageCache.cleanup.error', err)
    appRunJournal?.recordError('image_cache.cleanup.error', err)
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
  appRunJournal.record({
    area: 'app.tmux',
    name: 'tmux.detect.start',
    data: { bundled: bundledTmux !== null },
  })
  const tmuxAvailable = await tmuxRegistry.detectAvailability()
  appRunJournal.record({
    area: 'app.tmux',
    name: 'tmux.detect.end',
    data: {
      available: tmuxAvailable,
      durationMs: performance.now() - tmuxDetectStarted,
    },
  })
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
      appRunJournal.record({ area: 'app.tmux', name: 'tmux.recovery.start' })
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
      appRunJournal.record({
        area: 'app.tmux',
        name: 'tmux.recovery.end',
        data: {
          recoverable: recoveryReport.recoverable.length,
          lost: recoveryReport.lost.length,
          orphans: recoveryReport.orphans.length,
        },
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
        appRunJournal?.recordError('tmux.recovery.error', err)
      }
    }
  }

  // Give the host its journal BEFORE start() so a bind failure can record its
  // mcp.host_start_failed incident — setDependencies() (which also carries the
  // journal) only runs AFTER start(), because it needs `manager`, so without this
  // the incident would be dead code.
  builtInMcpHost.setJournal(appRunJournal)
  appRunJournal.record({ area: 'mcp.host', name: 'mcp_host.start' })
  try {
    await builtInMcpHost.start()
    appRunJournal.record({ area: 'mcp.host', name: 'mcp_host.end' })
  } catch (err) {
    appRunJournal.recordError('mcp_host.error', err)
    throw err
  }
  manager = new SessionManager(tmuxAvailable ? tmuxRegistry : null, builtInMcpHost, appRunJournal)
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
    appRunJournal,
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
    appRunJournal,
  })
  performanceService.mark('app.main.ipc.registered')
  appRunJournal.record({ area: 'window.main', name: 'window.create.start' })
  createMainWindow()
  appRunJournal.record({
    area: 'window.main',
    name: 'window.create.end',
    data: { windowCount: BrowserWindow.getAllWindows().length },
  })
  // Install the application menu right after the window exists — the File
  // items dispatch command ids to THIS window's renderer (issue #148).
  Menu.setApplicationMenu(buildAppMenu())
  performanceService.mark('app.main.window.created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
}

app.on('window-all-closed', () => {
  void manager?.killAll()
  void builtInMcpHost.stop()
  void lspManager.dispose()
  // WHY we release caffeinate here even though macOS keeps the app process
  // alive after the last window closes:
  // this same branch kills every live agent session. Keeping a sleep
  // assertion after all windows and sessions are gone would keep the machine
  // awake for an app that no longer has active work to protect. Cmd+Q also
  // reaches before-quit below; this branch covers the close-window path.
  caffeinateController.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appRunJournal?.record({ area: 'app.lifecycle', name: 'app.before_quit' })
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
})

app.on('will-quit', () => {
  appRunJournal?.record({ area: 'app.lifecycle', name: 'app.will_quit' })
  appRunJournal?.markCleanShutdown('will-quit')
  appRunJournal?.stop()
  stateProcessLock?.releaseSync()
  stateProcessLock = null
})
