// Side-effect import — MUST be first so `.env` is loaded into
// `process.env` before PerformanceService (and anything else that
// reads env flags at module load) is imported. See
// `./loadEnv.ts` for the rationale.
import '@main/loadEnv.js'
import { mainOperations } from '@main/performance/operations.js'
import { monitorCoordinator } from '@main/performance/MonitorCoordinator.js'
import { mainProbe } from '@main/performance/MainProbe.js'
import { performanceTraceController } from '@main/performance/PerformanceTraceController.js'
import { TldrStore } from '@main/tldr/TldrStore.js'
import { registerGoalIpc, registerTldrIpc } from '@main/tldr/ipc.js'
import { BrowserPocketController, type GuestLike } from '@main/browserPocket/controller/BrowserPocketController.js'
import { LanePortWatcher } from '@main/browserPocket/LanePortWatcher.js'
import { PORT_SCAN_SUPPORTED, listListeners, listProcesses, probe as probePort } from '@main/browserPocket/lanePortsIo.js'
import { registerBrowserPocketIpc } from '@main/ipc/browserPocket.js'
import type { LanePort } from '@shared/browserPocket/types.js'
import { TldrEnforcement } from '@main/tldr/enforcement.js'
import { GoalLoopStore } from '@main/goalLoop/GoalLoopStore.js'
import { GoalLoopService } from '@main/goalLoop/GoalLoopService.js'
import { registerGoalLoopIpc } from '@main/goalLoop/ipc.js'
import { sweepStaleTldrHookFiles } from '@providers/shared/runtime/tldrHooks.js'
import { ExternalControlMcpHost } from './externalControlMcp/host'
import { registerOperatorControlTools } from './externalControlMcp/tools'
import { createExternalControlSettings } from './settings/externalControl'
import { createExternalCodexIntegration } from './settings/externalCodexIntegration'
import operatorSkillSource from '../../operator-skills/agent-code-computer-execution/SKILL.md?raw'

import { app, BrowserWindow, clipboard, crashReporter, dialog, Menu, Notification, powerMonitor, systemPreferences } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { performance } from 'perf_hooks'

import { SessionManager } from '@main/sessionManager.js'
import { SystemSuspensionTracker } from '@main/systemSuspension/SystemSuspensionTracker.js'
import { readDarwinLastWakeAt } from '@main/systemSuspension/darwinWakeTime.js'
import { AgentActivityRecorder } from '@main/agentActivity/AgentActivityRecorder.js'
import { AgentActivityStore } from '@main/agentActivity/AgentActivityStore.js'
import { AGENT_ACTIVITY_DIR } from '@main/storage/paths.js'
import { createControlHost } from '@main/control/createControlHost.js'
import { sessionHistoryControlCapabilities } from '@main/sessions/control.js'
import { nativeHistoryControlCapabilities } from '@main/sessions/nativeHistoryControl.js'
import { workflowControlCapabilities } from '@main/workflows/control.js'
import { usageControlCapabilities } from '@main/usage/control.js'
import { applicationIdentityCapabilities } from '@main/window/identityControl.js'
import { conditionBackendCapabilities } from '@main/sessions/conditionControl.js'
import { terminalBackendCapabilities } from '@main/sessions/terminalControl.js'
import { windowLifecycleControlCapabilities } from '@main/window/lifecycleControl.js'
import { installApplicationShutdown } from '@main/applicationShutdown.js'
import { presentQuitFailure } from '@main/quitFailureDialog.js'
import { LspManager } from '@main/lspManager.js'
import { removeLegacyGhostLogs } from '@main/storage/legacyGhostLogs.js'
import {
  DictationDebugJournalRegistry,
  pruneOldDictationDebugLogs,
} from '@main/dictationJournal.js'
import {
  PasteDebugJournalRegistry,
  pruneOldPasteDebugLogs,
} from '@main/pasteDebugJournal.js'
import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { reconcileWorkspace } from '@main/tmux/tmuxRecovery.js'
import { startDetachedTerminalSweep } from '@main/tmux/detachedSweep.js'
import type { DetachedSweepSchedule } from '@main/tmux/detachedSweep.js'

import {
  handleExtensionScheme,
  registerExtensionScheme,
} from '@main/extensions/scheme.js'
import { ExtensionRuntimeService } from '@main/extensions/runtimeService.js'
import { ExtensionCapabilityService } from '@main/extensions/capabilityService.js'
import { createExtensionSecretStore } from '@main/extensions/secrets.js'
import { registerExtensionRuntimeIpc } from '@main/extensions/runtimeIpc.js'
import { ExtensionServiceHost } from '@main/extensions/serviceHost.js'
import { autoUpdater } from 'electron-updater'
import { clearServiceTransport, configureServiceTransport } from '@main/extensions/serviceTransport.js'
import { registerExtensionInputIpc } from '@main/extensions/nativeInput.js'
import { sweepAbandonedInstallDirectories } from '@main/extensions/install.js'
import { STATE_DIR, STATE_FILE, TLDR_HOOK_RUNTIME_DIR } from '@main/storage/paths.js'
import {
  scheduleDebugStoragePrune,
  setDebugRetentionJournal,
  setLiveRecordingDirsProvider,
} from '@main/storage/debugRetention.js'
import { cleanupClaudeImageCacheDir } from '@main/storage/claudeImageCache.js'
import {
  installMitmproxyExitSweep,
  reapOwnedMitmproxyProcesses,
  reapStaleMitmproxyProcesses,
} from '@main/proxy/mitmproxyReaper.js'
import { acquireStateProcessLock } from '@main/storage/processLock.js'
import type { StateProcessLock } from '@main/storage/processLock.js'
import {
  broadcastToWindows,
  createAppWindow,
  focusedWindowId,
  getBrowserWindow,
  listWindowIds,
  windowIdFor,
  focusWindow,
  sendToFocusedWindow,
  windowForSession,
  sendToWindow,
  sessionsOwnedBy,
  setGeometryObserver,
  setWindowCreationAdmission,
  setWindowCloseVetoedObserver,
  setWindowClosedObserver,
  transferSessions,
  windowCount,
} from '@main/window/windowRegistry.js'
import { abandonPendingBequest, recordPendingBequest } from '@main/ipc/window.js'
import { wireSessionForwarder } from '@main/sessions/forwarder.js'
import type { SessionForwarderControl } from '@main/sessions/forwarder.js'
import { SessionFeedTap } from '@main/sessions/sessionFeedTap.js'
import { SessionRecorderManager } from '@main/recording/SessionRecorderManager.js'
import { setOutboundObserver } from '@main/window/windowRegistry.js'
import { captureWindowGeometry, restorableBounds } from '@main/window/windowGeometry.js'
import { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import { ConversationLedger, readAgentNameAssignments } from '@main/conversations/ledger/ledger.js'
import { createConversationService } from '@main/conversations/service.js'
import { listWorktreesForCwd } from '@main/ipc/git.js'
import { AGENT_NAMES_FILE } from '@main/agentNames/ipc.js'
import { RemoteWorkspaceProjection } from '@main/remote/workspaceProjection.js'
import { getUsageSnapshot } from '@main/usage/usageService.js'
import { CONVERSATIONS_LEDGER_FILE } from '@main/storage/paths.js'
import { isSessionRecordingEnabled, isSessionRecordingAutoStart } from '@main/ipc/devDebug.js'
import { registerAllIpc } from '@main/ipc/index.js'
import { registerSessionRoutingIpc } from '@main/ipc/sessionRouting.js'
import { AgentCodeManagedSkillsService } from '@main/agentCodeConventions/AgentCodeManagedSkillsService.js'
import { collectExternalAgentSkills } from '@main/agentSkills/externalSkills.js'
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
import { createFileVaultStore } from '@main/keyVault/vaultStore.js'
import { createSafeStorageCodec } from '@main/keyVault/safeStorageCodec.js'
import { UserMcpService } from '@main/userMcp/service.js'
import { sweepStalePrivateMcpConfigs } from '@providers/shared/runtime/builtInMcpLaunch.js'
import { VaultService } from '@main/keyVault/VaultService.js'
import { buildAppMenu } from '@main/menu/appMenu.js'
import { UpdateService } from '@main/updates/UpdateService.js'
import { UpdateCheckStore } from '@main/updates/updateCheckStore.js'
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
import { WorkflowServiceError, type WorkflowService } from 'workflow-mcp'

// Main process — thin Electron host.
//
// Responsibilities kept here (anything that isn't a domain concern of
// its own lives in these few lines):
//   1. Construct the long-lived service singletons (LspManager) before
//      anything else needs them.
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
//   - Window creation: main/window/appWindow.ts
//   - Window registry + IPC routing: main/window/windowRegistry.ts
//   - Disk paths, image cache, feed-debug writer: main/storage/*
//   - History chunk loader + jsonl coalescer: main/sessions/*
//
// The tile tree itself lives in the renderer — main has no idea what
// a "tab" or a "split" is. It just manages PTYs and shuffles bytes.

const lspManager = new LspManager()
// Session recorder — one folder per recording under session-recordings/.
// Constructed and installed as the outbound-IPC observer whenever the
// dev-debug CAPABILITY is on (AGENT_CODE_DEV_DEBUG=1), so a normal build with
// dev-debug off pays nothing (no observer installed, the registry's hook
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
        sendToWindow(windowForSession(sessionId), 'record-session:started', { sessionId, generation }),
      (sessionId, generation) =>
        // Natural exit keeps the recorder writable until the renderer has
        // flushed its coalesced shape evidence (or the manager's grace timer
        // expires). The opaque generation is load-bearing: sessionId is reusable,
        // so an acknowledgement without it cannot prove which recorder should
        // close. These are recorder control edges, deliberately outside both
        // recorded data and the lossy observation queue. Replaying a delayed
        // start/stop command after its grace period would arm an obsolete
        // generation. Direct owner-targeted delivery retains that protocol.
        sendToWindow(windowForSession(sessionId), 'record-session:stopping', { sessionId, generation }),
    )
  : null
