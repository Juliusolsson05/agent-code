// Side-effect import — MUST be first so `.env` is loaded into
// `process.env` before PerformanceService (and anything else that
// reads env flags at module load) is imported. See
// `./loadEnv.ts` for the rationale.
import '@main/loadEnv.js'

import { app, BrowserWindow, crashReporter, dialog, Menu } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { performance } from 'perf_hooks'

import { SessionManager } from '@main/sessionManager.js'
import { installSessionShutdownGate } from '@main/sessionShutdownGate.js'
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
import { reconcile } from '@main/tmux/tmuxRecovery.js'
import type { PersistedTerminalRef } from '@main/tmux/tmuxRecovery.js'

import { STATE_DIR, STATE_FILE } from '@main/storage/paths.js'
import {
  scheduleDebugStoragePrune,
  setDebugRetentionJournal,
  setLiveRecordingDirsProvider,
} from '@main/storage/debugRetention.js'
import { cleanupClaudeImageCacheDir } from '@main/storage/claudeImageCache.js'
import { acquireStateProcessLock } from '@main/storage/processLock.js'
import type { StateProcessLock } from '@main/storage/processLock.js'
import { createMainWindow, focusMainWindow, sendToMainWindow } from '@main/window/mainWindow.js'
import { wireSessionForwarder } from '@main/sessions/forwarder.js'
import type { SessionForwarderControl } from '@main/sessions/forwarder.js'
import { SessionRecorderManager } from '@main/recording/SessionRecorderManager.js'
import { setOutboundObserver } from '@main/window/mainWindow.js'
import { isSessionRecordingEnabled, isSessionRecordingAutoStart } from '@main/ipc/devDebug.js'
import { registerAllIpc } from '@main/ipc/index.js'
import { AgentCodeConventionsService } from '@main/agentCodeConventions/AgentCodeConventionsService.js'
import { cleanupDictationIpcResources } from '@main/ipc/dictation.js'
import { flushHistoryWrites } from '@main/dictation/historyStore.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { startMainHeapWatchdog, stopMainHeapWatchdog } from '@main/performance/heapWatchdog.js'
import { getPlatformKey, resolveBundledTool } from '@main/setup/runtimeTools.js'
import { initializeToolchain } from '@main/setup/toolchain.js'
import { CliUpdateOrchestrator } from '@main/setup/cliUpdateOrchestrator.js'
import { WorktreeActivityIndex } from '@main/worktreeActivity/WorktreeActivityIndex.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import { AgentManagementBridge } from '@main/agentManagement/AgentManagementBridge.js'
import { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import { RemoteController } from '@main/remote/RemoteController.js'
import { CaffeinateController } from '@main/caffeinate/CaffeinateController.js'
import { buildAppMenu } from '@main/menu/appMenu.js'
import { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { installProcessCrashHooks } from '@main/incident/installCrashHooks.js'
import { installWindowIncidentHooks } from '@main/incident/installWindowIncidentHooks.js'
import {
  classifyPreviousRun,
  PREVIOUS_RUN_CLASSIFIER_VERSION,
} from '@main/incident/previousRunClassifier.js'
import { getBuildInfo } from '@main/buildInfo.js'
import { createWorkflowService } from '@main/workflows/createWorkflowService.js'
import { WorkflowBridge } from '@main/workflows/WorkflowBridge.js'
import type { WorkflowService } from 'workflow-mcp'

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
// `src/renderer/src/session-runtime/ghosts.ts` for the renderer side.
const ghostJournals = new GhostJournalRegistry()
// Session recorder — one folder per recording under session-recordings/.
// Constructed and installed as the outbound-IPC observer whenever the
// dev-debug CAPABILITY is on (AGENT_CODE_DEV_DEBUG=1), so a normal build with
// dev-debug off pays nothing (no observer installed, sendToMainWindow's hook
// stays null). AGENT_CODE_SESSION_RECORD does NOT gate construction — it only
// flips autoRecord (below) so every session records from launch.
// plan: docs/rendering/session-recording-plan-2026-07.md (#467).
// Construct the recorder manager whenever the CAPABILITY is on (dev-debug),
// so the Start Recording command works. autoRecord (the env flag) stays OFF
// by default — nothing records until the command starts a session.
const sessionRecorders = isSessionRecordingEnabled()
  ? new SessionRecorderManager(
      undefined,
      undefined,
      isSessionRecordingAutoStart(),
      (sessionId, generation) =>
        // Push "recording started" to the renderer so the shape observer arms
        // the moment a recorder exists (PR #555). Polling from the renderer
        // provably loses the auto-record race: the recorder starts on a
        // session's FIRST event, which for an idle restored pane is whenever
        // the user first prompts it — unboundedly after Feed mount.
        sendToMainWindow('record-session:started', { sessionId, generation }),
      (sessionId, generation) =>
        // Natural exit keeps the recorder writable until the renderer has
        // flushed its coalesced shape evidence (or the manager's grace timer
        // expires). The opaque generation is load-bearing: sessionId is reusable,
        // so an acknowledgement without it cannot prove which recorder should
        // close. This channel is deliberately outside recorded session data.
        sendToMainWindow('record-session:stopping', { sessionId, generation }),
    )
  : null
if (sessionRecorders) setOutboundObserver(sessionRecorders.observe)
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
// Registry mutations can originate from renderer IPC or any built-in MCP
// session. Forward one source-of-truth event so an already-open curated editor
// does not require a manual close/reopen to see agent attachments or clears.
aiWorkspaceRegistry.on('changed', event => sendToMainWindow('ai-workspace:changed', event))
const caffeinateController = new CaffeinateController()

// SessionManager is constructed inside whenReady so we can await
// TmuxRegistry.detectAvailability() first — terminal sessions need
// to know during spawn whether a tmux backend is available, and
// detection requires a child-process roundtrip. The 'let' is
// load-bearing: every other module-scope reference is inside
// callbacks that fire after the assignment.
let manager: SessionManager | null = null
let remoteController: RemoteController | null = null
let tmuxRegistry: TmuxRegistry | null = null
let stateProcessLock: Extract<StateProcessLock, { acquired: true }> | null = null
let appRunJournal: AppRunJournal | null = null
let workflowService: WorkflowService | null = null
let workflowBridge: WorkflowBridge | null = null
let codexCliUpdateReserved = false
let workflowShutdownPromise: Promise<void> | null = null
let workflowShutdownComplete = false
let sessionForwarder: SessionForwarderControl | null = null

// A packaged release needs one executable-level smoke test that stops before
// touching the user's real workspace, process lock, provider CLIs, or network.
// Merely inspecting app.asar cannot prove Electron can load the main bundle and
// node-pty on the target architecture. CI launches the finished .app with this
// private flag; reaching this point already proves all top-level native imports
// loaded, then these resource probes prove the renderer/phone/runtime payloads
// survived packaging. Normal users never see or depend on this path.
const packagingSmoke = process.argv.includes('--packaging-smoke')

async function runPackagingSmoke(): Promise<void> {
  const required = [
    join(app.getAppPath(), 'out', 'preload', 'index.mjs'),
    join(app.getAppPath(), 'out', 'renderer', 'index.html'),
    join(app.getAppPath(), 'out', 'remote-client', 'index.html'),
    join(app.getAppPath(), 'out', 'main', 'runtime', 'tmux', 'manifest.json'),
    join(app.getAppPath(), 'out', 'main', 'runtime', 'mitmproxy', 'manifest.json'),
    join(app.getAppPath(), 'out', 'main', 'runtime', 'cloudflared', 'manifest.json'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (!app.isPackaged || missing.length > 0) {
    console.error('[packaging-smoke] failed', { isPackaged: app.isPackaged, missing })
    app.exit(1)
    return
  }
  console.log('[packaging-smoke] OK', process.arch, app.getVersion())
  app.exit(0)
}

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
const hasSingleInstanceLock = packagingSmoke || app.requestSingleInstanceLock()

if (packagingSmoke) {
  void app.whenReady().then(runPackagingSmoke).catch(err => {
    console.error('[packaging-smoke] startup failed', err)
    app.exit(1)
  })
} else if (!hasSingleInstanceLock) {
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
  // #495 A10: acquiring the state lock is the FIRST write into STATE_DIR
  // (~/.config/agent-code). On a Mac where that directory is unwritable —
  // wrong ownership after a migration/restore, a read-only or full volume,
  // an MDM-managed home — mkdir/open throws EACCES/EROFS/EPERM and, without
  // this guard, the app died with a raw unhandled-rejection crash while the
  // *already-running* case right below gets a friendly dialog. Mirror that
  // dialog for the permission family — plus ENOSPC/EDQUOT (codex follow-up
  // on #507: the dialog copy literally tells the user to check disk space,
  // so a full disk or blown quota has to reach that copy instead of the raw
  // crash it got before) — so the very first launch on a hostile account
  // explains itself instead of looking like a broken install. Anything
  // outside that errno family still rethrows: crashing loudly on unknown
  // corruption is deliberate (see the fatal-startup handler above, which
  // journals it as an incident).
  let lock: StateProcessLock
  try {
    lock = await acquireStateProcessLock()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (
      code === 'EACCES' ||
      code === 'EROFS' ||
      code === 'EPERM' ||
      code === 'ENOSPC' ||
      code === 'EDQUOT'
    ) {
      dialog.showErrorBox(
        'Agent Code cannot write its state directory',
        `Agent Code needs to write to ${STATE_DIR} but the operating system refused (${code}). ` +
          'Check that the directory is owned by your user, the disk is not full or read-only, ' +
          'and no security policy blocks writes there, then relaunch.',
      )
      // app.exit(1), not app.quit(): quit runs will-quit handlers that touch
      // the same unwritable state (clean-shutdown marker, lock release) and
      // would just cascade more EACCES noise. There is nothing to clean up —
      // we never acquired anything.
      app.exit(1)
      return
    }
    throw err
  }
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
    // Build provenance (#374): git SHA / branch / dirty / timestamp / mode /
    // package version, injected at bundle time (electron.vite.config.ts) and
    // read through the typed accessor. Threaded here — the app's composition
    // point — so the journal itself stays free of build-global knowledge.
    build: getBuildInfo(),
    // Version of the prior-run classifier COMPILED INTO this build, recorded
    // in the run manifest so triage knows which decision procedure will judge
    // this run's death on the next launch.
    classifierVersion: PREVIOUS_RUN_CLASSIFIER_VERSION,
    perfEnabled: performanceService.getConfig().enabled,
    lock,
  })
  // Wire the retention journal sink BEFORE start(): start() itself fires the
  // run's FIRST prune (scheduleDebugStoragePrune('incident-run-start') at the
  // end of AppRunJournal.start), and the prune's completion handler reads the
  // module-level sink. With the sink set after `await appRunJournal.start()`,
  // journaling that first prune was only race-free by ACCIDENT — the prune's
  // internal statfs() I/O happened to resolve later than the synchronous
  // continuation that set the sink, and any future `await` inserted between
  // start() and the wiring would have silently dropped the first prune's
  // journal entry. Setting the sink first makes the ordering structural
  // instead of incidental. Safe to do pre-start: setDebugRetentionJournal
  // just stores the reference, and AppRunJournal.record() no-ops until
  // started. See #388 — the July 2026 crash forensics lost the retention
  // breadcrumb entirely because pruning was console-only.
  setDebugRetentionJournal(appRunJournal)
  // Teach retention which session-recording folders are still being written.
  // Without this, debugRetention ages a recording by its folder mtime, and a
  // live-but-idle recording (session went quiet) can fall past ACTIVE_GRACE_MS
  // and get rm -rf'd out from under the open recorder. The manager derives the
  // set from its in-memory recorders map — the authoritative liveness signal.
  // Only wired when the recorder manager exists (dev-debug capability on);
  // otherwise the provider stays null and retention treats every recording
  // folder as prunable, which is correct because none can be live.
  if (sessionRecorders) setLiveRecordingDirsProvider(() => sessionRecorders.liveRecordingDirs())
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
    const priorRun = classifyPreviousRun(appRunJournal.appRunId, {
      // So a native crash (V8 OOM abort / SIGSEGV) that left only a Crashpad
      // minidump — no JS incident — is classified as a crash, not a force-quit.
      crashDumpsDir: app.getPath('crashDumps'),
    })
    if (priorRun && priorRun.classification !== 'clean') {
      const crashLike =
        priorRun.classification === 'main_crash_suspected' ||
        priorRun.classification === 'renderer_crash_suspected' ||
        // V8 OOM aborts and other fatal errors are crashes: the process was
        // killed by V8 before JS could react. Route them through the same
        // error-severity branch as JS crashes so triage tools don't have to
        // special-case a third bucket. Prior-run detection lives in
        // previousRunClassifier.findNodeDiagnosticReport (issue #388).
        priorRun.classification === 'main_oom_suspected'
      appRunJournal.recordIncident({
        kind: 'app.prior_unclean_shutdown',
        severity: crashLike ? 'error' : 'warn',
        reason: priorRun.classification,
        context: {
          priorRunId: priorRun.priorRunId,
          priorRunDir: priorRun.priorRunDir,
          // Which classifier version + feature flags produced THIS verdict
          // (#374 asked for both). The report carries them (rather than us
          // importing the constants here) so the context can never claim a
          // decision procedure other than the code path that actually ran.
          // The flags are static today, but recording them from day one means
          // the moment any behavior becomes toggleable, old and new incidents
          // stay comparable without archaeology.
          classifierVersion: priorRun.classifierVersion,
          classifierFlags: priorRun.classifierFlags,
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
  appRunJournal.record({ area: 'workflows.service', name: 'workflow_service.start' })
  try {
    workflowService = await createWorkflowService({
      isCodexCliUpdateReserved: () => codexCliUpdateReserved,
    })
    workflowBridge = new WorkflowBridge(workflowService)
    // Recovery successors may be created during service.initialize(), before the bridge exists.
    // Await rehydration so the first renderer query sees the durable lineage owner instead of a
    // stale parent with a misleading Resume action.
    await workflowBridge.start()
    appRunJournal.record({ area: 'workflows.service', name: 'workflow_service.ready' })
  } catch (err) {
    // Workflow persistence is part of the execution contract, not a cosmetic
    // renderer enhancement. Starting the MCP host without its durable service
    // would advertise a toggle that either loses runs or fails every tool call;
    // fail startup explicitly so the incident journal records the real cause.
    appRunJournal.recordError('workflow_service.error', err)
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
  const agentCodeConventionsService = new AgentCodeConventionsService()
  await agentCodeConventionsService.initialize()
  manager = new SessionManager(
    tmuxAvailable ? tmuxRegistry : null,
    builtInMcpHost,
    appRunJournal,
    async () => { await agentCodeConventionsService.audit() },
  )
  // Project ownership lives in renderer state, while backend/transcript facts
  // live in SessionManager. Construct this bridge only after both the MCP host
  // and manager exist so tool calls cannot observe a half-wired authority.
  const agentManagementBridge = new AgentManagementBridge(manager, appRunJournal)
  // Remote mobile companion — constructed here (the isolation boundary's ONE
  // construction hole; see docs/superpowers/specs/2026-07-06-remote-mobile-
  // companion-design.md) but OFF until the user enables it from the Remote
  // panel: construction allocates no sockets, no manager subscriptions, no
  // secret I/O. The phone bundle comes from `npm run client:build`
  // (out/remote-client, sibling of electron-vite's out/main). The path is
  // passed UNCONDITIONALLY — RemoteServer existence-checks it per request —
  // so building the bundle after launch takes effect on the next page load
  // instead of requiring an app restart (an existsSync gate here was the
  // first thing real-world testing tripped on).
  remoteController = new RemoteController({
    manager,
    journal: appRunJournal,
    clientDistDir: join(app.getAppPath(), 'out', 'remote-client'),
    // Tunnel binary resolution — bundled artifact first (packaged app),
    // then the third_party dev cache (populated by `npm run
    // runtime:fetch:cloudflared`; copy-packaged-resources only runs on
    // build, so dev mode never has out/main/runtime). NO PATH fallback,
    // same policy as tmux: a drifting system cloudflared would bypass the
    // manifest's hash pinning. LAN mode never calls this.
    resolveTunnelBinary: async () => {
      const bundled = await resolveBundledTool('cloudflared')
      if (bundled) return bundled
      const platformKey = getPlatformKey()
      if (!platformKey) return null
      const devCache = join(
        app.getAppPath(), 'third_party', 'cloudflared', 'cache', platformKey, 'cloudflared',
      )
      return existsSync(devCache) ? devCache : null
    },
  })
  const activeWorkflowService = workflowService
  const activeWorkflowBridge = workflowBridge
  if (!activeWorkflowService || !activeWorkflowBridge) {
    // This should be unreachable because workflow initialization is awaited
    // above. Keep the assertion at the composition boundary so a future
    // optional/lazy startup refactor cannot accidentally register half a
    // workflow surface (MCP without IPC, or IPC without a durable owner).
    throw new Error('Workflow service was not initialized before app composition')
  }
  builtInMcpHost.setDependencies({
    orchestrationBridge,
    agentManagementBridge,
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
    workflowService: activeWorkflowService,
    workflowBridge: activeWorkflowBridge,
  })
  performanceService.mark('app.main.sessionManager.created')

  sessionForwarder = wireSessionForwarder(manager, lspManager)
  // CLI auto-updater — constructed AFTER SessionManager because it uses
  // the manager to decide whether an active session of the target kind
  // is currently running (updating a binary while a session holds a
  // handle to it is safe on POSIX and hostile on Windows). The
  // orchestrator's boot probe fires shortly after registration below,
  // and it never blocks the main-window creation because the check is
  // scheduled via setTimeout inside scheduleBootProbe(). The initial
  // behavior is loaded from setup.json before IPC registers so the
  // renderer's first `cli-updates:get` sees the user's preference,
  // not the placeholder default.
  const cliUpdateOrchestrator = new CliUpdateOrchestrator(manager, {
    hasActiveWorkflow: cli => cli === 'codex' && activeWorkflowService.hasActiveRuns(),
    acquireUpdateLease: cli => {
      if (cli !== 'codex') return () => undefined
      if (codexCliUpdateReserved || activeWorkflowService.hasActiveRuns()) return null
      codexCliUpdateReserved = true
      return () => { codexCliUpdateReserved = false }
    },
  })
  await cliUpdateOrchestrator.loadInitialBehavior()
  registerAllIpc({
    manager,
    remoteController,
    lspManager,
    ghostJournals,
    dictationDebugJournals,
    pasteDebugJournals,
    sessionRecorders,
    worktreeActivityIndex,
    orchestrationBridge,
    agentManagementBridge,
    aiWorkspaceRegistry,
    caffeinateController,
    appRunJournal,
    cliUpdateOrchestrator,
    workflowBridge: activeWorkflowBridge,
    agentCodeConventionsService,
  })
  // Boot probe runs after the IPC is wired so its first `state` push
  // has a live subscriber to receive it on the renderer side.
  cliUpdateOrchestrator.scheduleBootProbe()
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

app.on('before-quit', (event) => {
  // WHY Electron quit is gated on WorkflowService.stop(): the durable service
  // promises that every published event was appended first, but cancellation
  // and the terminal/interrupted marker still require asynchronous file I/O.
  // A fire-and-forget stop here would let Electron tear main down between
  // those writes, leaving a healthy user-initiated quit indistinguishable from
  // a crash. Prevent exactly the first quit, drain once, then re-enter quit
  // with the completion flag set so the ordinary lifecycle can finish.
  if (workflowService && !workflowShutdownComplete) {
    event.preventDefault()
    if (!workflowShutdownPromise) {
      workflowShutdownPromise = workflowService
        .stop('Agent Code is quitting')
        .catch(err => {
          // An unconfirmed provider may still own descendants. Treating this as a warning and
          // immediately calling app.quit() defeats Workflow MCP's fail-closed ownership fence.
          // Keep Electron alive, retain the bridge for diagnostics, and let a later quit retry once
          // the provider settles (or let the user make an explicit OS-level force-quit decision).
          console.error('[workflows] graceful shutdown blocked:', err)
          appRunJournal?.recordError('workflow_service.stop.error', err)
          workflowShutdownPromise = null
          void dialog.showMessageBox({
            type: 'error',
            title: 'Agent work is still shutting down',
            message: 'Agent Code could not safely quit yet.',
            detail: err instanceof Error ? err.message : String(err),
            buttons: ['Keep Agent Code Open'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          throw err
        })
        .then(() => {
          workflowBridge?.dispose()
          workflowShutdownComplete = true
          workflowBridge = null
          workflowService = null
          app.quit()
        })
        .catch(() => undefined)
    }
    return
  }
  appRunJournal?.record({ area: 'app.lifecycle', name: 'app.before_quit' })
  performanceService.mark('app.main.beforeQuit')
  // WHY coalescers drain on the initial quit attempt: their buffers are cheap
  // and safe to flush even when a renderer veto keeps the app alive. Terminal
  // SessionManager teardown is deliberately deferred to will-quit below,
  // because unlike a coalescer flush it cannot be rolled back after Keep Editing.
  sessionForwarder?.flush()
  void builtInMcpHost.stop()
  void remoteController?.dispose()
  void lspManager.dispose()
  caffeinateController.dispose()
  cleanupDictationIpcResources()
  stopMainHeapWatchdog()
  // Flush pending ghost writes. Fire-and-forget is fine — Electron's
  // quit path gives us a tick before teardown. 100 ms queue depth is
  // worst-case; in practice drains are empty at quit time because
  // streaming is idle.
  void ghostJournals.flushAll()
  // Same one-tick-before-teardown rationale as ghostJournals; recordings are
  // usually mid-stream at quit, so this drain matters more than the ghost one.
  void sessionRecorders?.flushAll()
  // Same rationale as ghostJournals — Electron gives us one tick before
  // teardown. 100 ms queue depth is the worst case; in practice the
  // dictation journal is idle at quit unless the user is pressing Fn
  // at the exact moment of app shutdown.
  void dictationDebugJournals.flushAll()
  // Dictation HISTORY is a separate store from the debug journal above, and its
  // flush is load-bearing rather than best-effort: `appendEntry` is called
  // without await from the stream-stop handler (so a disk write never delays
  // the transcript reaching the composer), which means a dictation finished
  // seconds before quit can still be in flight right now. Without this the row
  // is simply lost, with no error anywhere. See historyStore.ts.
  void flushHistoryWrites()
  void pasteDebugJournals.flushAll()
  performanceService.stop()
})

installSessionShutdownGate({
  app,
  getManager: () => manager,
  platform: process.platform,
  onLastWindowClosed: () => {
    // WHY these provider-neutral resources still stop at last-window close on
    // non-macOS: this preserves the established cleanup timing while the
    // shutdown gate remains the exclusive owner of session/provider teardown.
    // The built-in MCP host intentionally remains app-owned until before-quit.
    void remoteController?.dispose()
    void lspManager.dispose()
    caffeinateController.dispose()
  },
  onQuitAllowed: () => {
    appRunJournal?.record({ area: 'app.lifecycle', name: 'app.will_quit' })
    appRunJournal?.markCleanShutdown('will-quit')
    appRunJournal?.stop()
    stateProcessLock?.releaseSync()
    stateProcessLock = null
  },
  onShutdownError: error => {
    // WHY a rejected terminal drain blocks quit: SessionManager owns exact
    // transcript leases and in-flight recovery claims. Exiting while their
    // teardown is uncertain recreates the cross-process ownership ambiguity
    // this PR is designed to eliminate. A later explicit quit retries.
    console.error('[sessions] graceful shutdown blocked:', error)
    appRunJournal?.recordError('session_manager.kill_all.error', error)
  },
})
