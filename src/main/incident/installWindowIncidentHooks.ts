import { app, ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { getOutboundIpcDiagnostics } from '@main/window/windowRegistry.js'
import type { RendererFreezeHeartbeat } from '@shared/incident/rendererFreeze.js'

const HEARTBEAT_STALL_MS = 4_000
const HEARTBEAT_REPEAT_LOG_MS = 30_000
const WATCHDOG_INTERVAL_MS = 1_000
const SYSTEM_SLEEP_GAP_MS = 5_000
const MAX_TERMINAL_DIAGNOSTIC_CHARS = 64 * 1024
const EXPENSIVE_FREEZE_DIAGNOSTICS_ENABLED =
  process.env.AGENT_CODE_FREEZE_DIAGNOSTICS === '1'

type RendererLiveness = {
  createdAt: number
  receivedAt: number | null
  lastHeartbeat: RendererFreezeHeartbeat | null
  stallStartedAt: number | null
  stallClassification: 'foreground' | 'background' | null
  lastTerminalLogAt: number | null
  lastSnapshotAt: number | null
  lastRecoveryLogAt: number | null
  lastIncidentAt: number | null
  expensiveCaptureInFlight: boolean
  lifecycle: WindowLifecycleBreadcrumb[]
}

type WindowLifecycleBreadcrumb = {
  at: number
  event: string
  focused: boolean
  visible: boolean
  minimized: boolean
  fullScreen: boolean
}

const WINDOW_LIFECYCLE_BREADCRUMB_LIMIT = 16

type FreezeReason =
  | 'electron-unresponsive'
  | 'foreground-heartbeat-stalled'
  | 'background-heartbeat-stalled'
  | 'responsive-again'

// Window / child-process incident hooks.
//
// WHY app-level + per-window-on-create instead of editing mainWindow.ts:
// these signals must be captured for EVERY window/webContents, including any
// future secondary windows, and main must report them on its own — the renderer
// can't report its own crash once it's gone (a core invariant of the plan).
// Attaching via the `browser-window-created` app event means we instrument
// windows uniformly without coupling the journal to the window-creation code.

export function installWindowIncidentHooks(journal: AppRunJournal): void {
  const windows = new Map<number, BrowserWindow>()
  const liveness = new Map<number, RendererLiveness>()
  const mainLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  mainLoopDelay.enable()
  let lastWatchdogAt = Date.now()
  let lastWatchdogFailureLogAt = 0

  // WHY main owns receipt timestamps: a renderer which is already wedged cannot reliably timestamp
  // when its IPC message was delivered. The payload tells us what the renderer observed on its last
  // successful turn; Date.now() here tells us exactly how long main has gone without hearing from it.
  ipcMain.on('incident:renderer-heartbeat', (event, value: unknown) => {
    const heartbeat = parseHeartbeat(value)
    if (!heartbeat) return
    const now = Date.now()
    const state = liveness.get(event.sender.id) ?? freshLiveness(now)
    const stalledForMs = state.stallStartedAt === null ? null : now - state.stallStartedAt
    state.receivedAt = now
    state.lastHeartbeat = heartbeat
    state.stallStartedAt = null
    state.stallClassification = null
    liveness.set(event.sender.id, state)
    if (
      stalledForMs !== null &&
      (state.lastRecoveryLogAt === null || now - state.lastRecoveryLogAt >= HEARTBEAT_REPEAT_LOG_MS)
    ) {
      state.lastRecoveryLogAt = now
      terminalFreezeLog('renderer heartbeat resumed', {
        recoveredAfterMs: stalledForMs,
        webContentsId: event.sender.id,
        lastHeartbeat: heartbeat,
      })
    }
  })

  const runWatchdog = (): void => {
    const now = Date.now()
    const watchdogGapMs = now - lastWatchdogAt
    lastWatchdogAt = now
    if (watchdogGapMs > SYSTEM_SLEEP_GAP_MS) {
      // Main's interval pauses during laptop sleep too. Treating that wall-clock jump as renderer
      // starvation would print a frightening false freeze immediately after wake. Reset receipt
      // time while preserving the renderer's last self-reported sample for the next real stall.
      for (const state of liveness.values()) state.receivedAt = now
      return
    }

    for (const [webContentsId, window] of windows) {
      if (window.isDestroyed()) continue
      const state = liveness.get(webContentsId) ?? freshLiveness(now)
      liveness.set(webContentsId, state)
      const lastReceipt = state.receivedAt ?? state.createdAt
      const heartbeatAgeMs = now - lastReceipt
      if (heartbeatAgeMs < HEARTBEAT_STALL_MS) continue
      if (state.stallStartedAt === null) state.stallStartedAt = lastReceipt
      const stallClassification = classifyStall(window, state)
      if (state.stallClassification !== stallClassification) {
        // WHY classification changes restart the log cadence: a hidden renderer being timer-
        // throttled is expected Electron behavior, but the same stale heartbeat after the user
        // foregrounds the window is strong evidence of the real UI freeze we are hunting. Without
        // this edge, the background log's five-second suppression could hide the most useful
        // foreground transition within the bounded snapshot cadence.
        state.stallClassification = stallClassification
        state.lastTerminalLogAt = null
      }
      if (
        state.lastTerminalLogAt !== null &&
        now - state.lastTerminalLogAt < HEARTBEAT_REPEAT_LOG_MS
      ) continue
      const firstLog = state.lastTerminalLogAt === null
      state.lastTerminalLogAt = now
      logFreezeSnapshot({
        window,
        state,
        reason: stallClassification === 'foreground'
          ? 'foreground-heartbeat-stalled'
          : 'background-heartbeat-stalled',
        frozenSince: state.stallStartedAt,
        mainLoopDelay,
        // This boolean expresses diagnostic value, not permission to run native tools. The
        // explicit AGENT_CODE_FREEZE_DIAGNOSTICS gate below is the production-safety boundary.
        includeProcessTree: firstLog && stallClassification === 'foreground',
      })
    }
    mainLoopDelay.reset()
  }
  const watchdog = setInterval(() => {
    // WHY the watchdog has a top-level failure boundary: this is an always-on
    // observer, not application logic. Electron metrics and native window
    // access can fail during teardown; allowing that exception to escape a
    // timer would turn a diagnostic edge case into the crash it is meant to
    // explain. The failure record is deliberately metadata-only and bounded.
    try {
      runWatchdog()
    } catch (error) {
      const now = Date.now()
      if (now - lastWatchdogFailureLogAt >= HEARTBEAT_REPEAT_LOG_MS) {
        lastWatchdogFailureLogAt = now
        terminalFreezeLog('watchdog sample failed', diagnosticFailureMetadata(error))
      }
    }
  }, WATCHDOG_INTERVAL_MS)
  watchdog.unref()
  app.once('will-quit', () => {
    clearInterval(watchdog)
    mainLoopDelay.disable()
  })

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
    let unresponsiveEvents = 0
    // WHY the ID is captured while WebContents is alive: Electron emits BrowserWindow `closed`
    // after destroying its WebContents wrapper. Reading `window.webContents.id` from that callback
    // throws "Object has been destroyed" and turns a normal force-quit after a freeze into a second,
    // misleading main-process crash incident. The numeric ID is the stable lifecycle key.
    const webContentsId = window.webContents.id
    windows.set(webContentsId, window)
    const initialLiveness = freshLiveness(Date.now())
    recordWindowLifecycle(initialLiveness, window, 'created')
    liveness.set(webContentsId, initialLiveness)
    window.once('closed', () => {
      windows.delete(webContentsId)
      liveness.delete(webContentsId)
    })

    // WHY these breadcrumbs live in main rather than relying on renderer visibilitychange: the
    // failure under investigation is specifically a renderer which stops being scheduled. Main's
    // native BrowserWindow events continue firing in that state and let the freeze snapshot prove
    // whether occlusion, fullscreen Spaces, minimization, or focus churn happened immediately
    // before the last JavaScript heartbeat. The ring is deliberately tiny and metadata-only.
    const captureLifecycle = (eventName: string): void => {
      const state = liveness.get(webContentsId)
      if (state) recordWindowLifecycle(state, window, eventName)
    }
    // Electron models BrowserWindow events as individual overloads; keeping the registrations
    // explicit preserves that compile-time contract instead of erasing it with an EventEmitter cast.
    window.on('show', () => captureLifecycle('show'))
    window.on('hide', () => captureLifecycle('hide'))
    window.on('focus', () => captureLifecycle('focus'))
    window.on('blur', () => captureLifecycle('blur'))
    window.on('minimize', () => captureLifecycle('minimize'))
    window.on('restore', () => captureLifecycle('restore'))
    window.on('enter-full-screen', () => captureLifecycle('enter-full-screen'))
    window.on('leave-full-screen', () => captureLifecycle('leave-full-screen'))

    window.on('unresponsive', () => {
      // Electron can emit unresponsive repeatedly for one uninterrupted freeze. Preserve the FIRST
      // timestamp; resetting it here made recovered durations look like a few seconds even when the
      // user had stared at a dead window for minutes.
      if (unresponsiveSince === null) unresponsiveSince = Date.now()
      unresponsiveEvents += 1
      const state = liveness.get(window.webContents.id) ?? freshLiveness(Date.now())
      logFreezeSnapshot({
        window,
        state,
        reason: 'electron-unresponsive',
        frozenSince: unresponsiveSince,
        mainLoopDelay,
        includeProcessTree: unresponsiveEvents === 1,
      })
      if (admitIncidentRecord(state)) {
        journal.recordIncident({
          kind: 'window.unresponsive',
          severity: 'error',
          process: 'renderer',
          context: {
            windowId: window.id,
            rendererPid: safeRendererPid(window.webContents),
            heartbeatAgeMs: heartbeatAge(state),
            unresponsiveEvents,
          },
        })
      }
    })

    window.on('responsive', () => {
      const frozenMs = unresponsiveSince === null ? undefined : Date.now() - unresponsiveSince
      const state = liveness.get(window.webContents.id) ?? freshLiveness(Date.now())
      logFreezeSnapshot({
        window,
        state,
        reason: 'responsive-again',
        frozenSince: unresponsiveSince,
        mainLoopDelay,
        includeProcessTree: false,
      })
      unresponsiveSince = null
      unresponsiveEvents = 0
      if (admitIncidentRecord(state)) {
        journal.recordIncident({
          kind: 'window.responsive',
          severity: 'warn',
          process: 'renderer',
          context: { windowId: window.id, frozenMs },
        })
      }
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

function freshLiveness(now: number): RendererLiveness {
  return {
    createdAt: now,
    receivedAt: null,
    lastHeartbeat: null,
    stallStartedAt: null,
    stallClassification: null,
    lastTerminalLogAt: null,
    lastSnapshotAt: null,
    lastRecoveryLogAt: null,
    lastIncidentAt: null,
    expensiveCaptureInFlight: false,
    lifecycle: [],
  }
}

function recordWindowLifecycle(
  state: RendererLiveness,
  window: BrowserWindow,
  event: string,
): void {
  if (window.isDestroyed()) return
  state.lifecycle.push({
    at: Date.now(),
    event,
    focused: window.isFocused(),
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    fullScreen: window.isFullScreen(),
  })
  if (state.lifecycle.length > WINDOW_LIFECYCLE_BREADCRUMB_LIMIT) {
    state.lifecycle.splice(0, state.lifecycle.length - WINDOW_LIFECYCLE_BREADCRUMB_LIMIT)
  }
}

function heartbeatAge(state: RendererLiveness): number | null {
  return state.receivedAt === null ? null : Math.max(0, Date.now() - state.receivedAt)
}

function parseHeartbeat(value: unknown): RendererFreezeHeartbeat | null {
  if (!isObject(value) || !isObject(value.longTasks)) return null
  const visibilityState = value.visibilityState
  if (
    !finite(value.sentAt) ||
    !finite(value.monotonicMs) ||
    !finite(value.eventLoopLagMs) ||
    (visibilityState !== 'visible' && visibilityState !== 'hidden' && visibilityState !== 'prerender') ||
    !finite(value.longTasks.count) ||
    !finite(value.longTasks.totalMs) ||
    !finite(value.longTasks.maxMs)
  ) return null
  const heap = isObject(value.heap) && finite(value.heap.usedBytes) &&
    finite(value.heap.totalBytes) && finite(value.heap.limitBytes)
    ? {
        usedBytes: value.heap.usedBytes,
        totalBytes: value.heap.totalBytes,
        limitBytes: value.heap.limitBytes,
      }
    : undefined
  const dom = isObject(value.dom) && finite(value.dom.nodes) &&
    finite(value.dom.preElements) && finite(value.dom.codeElements) &&
    finite(value.dom.workflowActivities)
    ? {
        nodes: value.dom.nodes,
        preElements: value.dom.preElements,
        codeElements: value.dom.codeElements,
        workflowActivities: value.dom.workflowActivities,
      }
    : undefined
  return {
    sentAt: value.sentAt,
    monotonicMs: value.monotonicMs,
    eventLoopLagMs: value.eventLoopLagMs,
    visibilityState,
    longTasks: {
      count: value.longTasks.count,
      totalMs: value.longTasks.totalMs,
      maxMs: value.longTasks.maxMs,
    },
    ...(heap === undefined ? {} : { heap }),
    ...(dom === undefined ? {} : { dom }),
  }
}

function logFreezeSnapshot(input: {
  window: BrowserWindow
  state: RendererLiveness
  reason: FreezeReason
  frozenSince: number | null
  mainLoopDelay: ReturnType<typeof monitorEventLoopDelay>
  includeProcessTree: boolean
}): void {
  const now = Date.now()
  // WHY the rate limit is enforced here as well as in the heartbeat
  // watchdog: Electron may emit repeated `unresponsive` events during the
  // same freeze. Those events bypass the watchdog cadence. One complete
  // metadata snapshot every thirty seconds preserves trend evidence without
  // flooding a terminal or making stderr backpressure part of the incident.
  if (
    input.state.lastSnapshotAt !== null &&
    now - input.state.lastSnapshotAt < HEARTBEAT_REPEAT_LOG_MS
  ) return
  input.state.lastSnapshotAt = now

  try {
    const mainMemory = process.memoryUsage()
    terminalFreezeLog('renderer freeze snapshot', {
      at: new Date(now).toISOString(),
      reason: input.reason,
      windowId: input.window.id,
      webContentsId: input.window.webContents.id,
      rendererPid: safeRendererPid(input.window.webContents),
      focused: input.window.isFocused(),
      visible: input.window.isVisible(),
      minimized: input.window.isMinimized(),
      fullScreen: input.window.isFullScreen(),
      backgroundThrottling: input.window.webContents.getBackgroundThrottling(),
      windowLifecycle: input.state.lifecycle.map(item => ({ ...item })),
      frozenForMs: input.frozenSince === null ? null : now - input.frozenSince,
      heartbeatAgeMs: input.state.receivedAt === null ? null : now - input.state.receivedAt,
      lastHeartbeat: input.state.lastHeartbeat,
      main: {
        pid: process.pid,
        rssBytes: mainMemory.rss,
        heapUsedBytes: mainMemory.heapUsed,
        externalBytes: mainMemory.external,
        cpu: process.getCPUUsage(),
        eventLoop: {
          meanMs: roundNs(input.mainLoopDelay.mean),
          maxMs: roundNs(input.mainLoopDelay.max),
          p99Ms: roundNs(input.mainLoopDelay.percentile(99)),
        },
      },
      outboundIpc: getOutboundIpcDiagnostics(),
      electronProcesses: app.getAppMetrics().map(metric => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name,
        serviceName: metric.serviceName,
        cpuPercent: Math.round(metric.cpu.percentCPUUsage * 100) / 100,
        idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
        workingSetKb: metric.memory.workingSetSize,
        peakWorkingSetKb: metric.memory.peakWorkingSetSize,
        privateBytes: metric.memory.privateBytes,
      })),
    })
  } catch (error) {
    terminalFreezeLog('renderer freeze snapshot failed', diagnosticFailureMetadata(error))
  }

  if (
    input.includeProcessTree &&
    EXPENSIVE_FREEZE_DIAGNOSTICS_ENABLED &&
    !input.state.expensiveCaptureInFlight
  ) {
    input.state.expensiveCaptureInFlight = true
    const rendererPid = safeRendererPid(input.window.webContents)
    // WHY the native collectors require an explicit environment opt-in:
    // pidtree/pidusage launch subprocesses and macOS `sample` stops and
    // inspects the renderer. They are valuable during a supervised repro, but
    // they are too invasive for an always-on production watchdog. Dynamic
    // imports also keep their startup/module cost out of normal runs.
    void captureExpensiveDiagnostics(rendererPid).finally(() => {
      input.state.expensiveCaptureInFlight = false
    })
  }
}

function classifyStall(window: BrowserWindow, state: RendererLiveness): 'foreground' | 'background' {
  // WHY the renderer's Page Visibility report wins over BrowserWindow visibility: on macOS an
  // occluded window can remain `isVisible() === true` while Chromium marks the document hidden and
  // throttles it. Conversely an unfocused window can still be fully visible next to the terminal,
  // so focus loss alone must not downgrade a genuine freeze to harmless background suspension.
  if (state.lastHeartbeat?.visibilityState === 'hidden') return 'background'
  if (!window.isVisible() || window.isMinimized()) return 'background'
  return 'foreground'
}

async function captureDescendantProcesses(): Promise<Record<string, unknown>> {
  const [{ default: pidtree }, { default: pidusage }] = await Promise.all([
    import('pidtree'),
    import('pidusage'),
  ])
  const pids = await withTimeout(pidtree(process.pid, { root: true }), 5_000)
  const stats = await withTimeout(pidusage(pids), 5_000)
  const processes = Object.values(stats)
    .sort((left, right) => (right.cpu - left.cpu) || (right.memory - left.memory))
    .slice(0, 30)
    .map(entry => ({
      pid: entry.pid,
      ppid: entry.ppid,
      cpuPercent: Math.round(entry.cpu * 100) / 100,
      rssBytes: entry.memory,
      elapsedMs: entry.elapsed,
      cpuTimeMs: entry.ctime,
    }))
  return {
    capturedAt: new Date().toISOString(),
    descendantCount: pids.length,
    topProcesses: processes,
  }
}

async function captureExpensiveDiagnostics(rendererPid: number | null): Promise<void> {
  // WHY one coordinator owns both collectors: without a shared in-flight guard, repeated Electron
  // lifecycle signals could overlap pid walks and OS samples even though terminal lines were rate-
  // limited. Each branch catches locally and the outer caller uses finally, so diagnostics cannot
  // retain the guard or reject into an Electron callback.
  const captures: Promise<void>[] = [
    captureDescendantProcesses().then(
      processes => terminalFreezeLog('descendant process snapshot', processes),
      error => terminalFreezeLog('descendant process snapshot failed', diagnosticFailureMetadata(error)),
    ),
  ]
  if (rendererPid !== null && process.platform === 'darwin') {
    captures.push(captureRendererStackSample(rendererPid).then(
      sample => terminalFreezeLog('renderer stack sample', sample),
      error => terminalFreezeLog('renderer stack sample failed', {
        rendererPid,
        ...diagnosticFailureMetadata(error),
      }),
    ))
  }
  await Promise.allSettled(captures)
}

async function captureRendererStackSample(rendererPid: number): Promise<Record<string, unknown>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/sample',
      [String(rendererPid), '1', '10', '-mayDie'],
      { timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          // The caller records only the error class/code. Do not propagate
          // stderr text into the terminal because native diagnostics are not a
          // content-redaction boundary.
          reject(Object.assign(new Error('renderer sample failed'), {
            name: error.name,
            code: 'code' in error ? error.code : undefined,
            stderrBytes: Buffer.byteLength(stderr, 'utf8'),
          }))
          return
        }
        resolve(stdout)
      },
    )
  })
  const lines = output.split(/\r?\n/)
  const mainThreadIndex = lines.findIndex(line => (
    line.includes('CrRendererMain') ||
    line.includes('com.apple.main-thread') ||
    line.includes('Main Thread')
  ))
  const callGraphIndex = lines.findIndex(line => line.trim() === 'Call graph:')
  const start = mainThreadIndex >= 0
    ? mainThreadIndex
    : callGraphIndex >= 0
      ? callGraphIndex
      : 0
  const stack = lines
    .slice(start, start + 90)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)

  return {
    capturedAt: new Date().toISOString(),
    rendererPid,
    sourceLineCount: lines.length,
    excerptStart: start,
    stack,
  }
}