if (sessionRecorders) setOutboundObserver(sessionRecorders.observe)
// Per-dictation-session debug-dump registry: constructed before IPC handlers
// register, flushed after committed shutdown. See
// `src/main/dictationJournal.ts` for the on-disk shape and why it is its own
// writer rather than a shared one.
const dictationDebugJournals = new DictationDebugJournalRegistry()
// Per-paste debug-dump registry. Same lifecycle as dictationDebugJournals:
// constructed before IPC handlers register, flushed after committed shutdown,
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
// Broadcast: an AI Workspace is a machine-wide record, and any window may have
// its curated editor open on the workspace that just changed.
aiWorkspaceRegistry.on('changed', event => broadcastToWindows('ai-workspace:changed', event))
const caffeinateController = new CaffeinateController()

// API Key Vault (#831). promptTouchID presents Touch ID with the user's
// login password as fallback, which is the "mac password" gate. Unsigned
// dev builds may skip the biometric option but the password path still
// works; if neither is available the service fails closed on unlock.
// Constructed top-level (like caffeinate) because it owns no window and
// no async boot step — only the per-run unlock boolean.
const vaultService = new VaultService({
  store: createFileVaultStore(join(STATE_DIR, 'key-vault'), createSafeStorageCodec()),
  promptAuth: async reason => {
    // WHY the platform check lives HERE and not in ensureUnlocked: the service
    // deliberately attempts the prompt rather than pre-gating on
    // canPromptAuth, because that flag once reported biometric capability only
    // and pre-gating locked out every password-only Mac from the login-password
    // path this feature promises. That reasoning is right for capability. It is
    // NOT right for a platform that has no promptTouchID at all: there,
    // "attempt it" meant calling undefined, and the user got a raw
    // "systemPreferences.promptTouchID is not a function" TypeError instead of
    // the honest platform message. Fails closed either way; only the wording
    // was broken.
    if (process.platform !== 'darwin' || typeof systemPreferences.promptTouchID !== 'function') {
      throw new Error('The API key vault needs macOS Touch ID or login-password authentication, which this platform does not provide.')
    }
    await systemPreferences.promptTouchID(reason)
  },
  // canPromptTouchID checks biometrics, not user-presence/password auth.
  // Electron 43's promptTouchID uses SecAccessControlUserPresence; attempt
  // that supported macOS API and let rejection keep the vault locked.
  canPromptAuth: () => process.platform === 'darwin' && typeof systemPreferences.promptTouchID === 'function',
  copyToClipboard: text => clipboard.writeText(text),
})

// SessionManager is constructed inside whenReady so we can await
// TmuxRegistry.detectAvailability() first — terminal sessions need
// to know during spawn whether a tmux backend is available, and
// detection requires a child-process roundtrip. The 'let' is
// load-bearing: every other module-scope reference is inside
// callbacks that fire after the assignment.
let manager: SessionManager | null = null
let remoteController: RemoteController | null = null
let remoteWorkspaceProjection: RemoteWorkspaceProjection | null = null
let tmuxRegistry: TmuxRegistry | null = null
// The running-app tmux reaper's timer handle, so quit can stop it (#1030).
let detachedTmuxSweep: DetachedSweepSchedule | null = null
let stateProcessLock: Extract<StateProcessLock, { acquired: true }> | null = null
let appRunJournal: AppRunJournal | null = null
let workflowService: WorkflowService | null = null
let workflowBridge: WorkflowBridge | null = null
let codexCliUpdateReserved = false
// Keep partially initialized owners visible until committed shutdown joins
// startup. A missing SessionManager does not mean no service acquired resources.
let startupTask: Promise<void> | null = null
let startupFailed = false
let disposeExternalControl: (() => Promise<void>) | null = null
// Returns a PROMISE since #943: control shutdown awaits admitted operations
// and the history append tail.
//
// The annotation is honest documentation, NOT a safety mechanism. An earlier
// comment here claimed a `() => void` would make the shutdown stage resolve
// immediately — review showed that is false twice over: types are erased, and
// `applicationShutdown.run` does `Promise.resolve(action()).then(...)`, which
// adopts the returned promise whatever its declared type. What the annotation
// actually buys is catching a future `disposeControl: () => { dispose() }`
// that drops the promise on the floor at the CALL SITE.
let disposeControlHost: (() => Promise<void>) | null = null
let shutdownWorkspaceStore: WorkspaceFileStore | null = null

class StartupInterruptedByQuit extends Error {}
function assertStartupOpen(): void {
  if (sessionShutdownGate.isTerminalShutdownAdmitted()) {
    throw new StartupInterruptedByQuit('Startup interrupted by committed quit')
  }
}
// Workflow shutdown is a committed-quit stage in applicationShutdown.ts, so
// main's former workflowShutdownPromise/Complete flags are gone with the
// before-quit handler that used them (#945).
let extensionRuntime: ExtensionRuntimeService | null = null
let extensionCapabilities: ExtensionCapabilityService | null = null
let extensionServiceHost: ExtensionServiceHost | null = null
let unregisterExtensionRuntime: (() => void) | null = null
let unregisterExtensionInput: (() => void) | null = null
let extensionQuitReady = false
let extensionQuitPending: Promise<void> | null = null
let sessionForwarder: SessionForwarderControl | null = null
// The one main-side session feed tap (#1177): ordering, coalescing and the
// sub-agent watcher, shared by the desktop forwarder and the remote sink.
let sessionFeedTap: SessionFeedTap | null = null

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
// MUST run at module scope, before any app.whenReady() handler. Electron silently
// treats a scheme registered after ready as opaque — no origin semantics, no secure
// context, no CORS — and the failure then surfaces in the renderer as a CSP or CORS
// error, which sends you looking at index.html instead of at call ordering. There is
// no runtime warning for getting this wrong. Verified working from a file:// document
// (the production origin) by the B1 spike: dynamic import, relative specifiers, and
// path-traversal rejection all behave.
registerExtensionScheme()
// WHY quit has to be distinguishable from an ordinary window close: closing one
// window hands its workspace to a survivor, but quitting closes every window
// and must NOT collapse them all into whichever one dies last.
//
// WHY this is NOT cleared on window focus, which was the first attempt:
// Electron has no "quit cancelled" event, and focus looked like a proxy for
// "the app is still alive". It is wrong in both directions. During a real quit,
// destroying the first window promotes the next one to key and fires
// `browser-window-focus` — clearing the flag mid-quit and letting the remaining
// windows collapse into one, which is data loss. And the unsaved-changes sheet
// is a window-modal sheet, so a vetoed quit never fires focus at all and the
// flag stays latched forever, silently disabling the handoff.
//
// The flag is instead cleared by the path that actually KNOWS the quit
// was vetoed: the sheet's "Keep Editing" branch (via the close-vetoed observer,
// wired in startApp). A committed drain failure must not resume window handoff.
let quitting = false
app.on('before-quit', () => { quitting = true })

// Self-update (issue #1120). Everything safety-critical lives in
// UpdateService; this wiring only supplies the real transport, the OS
// notification surface, the persisted check clock, and the two shutdown
// hooks: the gate swaps its final quit for quitAndInstall, and the
// Keep-Editing veto resets the intent so a retry still works.
const updateChecks = new UpdateCheckStore()
const updateService = new UpdateService({
  updater: autoUpdater,
  app: { isPackaged: app.isPackaged, version: app.getVersion() },
  requestQuit: () => { app.quit() },
  notify: message => {
    try {
      if (Notification.isSupported()) new Notification({ title: 'Agent Code', body: message }).show()
    } catch { /* a notification failure must never break the update flow */ }
  },
  // A sheet on the focused window (a free-floating box when none has focus),
  // so the answer to a menu check shows even with notifications turned off
  // for Agent Code (#1130). Like notify, a failure here must never break the
  // update flow; it reads as "not confirmed", which never restarts anything.
  showMessage: async (message, confirmLabel) => {
    const options = {
      type: 'info' as const,
      message,
      buttons: confirmLabel ? [confirmLabel, 'Later'] : ['OK'],
      // With a confirm button, Later is both the default (Enter) and the
      // cancel (Esc): a stray keypress must not start a restart in an app
      // full of live sessions. The user has to choose Restart on purpose.
      defaultId: confirmLabel ? 1 : 0,
      cancelId: confirmLabel ? 1 : 0,
      noLink: true,
    }
    try {
      const parent = BrowserWindow.getFocusedWindow()
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
      return confirmLabel !== undefined && response === 0
    } catch {
      return false
    }
  },
  readLastCheck: () => updateChecks.read(),
  // A failed clock write (full disk, read-only state) must never become an
  // unhandledRejection incident report; the cost is one extra check later.
  writeLastCheck: at => { void updateChecks.write(at).catch(() => {}) },
  readChannel: () => updateChecks.readChannel(),
  // Same rule as the clock: a failed write must not become an incident. The
  // in-memory choice still applies for this session.
  writeChannel: channel => { void updateChecks.writeChannel(channel).catch(() => {}) },
  now: () => Date.now(),
  log: line => { console.log(`[updates] ${line}`) },
})

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
    // Focus the last window the user was in rather than an arbitrary one:
    // relaunching the app is a request to get back to where you were.
    focusWindow(null)
  })

  void app.whenReady().then(() => {
    // A quit before readiness must not acquire a fresh resource after the exit
    // drain captured an empty inventory. There is no startup task to join yet.
    if (sessionShutdownGate.isTerminalShutdownAdmitted()) return
    startupTask = startApp().catch(err => {
      if (err instanceof StartupInterruptedByQuit) {
        appRunJournal?.record({ area: 'app.lifecycle', name: 'app.startup_interrupted_by_quit' })
        return
      }
      startupFailed = true
      console.error('[app] fatal startup error — draining owned resources before quitting:', err)
      appRunJournal?.recordIncident({
        kind: 'app.startup_failed', severity: 'fatal', process: 'main', error: err,
      })
      // Keep the journal and process lock until partial-startup resources drain.
      // Releasing the lock here would permit a second main to start while this
      // failed initializer still owned providers or asynchronous state writes.
      // The final callback deliberately leaves failed boot without a clean mark.
      app.quit()
    })
    return startupTask
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
      lock.reason === 'unreadable-lock'
        // The path, because this one the user has to act on: a lock file that
        // cannot be read does not age out, and nothing here can safely remove
        // it (#1094 review). Without the path in the dialog it was a permanent
        // failure whose only clue was a console warning nobody sees.
        ? `Agent Code cannot read its lock file, so it cannot tell whether another copy is running.\n\nCheck or remove:\n${lock.path}`
        : 'Another Agent Code process appears to own the shared app state. Close the existing app window before starting a second copy.',
    )
    app.quit()
    return
  }
  // A second look before this process writes anything (#1094).
  //
  // Acquisition cannot promise a single winner in every ordering: two launches
  // that condemn the same stale lock both replace it, and each can read back
  // its own token if it reads before the other's rename lands. The file
  // settles on one of them a moment later. This is the moment to notice — the
  // cost of being wrong here is two mains writing one state directory, and the
  // cost of the check is one file read.
  if (!lock.revalidate()) {
    console.warn('[app] lost the shared-state lock immediately after acquiring it', { lockPath: lock.path })
    dialog.showErrorBox(
      'Agent Code is already running',
      'Another Agent Code process took ownership of the shared app state while this one was starting. Close the existing app window before starting a second copy.',
    )
    app.quit()
    return
  }
  stateProcessLock = lock
  assertStartupOpen()
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
  assertStartupOpen()
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

  // mitmproxy process hygiene (#767): per-session mitmdump children are
  // spawned undetached by claude-code-headless and survive every death of
  // this process that skips will-quit (Force Quit, native crash, the
  // process.exit(1) in installProcessCrashHooks above). Two layers here:
  //
  //   - The exit sweep SIGKILLs our own marked children synchronously on
  //     Node's 'exit' event, which the crash hooks' process.exit(1) does reach.
  //   - The startup reaper kills marked mitmdumps whose owner is dead —
  //     leftovers from a previous run that died without ANY handler running.
  //     It is placed here, after the state lock, because the ppid reasoning
  //     in selectStaleMitmproxyProcesses relies on this process being the
  //     only live Agent Code main for this state directory.
  //
  // Fire-and-forget: a slow `ps` or a wedged orphan must not delay boot,
  // and the report is journaled whenever it lands. Recorded even at zero so
  // every run carries a baseline row — "no orphans" is a fact worth having
  // in the timeline when the next leak hunt starts.
  installMitmproxyExitSweep()
  void reapStaleMitmproxyProcesses()
    .then(report => {
      appRunJournal?.record({
        area: 'proxy',
        name: 'proxy.mitmdump.stale_reaped',
        severity: report.survived > 0 ? 'warn' : 'info',
        data: { ...report },
      })
      performanceService.record({
        kind: 'metric',
        process: 'main',
        area: 'proxy',
        name: 'proxy.mitmdump.stale_reaped',
        metricType: 'counter',
        value: report.reaped,
        count: report.stale,
        data: {
          scanned: report.scanned,
          survived: report.survived,
          keptOwnedBySelf: report.keptOwnedBySelf,
          keptLiveForeignOwner: report.keptLiveForeignOwner,
        },
      })
    })
    .catch(err => {
      appRunJournal?.recordError('proxy.mitmdump.stale_reap.error', err)
    })
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

  // Install the agent-code-ext:// handler before any window exists. The renderer
  // imports extension modules over this scheme during startup, so a window that
  // opened first could race a request against an unregistered handler and see a
  // spurious load failure that never reproduces on a warm run.
  handleExtensionScheme()
  // The resolver closes over the late-created SessionManager rather than a
  // focused renderer. Startup extensions may run with zero views, but every file
  // target still has to name a live main-owned session and therefore a real cwd.
  // Services are real child processes, not renderer lifetimes: the quit veto
  // exists for sandboxed runtimes (their deactivate may still want one storage
  // write). A native process is killed outright at the committed stage below;
  // holding quit hostage to a third-party process is exactly backwards.
  extensionServiceHost = new ExtensionServiceHost()
  extensionCapabilities = new ExtensionCapabilityService({
    resolveSessionRoot: sessionId => manager?.getSpawnCwd(sessionId) ?? null,
    // Background runtimes have no view-owned toast callback. Deliver through
    // the registered window fan-out so one timer event appears in every live
    // application window and never leaks into hidden extension BrowserWindows.
    notify: (extensionId, message) => {
      broadcastToWindows('extensions:notification', { extensionId, message })
    },
    services: extensionServiceHost,
    // api.secrets rides the same safeStorage codec as the Key Vault: one OS
    // keychain item for the app, one encrypted blob per extension secret.
    secrets: createExtensionSecretStore(createSafeStorageCodec()),
  })
  // The scheme handler is registered on every extension session long before
  // this composition runs; the proxy module is its late-bound lookup. Wiring
  // here (not in scheme.ts) keeps the handler testable with no main singleton.
  configureServiceTransport({
    hasCapability: (extensionId, revision, capability) => extensionCapabilities!.hasCapability(extensionId, revision, capability),
    serviceEndpoint: (extensionId, serviceId) => extensionServiceHost!.serviceEndpoint(extensionId, serviceId),
  })
  extensionRuntime = new ExtensionRuntimeService({
    preload: join(__dirname, '../preload/extensionRuntime.js'),
    capabilities: extensionCapabilities,
  })
  unregisterExtensionRuntime = registerExtensionRuntimeIpc(extensionRuntime, extensionCapabilities, contents => {
    const id = windowIdFor(contents)
    return !!id && getBrowserWindow(id)?.webContents === contents
  })
  unregisterExtensionInput = registerExtensionInputIpc(contents => {
    const id = windowIdFor(contents)
    return !!id && getBrowserWindow(id)?.webContents === contents
  })

  // Finish extension housekeeping before a window can install or load code.
  // This is serialized with publication too; fire-and-forget previously let a
  // slow startup sweep delete staging created by the first install dialog.
  // Failures preserve data and are reported; they need not block the whole app.
  await sweepAbandonedInstallDirectories().catch(err => {
    console.warn('[extensions] staging sweep failed:', err)
  })

  // Performance monitoring and extension startup are independent main-process
  // owners. Keep both before window creation: monitoring otherwise misses the
  // startup interval, while extension frames can race an unregistered scheme or
  // an unfinished install sweep if a window is allowed to open first.
  // #963: ONE owner of "the machine was not running". It is the only
  // powerMonitor subscriber; MainProbe keeps its Electron-only suspend/resume
  // evidence through the tracker's power-monitor events, and every working-time
  // consumer (turn clock, provider adapters, journal) reads the same intervals
  // instead of deriving sleep on its own. Started before any window or session
  // exists so a sleep during startup is not missed.
  const systemSuspension = new SystemSuspensionTracker({ power: powerMonitor, readLastWakeAt: readDarwinLastWakeAt })
  systemSuspension.on('suspend', () => mainProbe.noteSuspend())
  systemSuspension.on('resume', () => mainProbe.noteResume())
  systemSuspension.on('suspension', (suspension: import('@shared/types/systemSuspension.js').SystemSuspension) => {
    // Journaled so a debug bundle finally shows when the machine slept: before
    // this, no run journal on record contained a single power event.
    appRunJournal?.record({
      area: 'system.power',
      name: 'system.suspension',
      data: { ...suspension, durationMs: suspension.resumedAt - suspension.suspendedAt },
    })
  })
  systemSuspension.start()
  monitorCoordinator.start()
  // Remove capture scratch stranded by a crash or forced quit in an earlier
  // run. It is app-owned, so nothing else can depend on those partial files.
  void performanceTraceController.sweep().catch(() => {})
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
      // Automatic pressure capture is metadata-only: a synchronous heap dump
      // can double memory and freeze main precisely when it is near OOM.
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
  // The on-disk ghost log is gone; clear what older builds left behind
  // (see storage/legacyGhostLogs.ts for why the feature was removed).
  void removeLegacyGhostLogs(app.getPath('userData'))
  scheduleDebugStoragePrune('startup')
  appRunJournal.record({ area: 'setup.toolchain', name: 'toolchain.start' })
  try {
    await initializeToolchain()
    assertStartupOpen()
    appRunJournal.record({ area: 'setup.toolchain', name: 'toolchain.end' })
  } catch (err) {
    appRunJournal.recordError('toolchain.error', err)
    throw err
  }
  appRunJournal.record({ area: 'workflows.service', name: 'workflow_service.start' })
  try {
    workflowService = await createWorkflowService({
      isCodexCliUpdateReserved: () => codexCliUpdateReserved,
      onCreated: service => { workflowService = service },
    })
    assertStartupOpen()
    workflowBridge = new WorkflowBridge(workflowService)
    // Recovery successors may be created during service.initialize(), before the bridge exists.
    // Await rehydration so the first renderer query sees the durable lineage owner instead of a
    // stale parent with a misleading Resume action.
    await workflowBridge.start()
    assertStartupOpen()
    appRunJournal.record({ area: 'workflows.service', name: 'workflow_service.ready' })
  } catch (err) {
    // WorkflowService.stop closes recovery admission inside initialize. That
    // typed closing outcome is our own committed quit, not a failed boot. Keep
    // real initialization/storage failures on the incident path below.
    if (sessionShutdownGate.isTerminalShutdownAdmitted()
      && err instanceof WorkflowServiceError
      && (err.code === 'service-stopping' || err.code === 'service-stopped')) {
      throw new StartupInterruptedByQuit('Workflow initialization interrupted by committed quit')
    }
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
  assertStartupOpen()
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
  assertStartupOpen()
  tmuxRegistry = new TmuxRegistry({ tmuxBinary: bundledTmux ?? undefined })
  const tmuxDetectStarted = performance.now()
  appRunJournal.record({
    area: 'app.tmux',
    name: 'tmux.detect.start',
    data: { bundled: bundledTmux !== null },
  })
  const tmuxAvailable = await tmuxRegistry.detectAvailability()
  assertStartupOpen()
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
      // Use restoration's canonical envelope decoder, including its evidence
      // of discarded windows. A successful partial restore cannot authorize
      // deleting a terminal whose only reference was in the discarded region.
      //
      // A quit committed while the file was being read must not authorize
      // killing tmux sessions (#945). Asserting inside the reader turns that
      // into reconcileWorkspace's read-failure path, which withholds cleanup;
      // the assertStartupOpen() after this block then aborts startup. The
      // journal records it as workspace_read_failed, which is the honest
      // reading: this run never got an inventory it could act on.
      const recoveryReport = await reconcileWorkspace(tmuxRegistry, async () => {
        const text = await readFile(STATE_FILE, 'utf8')
        assertStartupOpen()
        return text
      })
      const recoverySummary = {
        inventory: recoveryReport.inventory,
        inventoryIssues: recoveryReport.inventoryIssues,
        inventoryDigest: recoveryReport.inventoryDigest,
        recoverable: recoveryReport.recoverable.length,
        lost: recoveryReport.lost.length,
        orphans: recoveryReport.orphans.length,
        preserved: recoveryReport.preserved.length,
      }
      performanceService.mark('app.tmux.recovery.complete', recoverySummary)
      appRunJournal.record({
        area: 'app.tmux',
        name: 'tmux.recovery.end',
        data: recoverySummary,
      })
      console.log(
        `[tmux] recovery (${recoveryReport.inventory} inventory): ${recoveryReport.recoverable.length} recoverable, ${recoveryReport.lost.length} lost, ${recoveryReport.orphans.length} orphans cleaned, ${recoveryReport.preserved.length} unmatched preserved`,
      )
    } catch (err) {
      // Read/decode uncertainty is reported above with cleanup withheld.
      // Registry or cleanup failures remain failures; do not claim every
      // session was fresh or that all requested termination succeeded.
      console.warn('[tmux] recovery failed:', err)
      performanceService.error('app.tmux.recovery.error', err)
      appRunJournal?.recordError('tmux.recovery.error', err)
    }
  }

  assertStartupOpen()
  // Give the host its journal BEFORE start() so a bind failure can record its
  // mcp.host_start_failed incident — setDependencies() (which also carries the
  // journal) only runs AFTER start(), because it needs `manager`, so without this
  // the incident would be dead code.
  builtInMcpHost.setJournal(appRunJournal)
  appRunJournal.record({ area: 'mcp.host', name: 'mcp_host.start' })
  try {
    await builtInMcpHost.start()
    assertStartupOpen()
    appRunJournal.record({ area: 'mcp.host', name: 'mcp_host.end' })
  } catch (err) {
    appRunJournal.recordError('mcp_host.error', err)
    throw err
  }
  const agentCodeConventionsService = new AgentCodeManagedSkillsService()
  await agentCodeConventionsService.initialize()
  assertStartupOpen()
  // User MCP servers (#1143). Loaded before the manager so the first restored
  // agent already launches with them; initialize() never throws (a corrupt
  // document is moved aside and reported in Settings instead).
  const userMcpService = new UserMcpService({ stateDir: STATE_DIR, codec: createSafeStorageCodec() })
  await userMcpService.initialize()
  // Private MCP config files now carry user secrets; a crash must not leave
  // them in the temp dir. Before any agent can launch, so nothing live is hit.
  void sweepStalePrivateMcpConfigs().then(removed => {
    if (removed > 0) appRunJournal?.record({ area: 'mcp.user', name: 'private_config.swept', data: { removed } })
  })
  manager = new SessionManager(
    tmuxAvailable ? tmuxRegistry : null,
    builtInMcpHost,
    appRunJournal,
    // Reports failures instead of throwing them (#1133). SessionManager
    // decides what a failure means for the launch; see
    // runPreSpawnSkillReconcile for why that is never "abort".
    options => agentCodeConventionsService.prepareForAgentSpawn(options.builtInMcpDomains),
    (sessionId, sessionRunId, observation) => {
      sessionRecorders?.recordCodexTranscriptObservation(
        sessionId,
        sessionRunId,
        observation,
      )
    },
  )
  // #369: the Codex proxy adapters' retained state, in the 5 s heartbeat
  // next to RSS. A retention leak climbs here long before it OOMs main.
  performanceService.setGaugeSource('codex.proxy.flows', () => manager?.codexProxyDiagnostics().flows ?? null)
  performanceService.setGaugeSource('codex.proxy.bufferedChars', () => manager?.codexProxyDiagnostics().bufferedChars ?? null)
  manager.setUserMcpResolver(params => userMcpService.resolveForLaunch(params))
  // Adapters seal streams a sleep severed (#963); the manager fans each
  // suspension out to the live agent runtimes.
  systemSuspension.on('suspension', (suspension: import('@shared/types/systemSuspension.js').SystemSuspension) => {
    manager?.noteSystemSuspension(suspension)
  })

  // The running-app half of tmux cleanup (#1030 item 4). Startup reconciliation
  // above reaps what a previous run left behind; this reaps what THIS run
  // leaves behind, once the undo window that kept each shell alive has closed.
  // Armed only when tmux is available and only after the manager exists,
  // because the manager is one of the two authorities the sweep consults — the
  // other is the persisted workspace file, read through the same decoder
  // startup uses.
  if (tmuxAvailable && manager) {
    const sweepingManager = manager
    detachedTmuxSweep = startDetachedTerminalSweep({
      registry: tmuxRegistry,
      readWorkspace: () => readFile(STATE_FILE, 'utf8'),
      liveTmuxNames: () => sweepingManager.getLiveTmuxNames(),
      onSweep: report => {
        // Only worth a line when something actually happened; a five-minute
        // heartbeat saying "nothing" would bury the log.
        if (report.reaped.length === 0) return
        console.log(`[tmux] reaped ${report.reaped.length} detached terminal session(s)`)
        appRunJournal?.record({
          area: 'app.tmux',
          name: 'tmux.detached.reaped',
          data: { reaped: report.reaped.length, pending: report.pending.length },
        })
      },
      onError: error => {
        // Never fatal: a failed sweep is a leak that gets another chance in
        // five minutes, not a reason to stop cleaning for the rest of the run.
        performanceService.error('app.tmux.detachedSweep.error', error)
        appRunJournal?.recordError('tmux.detached_sweep.error', error)
      },
    })
    // Ownership published on the tick it becomes true. Every authority the
    // sweep reads is a snapshot taken before an await; this is the one signal
    // that cannot be stale, and it is what keeps an Undo Close restore from
    // being killed by a scan that started before it.
    const sweepAttachments = detachedTmuxSweep
    manager.onTmuxAttached(name => sweepAttachments.noteAttached(name))
  }
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
    // Resolved at enable time; the tap is built later in startup, at the
    // forwarder's wiring (see there). Enabling needs a user action on a
    // window, which cannot happen before that point.
    getFeedTap: () => {
      if (!sessionFeedTap) throw new Error('session feed tap is not wired yet')
      return sessionFeedTap
    },
    journal: appRunJournal,
    // v2 identity projection: one read model over the persisted workspace
    // (titles, spoken names, tabs, pins) for the remote server's session
    // summaries. Handed over as a GETTER because the store opens later in
    // startup than this construction (same pattern as getThemeSettings);
    // the projection itself observes the store, so remote disabled costs
    // it nothing and enable picks up whatever has opened by then.
    getWorkspace: () => remoteWorkspaceProjection,
    // TLDR/Goal note stores — constructed later in startup (shared with the
    // desktop's IPC surface); remote only reads and subscribes, the MCP
    // tools remain the only writers.
    getNotes: () => ({ tldr: tldrStore, goal: goalStore }),
    // v2 usage indicator on the phone: the shared service's cached snapshot
    // getter (a cache read per connected minute, never a fresh provider
    // call unless the TTL already expired).
    getUsageSnapshot: () =>
      getUsageSnapshot().then(snapshot => snapshot).catch(() => null),
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
  // WHY the control host is composed here, before the built-in MCP host learns
  // its dependencies: `setDependencies` is one-shot by design (it refuses to
  // run once a provider session has registered), and Root Agent Code
  // Management (#906) needs a per-session operator port from this host. It used
  // to be built after IPC registration; nothing in between depended on that
  // order, and the external server starting a moment earlier changes nothing.
  let externalHost: ExternalControlMcpHost
  const externalSettings = createExternalControlSettings(STATE_DIR, {
    integration: createExternalCodexIntegration(process.env.CODEX_HOME || join(app.getPath('home'), '.codex'), operatorSkillSource),
    start: (port, token) => externalHost.start(port, token),
    stop: () => externalHost.stop(), copy: text => clipboard.writeText(text),
  })
  const controlManager = manager
  const controlHost = createControlHost({ getBrowserWindow, windowIdFor, listWindowIds }, join(STATE_DIR, 'control-history'), ({ invokeTask }) => [
    ...workflowControlCapabilities(activeWorkflowService, invokeTask), ...usageControlCapabilities(), ...applicationIdentityCapabilities(), ...sessionHistoryControlCapabilities(), ...nativeHistoryControlCapabilities(() => conversationService), ...conditionBackendCapabilities(controlManager), ...terminalBackendCapabilities(controlManager), ...windowLifecycleControlCapabilities(), ...externalSettings.capabilities,
  ])
  externalHost = new ExternalControlMcpHost(controlHost.forCaller({ kind: 'external', id: 'agent-code-control' }))
  disposeExternalControl = () => externalSettings.dispose()
  disposeControlHost = () => controlHost.dispose({
    // An incomplete drain is not a clean exit, and it is the one thing a
    // restart needs to know when it finds an operation with no result.
    onIncompleteDrain: outstanding => appRunJournal?.recordIncident({
      kind: 'control.drain_incomplete',
      severity: 'error',
      reason: 'timeout',
      context: outstanding,
    }),
  })
  await externalSettings.initialize()
  assertStartupOpen()
  const tldrStore = new TldrStore(join(STATE_DIR, 'tldr.json'))
  const goalStore = new TldrStore(join(STATE_DIR, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
  const tldrEnforcement = new TldrEnforcement(tldrStore, undefined, goalStore)
  // Before any session can register: the sweep removes every entry, and each
  // one left by an earlier run holds a bearer that run's host already revoked.
  await sweepStaleTldrHookFiles(TLDR_HOOK_RUNTIME_DIR).catch(error => {
    console.warn('[tldr] stale hook file sweep failed:', error)
  })
  assertStartupOpen()
  registerTldrIpc(tldrStore, tldrEnforcement, appRunJournal)
  registerGoalIpc(goalStore)
  // Goal Loop (#1001): constructed before setDependencies for the same
  // one-shot reason as every other built-in dependency — the MCP handlers
  // close over the service object. start() itself warns-and-continues on
  // unreadable persisted state, matching the sweep pattern above.
  const goalLoopStore = new GoalLoopStore(join(STATE_DIR, 'goal-loop.json'))
  const goalLoopService = new GoalLoopService({ manager, store: goalLoopStore })
  await goalLoopService.start()
  registerGoalLoopIpc(goalLoopService)
  // Lane browser pocket (#1142). One controller for the app: it owns live CDP
  // sessions and per-pocket queues that must outlive the per-request MCP
  // server, exactly like workflowService below.
  const lanePortCache = new Map<string, LanePort[]>()
  // `manager` is assigned above but typed nullable (module-level let); after
  // shutdown starts it may be cleared, and a late scan must just see no pid.
  const pidOf = (sessionId: string): number | null => manager?.getProcessTelemetryTargets([sessionId])[0]?.pid ?? null
  const lanePortWatcher = new LanePortWatcher({
    listProcesses,
    // Linux/Windows output is unrecorded (decomposition U1): report nothing
    // rather than guess, so no chip ever points at the wrong lane.
    listListeners: pids => (PORT_SCAN_SUPPORTED ? listListeners(pids) : Promise.resolve([])),
    listTmuxPanes: () => (tmuxRegistry && tmuxAvailable ? tmuxRegistry.listPanePids() : Promise.resolve([])),
    agentPid: pidOf,
    terminalPid: pidOf,
    probe: probePort,
    broadcast: bySession => {
      lanePortCache.clear()
      for (const [id, ports] of Object.entries(bySession)) lanePortCache.set(id, ports)
      broadcastToWindows('browser-pocket:ports', { bySession })
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      // unref: a pending scan must never keep the app alive at quit.
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
  })
  const browserPockets = new BrowserPocketController({
    now: () => Date.now(),
    emitDriving: event => broadcastToWindows('browser-pocket:driving', event),
    emitPaint: (pocketId, on) => broadcastToWindows('browser-pocket:paint', { pocketId, on }),
    // The renderer owns SessionMeta; main can only ask. Every window gets it,
    // and only the window holding that session acts on it.
    requestOpen: (sessionId, url) => broadcastToWindows('browser-pocket:open-request', { sessionId, ...(url ? { url } : {}) }),
    requestViewport: (sessionId, viewport) => broadcastToWindows('browser-pocket:set-viewport', { sessionId, viewport }),
    setWatchedSessions: sessions => lanePortWatcher.setSessions(sessions),
    lanePorts: sessionId => lanePortCache.get(sessionId) ?? [],
  })
  registerBrowserPocketIpc({
    // Electron's WebContents satisfies GuestLike structurally except for the
    // overloaded EventEmitter signatures; the controller only uses the slice
    // GuestLike names.
    register: (pocketId, sessionId, guest) => browserPockets.register(pocketId, sessionId, guest as unknown as GuestLike),
    unregister: pocketId => browserPockets.unregister(pocketId),
    noteHumanInput: (pocketId, at) => browserPockets.noteHumanInput(pocketId, at),
    agentTyping: pocketId => browserPockets.agentTyping(pocketId),
    takeOver: pocketId => browserPockets.takeOver(pocketId),
    resume: pocketId => browserPockets.resume(pocketId),
    setFlags: flags => {
      browserPockets.setFlags(flags)
      if (!flags.enabled) lanePortWatcher.setSessions([])
    },
    thumbnail: pocketId => browserPockets.thumbnail(pocketId),
    pick: pocketId => browserPockets.pick(pocketId),
    cancelPick: pocketId => browserPockets.cancelPick(pocketId),
    applyEmulation: (pocketId, emulation) => browserPockets.applyEmulation(pocketId, emulation),
    setWatchedSessions: sessions => browserPockets.setWatchedSessions(browserPockets.isEnabled() ? sessions : []),
  })
  builtInMcpHost.setDependencies({
    browserPockets,
    tldrStore,
    goalStore,
    tldrEnforcement,
    goalLoopService,
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
      // The focused window: this is a request to SHOW something, so it belongs
      // where the user is looking, not in every workspace at once.
      sendToFocusedWindow('ai-workspace:open-request', { workspaceId })
    },
    sessionManager: manager,
    appRunJournal,
    // #1143: the mcp_servers domain edits the same document Settings → MCP
    // does, through the same service. Every agent-made change is broadcast so
    // the user always learns that their MCP configuration changed.
    userMcpService,
    onUserMcpChangedByAgent: event => {
      appRunJournal?.record({ area: 'mcp.user', name: 'user_mcp.agent_change', ids: { sessionId: event.sessionId }, data: { message: event.message } })
      broadcastToWindows('user-mcp:agent-change', { message: event.message })
    },
    // #1161: the skills domain proposes through the same managed-skills
    // service as Settings → Skills. Every agent-made change is announced, and
    // the broadcast also refreshes any open Skills page.
    managedSkills: agentCodeConventionsService,
    listExternalSkills: () => collectExternalAgentSkills(agentCodeConventionsService),
    onSkillsChangedByAgent: event => {
      appRunJournal?.record({ area: 'skills', name: 'skills.agent_change', ids: { sessionId: event.sessionId }, data: { message: event.message } })
      broadcastToWindows('managed-skills:agent-change', { message: event.message })
    },
    workflowService: activeWorkflowService,
    workflowBridge: activeWorkflowBridge,
    // Root Agent Code Management (#906): the SAME operator catalog the external
    // server projects, on the session's own built-in server, with the session
    // as the journaled caller. Only composition may touch the external MCP
    // adapter (import boundary), which is why this closure is built here.
    rootControlTools: (server, sessionId) => registerOperatorControlTools(
      server,
      controlHost.forCaller({ kind: 'agent', id: sessionId }),
      {
        onSchemaFallback: (capabilityId, error) => appRunJournal?.record({
          area: 'mcp.root_management',
          name: 'tool_schema.fallback',
          data: { sessionId, capabilityId, message: error instanceof Error ? error.message : String(error) },
        }),
      },
    ),
  })
  performanceService.mark('app.main.sessionManager.created')

  // Built HERE, at the forwarder's old spot, not beside `new SessionManager`:
  // the tap's manager listeners take the forwarder's former position in each
  // event's listener list, so every other main subscriber still runs before
  // or after it exactly as it did.
  const feedTap = new SessionFeedTap(manager)
  sessionFeedTap = feedTap
  sessionForwarder = wireSessionForwarder(manager, lspManager, feedTap)
  registerSessionRoutingIpc(manager, sessionForwarder)
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
  assertStartupOpen()
  // WHY the workspace file is read here, before any window exists: it now holds
  // the window list, so it is what decides how many windows to create. The old
  // renderer-driven `workspace:load` could not answer that — it required a
  // renderer, which requires a window.
  const workspaceFileStore = await WorkspaceFileStore.open()
  shutdownWorkspaceStore = workspaceFileStore
  assertStartupOpen()
  // Conversation ledger (docs/decomposition/conversations.md, Stage 3): a
  // projection of every window's sessions keyed by native id, so the picker
  // can name and classify conversations after their panes are gone. Boots
  // from the store's current document, then follows every commit.
  const conversationLedger = await ConversationLedger.open(CONVERSATIONS_LEDGER_FILE).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.warn('[conversations] ledger unavailable', error)
    return null
  })
  assertStartupOpen()
  if (conversationLedger) {
    const projectConversations = (windows: readonly PersistedWindow[]) => {
      void readAgentNameAssignments(AGENT_NAMES_FILE)
        .then(names => conversationLedger.projectWindows(windows, names))
        .catch(() => undefined)
    }
    workspaceFileStore.observe(projectConversations)
    projectConversations(workspaceFileStore.windows())
  }
  // Agent Analytics (#964): record when each agent works, per tab, repository
  // and agent. Wired here because it needs all three owners it joins — the
  // session manager's events, the persisted workspace (tabs, titles, names)
  // and the machine suspensions it must never count as work.
  const agentActivityRecorder = new AgentActivityRecorder({
    manager: manager!,
    store: new AgentActivityStore(AGENT_ACTIVITY_DIR),
    // The first worktree entry is the main checkout, so every worktree of one
    // repository folds into it (the conversations picker's family rule).
    resolveRepoRoot: cwd => listWorktreesForCwd(cwd).then(worktrees => worktrees[0]?.path ?? cwd),
  })
  const projectActivity = (windows: readonly PersistedWindow[]) => {
    void readAgentNameAssignments(AGENT_NAMES_FILE)
      .then(names => agentActivityRecorder.updateWorkspace(windows, names))
      .catch(() => undefined)
  }
  workspaceFileStore.observe(projectActivity)
  projectActivity(workspaceFileStore.windows())
  // v2 remote identity projection — constructed beside its only input, once
  // the store has opened. Observed forever (remote disabled costs nothing);
  // RemoteController reads it through getWorkspace at enable time.
  remoteWorkspaceProjection = new RemoteWorkspaceProjection(
    workspaceFileStore,
    () => readAgentNameAssignments(AGENT_NAMES_FILE),
  )
  systemSuspension.on('suspension', (suspension: import('@shared/types/systemSuspension.js').SystemSuspension) => {
    agentActivityRecorder.noteSuspension(suspension)
  })
  // Not awaited: recovering a crashed run's open intervals is file I/O, and window
  // restore must not wait on analytics. No turn can start before a window has
  // loaded and restored its sessions, so nothing is missed in the gap.
  void agentActivityRecorder.start().catch((error: unknown) => {
    // History is a convenience; failing to open it must never break startup.
    console.warn('[agent-activity] recorder failed to start', error)
  })
  // Dragging a window to the other monitor changes nothing the renderer knows
  // about, so it triggers no autosave. Without this, the feature's central
  // promise — it comes back where you left it — would depend on the user
  // touching a pane before quitting.
  // Closing a window is not destructive: its agents stay alive in
  // SessionManager and its workspace is handed to a surviving window, where
  // they appear in Dispatch under their own project tabs. See
  // renderer/workspace/adoptWorkspace.ts for why the SURVIVOR performs the
  // merge rather than main.
  // The only party that knows a ⌘Q was cancelled is the unsaved-changes sheet.
  setWindowCloseVetoedObserver(() => {
    quitting = false
    extensionQuitReady = false
    // Keep Editing also cancels a pending update restart: the staged update
    // stays on disk, only the intent resets (UpdateService.onQuitVetoed).
    updateService.onQuitVetoed()
    // Announce the resume so v2 views closed by the quit's pause re-attach
    // (viewBridge retries only views that failed meanwhile). Without it every
    // open extension view stayed on "failed to start" after Keep Editing.
    void extensionRuntime?.resume()
      .then(() => broadcastToWindows('extensions:runtime-resumed', null))
      .catch(error => console.error('[extensions] resume after cancelled quit failed:', error))
  })
  setWindowClosedObserver(closedWindowId => {
    // WHY quitting is excluded: on quit every window closes, and collapsing all
    // of them into whichever one happens to die last would destroy the
    // multi-window layout the user spent time arranging. Quit persists each
    // window separately and restores them all.
    if (quitting) return
    const survivor = focusedWindowId()
    // No survivor means this was the last window. Its slice stays on disk, so
    // the macOS `activate` path (or the next launch) restores it intact — which
    // is exactly the pre-multi-window behavior.
    if (!survivor) return

    // Ownership moves FIRST, synchronously, before anything is awaited. The
    // closed window's sessions are still producing events, and every tick they
    // spend owned by the absent window consumes the bounded handoff queue.
    // The explicit transfer authorizes the survivor to receive that queue;
    // ownership failure never grants a broadcast fallback.
    //
    // It is an OPTIMISTIC move, so it is recorded as a pending offer: if the
    // survivor refuses the merge, or the offer cannot be composed at all, the
    // routing is rolled back rather than left pinned to a window that will
    // never display those sessions.
    const bequeathedSessionIds = sessionsOwnedBy(closedWindowId)
    transferSessions(bequeathedSessionIds, survivor)
    recordPendingBequest(closedWindowId, survivor, bequeathedSessionIds)

    // WHY a turn of the event loop before reading the slice: the closing
    // renderer flushes its final autosave from `beforeunload`, and that IPC
    // message is already queued when `closed` fires. Reading in this tick could
    // compose the bequest from the previous save and lose the last 400ms.
    setImmediate(() => {
      void (async () => {
        const slice = await workspaceFileStore.loadSlice(closedWindowId)
        if (!slice) {
          // Nothing was ever persisted for this window, so there is nothing to
          // hand over and nothing to delete. Un-route its sessions so they do
          // not stay silently pinned to the survivor.
          abandonPendingBequest(closedWindowId)
          return
        }
        sendToWindow(survivor, 'workspace:adopt', {
          windowId: closedWindowId,
          workspace: slice,
        })
      })().catch(err => {
        // The slice is still on disk and the sessions are still alive; the
        // workspace comes back as its own window next launch. Nothing is lost,
        // so this is a warning rather than a user-facing failure.
        abandonPendingBequest(closedWindowId)
        console.warn('[window] workspace handoff failed:', err)
      })
    })
  })
  setGeometryObserver(windowId => {
    void workspaceFileStore
      .updateGeometry(windowId, captureWindowGeometry(windowId))
      .catch(err => {
        // Geometry is a convenience, not workspace data. A failed write must
        // not surface as an error dialog or retry storm; the next move tries
        // again on its own.
        console.warn('[window] geometry save failed:', err)
      })
  })
  // The conversation service reads the provider stores on demand and joins
  // the ledger, so it is constructed after the ledger. The control host above
  // was built before the workspace store opened and holds a getter for it;
  // its handlers only run on requests, long after this line.
  const conversationService = createConversationService({ ledger: conversationLedger, listWorktrees: listWorktreesForCwd })
  registerAllIpc({
    manager,
    sessionFeedTap: feedTap,
    userMcpService,
    updates: { updateService, updateChecks, app: { version: app.getVersion(), isPackaged: app.isPackaged } },
    remoteController,
    lspManager,
    dictationDebugJournals,
    pasteDebugJournals,
    sessionRecorders,
    worktreeActivityIndex,
    orchestrationBridge,
    agentManagementBridge,
    aiWorkspaceRegistry,
    caffeinateController,
    vaultService,
    appRunJournal,
    cliUpdateOrchestrator,
    workflowBridge: activeWorkflowBridge,
    agentCodeConventionsService,
    workspaceFileStore,
    conversationService,
    systemSuspension,
    agentActivityRecorder,
  })
  // Boot probe runs after the IPC is wired so its first `state` push
  // has a live subscriber to receive it on the renderer side.
  cliUpdateOrchestrator.scheduleBootProbe()
  performanceService.mark('app.main.ipc.registered')
  appRunJournal.record({ area: 'window.main', name: 'window.create.start' })
  // Restore every persisted window, or create one on a fresh install. A
  // window whose saved bounds no longer land on an attached display is created
  // with default placement instead — see windowGeometry.ts for why that is the
  // common case rather than an edge case.
  //
  // WHY this is a closure shared with the `activate` handler below rather than
  // two call sites: they answer the same question ("what windows should exist
  // when there are none?"), and the version that drifted first — activate
  // minting a fresh id — silently orphaned the persisted slice of the window
  // the user had just closed.
  const restorePersistedWindows = (): void => {
    const persistedWindows = workspaceFileStore.windows()
    if (persistedWindows.length === 0) {
      createAppWindow()
      return
    }
    for (const record of persistedWindows) {
      createAppWindow({
        windowId: record.windowId,
        bounds: restorableBounds(record.bounds),
        fullScreen: record.fullScreen,
      })
    }
  }
  restorePersistedWindows()
  if (workspaceFileStore.isReadOnly()) {
    // WHY a native dialog rather than a console warning: in this state the app
    // looks completely normal — a window opens, a default agent spawns — but
    // NOTHING the user does will ever be persisted, because every save is
    // refused to avoid overwriting a file we could not read. Working a full day
    // and losing it at quit is the worst outcome this feature can produce, and
    // it is not something a `console.warn` prevents.
    dialog.showMessageBox({
      type: 'warning',
      title: 'Workspace cannot be saved',
      message: 'Agent Code could not read its saved workspace, so changes will not be saved.',
      detail: `${workspaceFileStore.refusalReason() ?? 'Unknown error.'}\n\nYour existing workspace file has been left untouched. Agents you start now will run normally, but tabs, layout, and pins will not persist. Quit and repair or move ~/.config/agent-code/workspace.json to restore saving.`,
      buttons: ['Continue'],
      noLink: true,
    }).catch(() => {
      // A failed dialog must not take the app down; the console warning from
      // the store load is still on record.
    })
  }
  appRunJournal.record({
    area: 'window.main',
    name: 'window.create.end',
    data: { windowCount: windowCount() },
  })
  // Install the application menu right after the window exists — the File
  // items dispatch command ids to THIS window's renderer (issue #148).
  Menu.setApplicationMenu(buildAppMenu({
    // Dual duty (check, or restart into a ready update) lives in
    // UpdateService.menuCheck, which answers every outcome in a dialog. The
    // old inline version relied on OS notifications that only covered
    // ready/error, so most clicks produced nothing at all (#1130).
    onCheckForUpdates: () => { void updateService.menuCheck() },
  }))
  performanceService.mark('app.main.window.created')
  // Both belong at window creation. The startup timing is observed first so
  // `app.startup` keeps meaning "process start until the first window exists"
  // and never absorbs the synchronous prefix of extension activation.
  mainOperations.observe('app.startup', performance.now())
  void extensionRuntime?.activateStartupExtensions().catch(error => console.error('[extensions] startup catalog failed:', error))

  app.on('activate', () => {
    if (sessionShutdownGate.isTerminalShutdownAdmitted()) {
      // WHY activation is suppressed only after will-quit admission: the gate
      // has already made SessionManager terminal and is waiting to re-enter
      // quit. A new renderer could add a fresh beforeunload veto and leave a
      // visible window backed by a manager that can no longer recover or spawn.
      return
    }
    if (windowCount() !== 0) return
    // WHY the persisted restore and not a bare createAppWindow(): closing the
    // LAST window deliberately keeps its slice on disk so this path can bring it
    // back. Minting a fresh window id here would load nothing, hand the user an
    // empty workspace, and leave the real one orphaned in the file until the
    // next launch restored it as a surprise extra window.
    restorePersistedWindows()
  })
}