function terminalFreezeLog(message: string, data: unknown): void {
  // One JSON line is intentional: terminal output remains copy/pasteable and grep-friendly, while
  // pretty-printing a 30-process snapshot creates hundreds of lines during an already-bad freeze.
  try {
    const serialized = JSON.stringify(data)
    // WHY terminal output has a hard byte-shaped ceiling even for explicit
    // native captures: stderr can apply backpressure. A future Electron metric
    // expansion or verbose OS sample must not turn diagnostics into another
    // long task in main. The suffix is metadata; discarded bytes are never
    // application content because every input to this sink is shape/metric data.
    const bounded = serialized.length <= MAX_TERMINAL_DIAGNOSTIC_CHARS
      ? serialized
      : `${serialized.slice(0, MAX_TERMINAL_DIAGNOSTIC_CHARS)}…[diagnostic truncated]`
    console.error(`[freeze-diagnostics] ${message} ${bounded}`)
  } catch {
    // A diagnostic sink must never throw back into an Electron lifecycle
    // callback or watchdog timer. All current payloads are plain metadata, but
    // this boundary protects future additions from BigInt/cyclic mistakes.
  }
}

function diagnosticFailureMetadata(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { errorType: typeof error }
  // Error.name and string codes are mutable application content. Only their lengths are useful for
  // diagnosing malformed failures; copying them verbatim would reintroduce the same path/token leak
  // eliminated from outbound IPC breadcrumbs.
  const metadata: Record<string, string | number> = { errorType: 'Error' }
  const candidate = error as Error & { code?: unknown; stderrBytes?: unknown }
  if (typeof candidate.code === 'string') metadata.errorCodeLength = candidate.code.length
  if (typeof candidate.code === 'number') metadata.errorCode = candidate.code
  if (typeof candidate.stderrBytes === 'number') metadata.stderrBytes = candidate.stderrBytes
  return metadata
}

function admitIncidentRecord(state: RendererLiveness): boolean {
  const now = Date.now()
  if (state.lastIncidentAt !== null && now - state.lastIncidentAt < HEARTBEAT_REPEAT_LOG_MS) {
    return false
  }
  state.lastIncidentAt = now
  return true
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('diagnostic timeout')), timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function safeRendererPid(webContents: WebContents): number | null {
  try {
    return webContents.getOSProcessId()
  } catch {
    return null
  }
}

function roundNs(value: number): number | null {
  return Number.isFinite(value) ? Math.round((value / 1e6) * 100) / 100 : null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