// The extension runtime's quit pause (#577) stays on before-quit, the one
// preparation step that must finish before windows unload: it closes v2
// extension views so their frames do not race the renderer teardown. It is
// REVERSIBLE, which is what #945's rule requires of anything on this side of
// the editor veto: Keep Editing resumes it (setWindowCloseVetoedObserver above).
// Its disposal is a committed-quit stage (`stopExtensions` below).
app.on('before-quit', (event) => {
  if (extensionRuntime && !extensionQuitReady) {
    event.preventDefault()
    if (!extensionQuitPending) {
      extensionQuitPending = extensionRuntime.pause().then(() => {
        extensionQuitReady = true
        extensionQuitPending = null
        app.quit()
      })
    }
  }
})

// One composition owns every committed-quit disposer. Electron's before-quit
// precedes renderer unload decisions, so only reversible preparation belongs
// there. In particular, Keep Editing must leave workflow/MCP/LSP/remote/voice
// services intact. The gate holds will-quit until this inventory has settled.
// Update cadence (consulted): first check at T+3min so it never competes with
// startup; every 4h; once more on wake. Timers are unref'd — the app must
// never be held alive by an update check. Dev builds short-circuit inside the
// service ('disabled'), so the timers exist but do nothing.
if (app.isPackaged) {
  const firstUpdateCheck = setTimeout(() => { void updateService.checkForUpdates() }, 3 * 60 * 1000)
  firstUpdateCheck.unref()
  const updateCheckInterval = setInterval(() => { void updateService.checkForUpdates() }, 4 * 60 * 60 * 1000)
  updateCheckInterval.unref()
  powerMonitor.on('resume', () => { void updateService.checkForUpdates() })
}

const sessionShutdownGate = installApplicationShutdown({
  update: { pending: () => updateService.pendingInstall(), install: () => updateService.installUpdate() },
  app,
  platform: process.platform,
  prepare: () => {
    appRunJournal?.record({ area: 'app.lifecycle', name: 'app.before_quit' })
    performanceService.mark('app.main.beforeQuit')
    sessionForwarder?.flush()
  },
  services: {
    getSessions: () => manager,
    getWorkflows: () => workflowService,
    startupSettled: () => startupTask ?? Promise.resolve(),
    stopDictation: cleanupDictationIpcResources,
    flushObservations: () => sessionForwarder?.flush(),
    sweepOwnedProxies: async () => {
      // Keep the existing best-effort backstop AFTER managed session teardown.
      // This is a kernel sweep of our marked children, not proof that an
      // uncertain provider stop succeeded; that stop already gates this stage.
      try {
        const report = await reapOwnedMitmproxyProcesses()
        if (report.owned > 0) appRunJournal?.record({
          area: 'proxy', name: 'proxy.mitmdump.quit_sweep', severity: 'warn', data: { ...report },
        })
      } catch (error) { appRunJournal?.recordError('proxy.mitmdump.quit_sweep.error', error) }
    },
    stopBuiltInMcp: () => builtInMcpHost.stop(),
    stopRemote: () => remoteController?.dispose(),
    stopLsp: () => lspManager.dispose(),
    stopExternalControl: () => disposeExternalControl?.(),
    disposeControl: () => disposeControlHost?.(),
    disposeWorkflowBridge: () => workflowBridge?.dispose(),
    disposeCaffeinate: () => caffeinateController.dispose(),
    stopHeapWatchdog: stopMainHeapWatchdog,
    stopDetachedTmuxSweep: () => { detachedTmuxSweep?.stop(); detachedTmuxSweep = null },
    drainWorkspace: () => shutdownWorkspaceStore?.drainAdmittedWrites(),
    drainDictationHistory: flushHistoryWrites,
    flushRecordings: () => sessionRecorders?.flushAll(),
    flushDictationDebug: () => dictationDebugJournals.flushAll(),
    flushPasteDebug: () => pasteDebugJournals.flushAll(),
    // Baseline samples are queued to an isolated utility process, so killing
    // it synchronously can lose its final seconds. Grant the history queue and
    // any explicitly started profiler a short, shared drain, then stop the
    // observers (#958). The deadline is deliberate: diagnostics must never make
    // the application impossible to quit when storage or tracing is unhealthy.
    stopPerformance: async () => {
      await Promise.race([
        Promise.allSettled([
          monitorCoordinator.shutdown(1800),
          performanceTraceController.shutdown(),
        ]).then(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, 2000)),
      ])
      monitorCoordinator.stop()
      performanceService.stop()
    },
    stopExtensions: async () => {
      await extensionRuntime?.dispose()
      unregisterExtensionRuntime?.()
      unregisterExtensionRuntime = null
      unregisterExtensionInput?.()
      unregisterExtensionInput = null
      extensionRuntime = null
      extensionCapabilities?.dispose()
      extensionCapabilities = null
      clearServiceTransport()
      extensionServiceHost?.dispose()
      extensionServiceHost = null
    },
  },
  onQuitAllowed: () => {
    appRunJournal?.record({ area: 'app.lifecycle', name: 'app.will_quit' })
    if (!startupFailed) appRunJournal?.markCleanShutdown('will-quit')
    appRunJournal?.stop()
    stateProcessLock?.releaseSync()
    stateProcessLock = null
  },
  onShutdownError: error => {
    console.error('[app] graceful shutdown blocked:', error)
    appRunJournal?.recordError('app.shutdown.error', error)
    if (!app.isReady()) return
    // Every window is gone by now, so this dialog is the only reachable
    // control the application still has; quitFailureDialog.ts owns what it
    // offers and acts on the answer (#945 Codex review).
    // A lambda, not `dialog` itself: Electron's showMessageBox is overloaded
    // (with and without a parent window), and this call has no window left.
    void presentQuitFailure({ showMessageBox: options => dialog.showMessageBox(options) }, app, error)
  },
  onDiagnosticError: (stage, error) => appRunJournal?.recordError(`app.shutdown.${stage}.error`, error),
})
// Cover menu, IPC, external control and restoration through their shared factory,
// not just the macOS activate callback. Failed committed shutdown is terminal;
// a fresh renderer's unload veto cannot make partially stopped services usable.
setWindowCreationAdmission(() => !sessionShutdownGate.isTerminalShutdownAdmitted())
