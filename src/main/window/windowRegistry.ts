import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'

import { buildAppWindow, zoomBrowserWindow } from '@main/window/appWindow.js'
import type { WindowBounds } from '@main/window/appWindow.js'

// The window registry: who exists, who is focused, who owns which session, and
// therefore who should hear a given outbound message.
//
// WHY this replaced a module-scoped `mainWindow` + `sendToMainWindow`:
//
// The old shape made "send to the window" a well-formed thought, and with more
// than one window it is not one. Three different questions were hiding behind
// that single helper, and each has a different right answer:
//
//   - session traffic  → the window that owns the session
//   - app-wide state   → every window
//   - user gestures    → the focused window
//
// Getting that wrong is not cosmetic. Every session handler in
// `useIpcSubscriptions.ts` reads `prev[sessionId] ?? emptyRuntime()`, so a
// session event delivered to a window that does not own the session does not
// get ignored — it MATERIALIZES a runtime for a pane that window will never
// show. Routing here is the primary defense against that; the renderer-side
// ownership guard is the backstop.
//
// There is deliberately no `sendToMainWindow` alias left behind. An alias would
// let a new call site keep the ambiguity this module exists to remove.

export type WindowId = string

type RegisteredWindow = {
  id: WindowId
  window: BrowserWindow
  /**
   * Set as soon as Electron's `close` fires, which is BEFORE `closed` and
   * before webContents teardown. Routing skips a closing window: it can still
   * technically receive IPC, but anything sent to a renderer that is being
   * destroyed is at best wasted and at worst a message the sender believes was
   * delivered to a live workspace.
   */
  closing: boolean
}

const windows = new Map<WindowId, RegisteredWindow>()

/**
 * Most-recently-focused first. This is the source of truth for
 * `sendToFocusedWindow`, and it is a LIST rather than a single id because
 * `BrowserWindow.getFocusedWindow()` returns null whenever the app itself is
 * not frontmost — a native menu click, a global dictation hotkey, and a
 * `second-instance` activation can all arrive in exactly that state. Falling
 * back to "the window the user was last in" is the only answer that does not
 * silently drop those gestures.
 */
const focusOrder: WindowId[] = []

/**
 * sessionId → the window that asked for the session.
 *
 * WHY ownership is recorded at spawn/recover rather than derived from the
 * persisted workspace: `workspace:save` is debounced 400ms, so a freshly
 * spawned session would have no owner for precisely the interval in which its
 * first `session:started`, first screen snapshot, and first semantic events
 * arrive. The IPC request that creates a session already identifies its window
 * through `event.sender`, which makes ownership exact and immediate instead of
 * eventually-consistent.
 */
const sessionOwners = new Map<string, WindowId>()

// ---------------------------------------------------------------------------
// Outbound IPC diagnostics
// ---------------------------------------------------------------------------
//
// WHY the breadcrumb ring lives with the registry rather than with a window:
// it answers "what was this PROCESS sending when it stalled". A per-window ring
// would fragment exactly the evidence the freeze logger needs, and the observer
// below (session recording) records the logical event stream, not a per-window
// delivery log — so both are recorded once per send regardless of fan-out.

// Optional passive observer of the outbound IPC stream. Session recording
// (src/main/recording/, plan §2) registers here to capture the exact
// payloads the renderer receives, WITHOUT coupling this helper to the
// recorder — it just calls the hook if one is installed. Null (and
// therefore zero cost) unless recording is gated on.
type OutboundObserver = (channel: string, args: readonly unknown[]) => void
let outboundObserver: OutboundObserver | null = null

type OutboundIpcBreadcrumb = {
  at: number
  channel: string
  metadata: Record<string, string | number | boolean>
}

const OUTBOUND_IPC_BREADCRUMB_LIMIT = 32
const outboundIpcBreadcrumbs = new Array<OutboundIpcBreadcrumb | undefined>(
  OUTBOUND_IPC_BREADCRUMB_LIMIT,
)
let outboundIpcBreadcrumbCount = 0
let outboundIpcBreadcrumbWriteIndex = 0
const outboundIpcCounts = new Map<string, { count: number; lastAt: number }>()

export function setOutboundObserver(observer: OutboundObserver | null): void {
  outboundObserver = observer
}

export function getOutboundIpcDiagnostics(): {
  recent: OutboundIpcBreadcrumb[]
  counts: Array<{ channel: string; count: number; lastAt: number }>
} {
  // Return copies because the freeze logger serializes asynchronously from the same main-process
  // structures that hot session traffic continues mutating. A stable diagnostic snapshot matters
  // more than saving two tiny allocations on a path that only runs after a detected stall.
  return {
    recent: readOutboundIpcBreadcrumbs(),
    counts: [...outboundIpcCounts.entries()]
      .map(([channel, value]) => ({ channel, ...value }))
      .sort((left, right) => right.lastAt - left.lastAt),
  }
}

export function recordIpcDiagnosticBreadcrumb(
  channel: string,
  metadata: Record<string, string | number | boolean>,
): void {
  // WHY request/response milestones share the bounded outbound ring: a renderer freeze often sits
  // exactly between a main-process IPC response and its renderer acknowledgement. OpenTelemetry
  // spans eventually reach disk but were missing request cursors and response sizes in the copied
  // terminal snapshot. This metadata-only hook makes that causal edge visible without retaining
  // prompts, commands, output, or arbitrary IPC arguments.
  const at = Date.now()
  const previous = outboundIpcCounts.get(channel)
  outboundIpcCounts.set(channel, { count: (previous?.count ?? 0) + 1, lastAt: at })
  appendOutboundIpcBreadcrumb({
    at,
    channel,
    metadata: sanitizeDiagnosticMetadata(metadata),
  })
}

function recordOutboundIpcBreadcrumb(channel: string, args: readonly unknown[]): void {
  const at = Date.now()
  const previous = outboundIpcCounts.get(channel)
  outboundIpcCounts.set(channel, { count: (previous?.count ?? 0) + 1, lastAt: at })
  appendOutboundIpcBreadcrumb({
    at,
    channel,
    metadata: outboundMetadata(args),
  })
}

function appendOutboundIpcBreadcrumb(item: OutboundIpcBreadcrumb): void {
  // WHY this is a fixed ring rather than push/splice: this function is on the
  // IPC hot path. A prolonged stream must replace one slot without growing an
  // array, shifting old entries, or retaining arguments beyond their metadata.
  outboundIpcBreadcrumbs[outboundIpcBreadcrumbWriteIndex] = item
  outboundIpcBreadcrumbWriteIndex =
    (outboundIpcBreadcrumbWriteIndex + 1) % OUTBOUND_IPC_BREADCRUMB_LIMIT
  outboundIpcBreadcrumbCount = Math.min(
    outboundIpcBreadcrumbCount + 1,
    OUTBOUND_IPC_BREADCRUMB_LIMIT,
  )
}

function readOutboundIpcBreadcrumbs(): OutboundIpcBreadcrumb[] {
  const result: OutboundIpcBreadcrumb[] = []
  const start = outboundIpcBreadcrumbCount < OUTBOUND_IPC_BREADCRUMB_LIMIT
    ? 0
    : outboundIpcBreadcrumbWriteIndex
  for (let offset = 0; offset < outboundIpcBreadcrumbCount; offset += 1) {
    const item = outboundIpcBreadcrumbs[
      (start + offset) % OUTBOUND_IPC_BREADCRUMB_LIMIT
    ]
    if (item) result.push({ ...item, metadata: { ...item.metadata } })
  }
  return result
}

function outboundMetadata(args: readonly unknown[]): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = { argumentCount: args.length }
  const payload = asRecord(args[0])
  if (!payload) {
    if (typeof args[0] === 'string') metadata.firstStringLength = args[0].length
    return metadata
  }

  // WHY this intentionally captures shape, not content: the freeze line belongs in the terminal
  // and can therefore outlive debug-retention cleanup or be pasted into an issue. Identifiers,
  // event families, and collection/string sizes are enough to identify a transport avalanche;
  // prompts, tool input, terminal bytes, and assistant output are both noisy and potentially
  // sensitive, so none of their actual text belongs in this always-on breadcrumb ring. Even
  // identifier and event-family fields are represented only by length; their expected shape is not
  // a trustworthy guarantee once provider data crosses the boundary.
  copyStringLength(payload, metadata, 'sessionId')
  copyStringLength(payload, metadata, 'runId')
  copyStringLength(payload, metadata, 'type')
  copyNumberMetadata(payload, metadata, 'fromCursor')
  copyNumberMetadata(payload, metadata, 'toCursor')
  copyNumberMetadata(payload, metadata, 'rawEventCount')
  copyCollectionLength(payload, metadata, 'events')
  copyCollectionLength(payload, metadata, 'entries')
  copyCollectionLength(payload, metadata, 'runs')
  copyStringLength(payload, metadata, 'data')
  copyStringLength(payload, metadata, 'screen')
  const event = asRecord(payload.event)
  if (event && typeof event.type === 'string') metadata.eventTypeLength = event.type.length
  return metadata
}

function sanitizeDiagnosticMetadata(
  source: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(source).slice(0, 24)) {
    if (typeof value !== 'string') {
      result[key] = value
      continue
    }
    // WHY no renderer/provider string is ever copied verbatim: names such as `runId`, `type`, or
    // `code` describe expected shape, not trustworthy provenance. A malformed payload can place a
    // prompt, command, token, or path in any of them. Counts and lengths retain avalanche evidence
    // without attempting an impossible content classifier at the terminal logging boundary.
    result[`${key}Length`] = value.length
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function copyNumberMetadata(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  if (typeof source[key] === 'number' && Number.isFinite(source[key])) target[key] = source[key]
}

function copyCollectionLength(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  if (Array.isArray(source[key])) target[`${key}Count`] = source[key].length
}

function copyStringLength(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  if (typeof source[key] === 'string') target[`${key}Length`] = source[key].length
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function createAppWindow(options?: {
  windowId?: WindowId
  bounds?: WindowBounds | null
  fullScreen?: boolean
}): WindowId {
  const id = options?.windowId ?? randomUUID()
  const window = buildAppWindow({
    windowId: id,
    bounds: options?.bounds ?? null,
    fullScreen: options?.fullScreen ?? false,
    hooks: {
      onFocused: () => noteFocused(id),
      onClosing: () => {
        const entry = windows.get(id)
        if (entry) entry.closing = true
      },
      onClosed: () => {
        windows.delete(id)
        const index = focusOrder.indexOf(id)
        if (index !== -1) focusOrder.splice(index, 1)
        // Session ownership is NOT cleared here. A closed window's sessions
        // stay alive in SessionManager, and the close path transfers them to a
        // survivor. Clearing on teardown would strand every one of them as
        // "unowned" between the two events, which downgrades their routing to a
        // broadcast for no reason.
      },
    },
  })
  windows.set(id, { id, window, closing: false })
  noteFocused(id)
  return id
}

function noteFocused(id: WindowId): void {
  const index = focusOrder.indexOf(id)
  if (index !== -1) focusOrder.splice(index, 1)
  focusOrder.unshift(id)
}

export function listWindowIds(): WindowId[] {
  return [...windows.keys()]
}

export function windowCount(): number {
  return windows.size
}

export function getBrowserWindow(id: WindowId): BrowserWindow | null {
  const entry = windows.get(id)
  if (!entry || entry.window.isDestroyed()) return null
  return entry.window
}

export function windowIdFor(sender: WebContents): WindowId | null {
  return windowIdForWebContentsId(sender.id)
}

/**
 * Resolve by raw `webContents.id`.
 *
 * WHY this exists next to `windowIdFor`: WorkflowBridge already stores a
 * `rendererId` (a webContents id) per run interest, captured when a renderer
 * registered interest. It holds the number long after the `WebContents` object
 * is out of scope, so it needs to resolve from the id alone.
 */
export function windowIdForWebContentsId(webContentsId: number): WindowId | null {
  for (const entry of windows.values()) {
    if (entry.window.isDestroyed()) continue
    if (entry.window.webContents.id === webContentsId) return entry.id
  }
  return null
}

/** The focused window, else the most recently focused one that still exists. */
export function focusedWindowId(): WindowId | null {
  const native = BrowserWindow.getFocusedWindow()
  if (native && !native.isDestroyed()) {
    for (const entry of windows.values()) {
      if (entry.window.id === native.id) return entry.id
    }
  }
  for (const id of focusOrder) {
    const entry = windows.get(id)
    if (entry && !entry.closing && !entry.window.isDestroyed()) return id
  }
  return null
}

/**
 * Bring a window to the front. Used by the `second-instance` handler, where the
 * user has just tried to launch the app again and expects to land where they
 * left off — which is the last window they were in, not an arbitrary one.
 */
export function focusWindow(id: WindowId | null): void {
  const target = id ?? focusedWindowId()
  if (!target) return
  const window = getBrowserWindow(target)
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function zoomFocusedWindow(direction: 'in' | 'out' | 'reset'): void {
  const id = focusedWindowId()
  if (!id) return
  const window = getBrowserWindow(id)
  if (window) zoomBrowserWindow(window, direction)
}

// ---------------------------------------------------------------------------
// Session ownership
// ---------------------------------------------------------------------------

export function claimSessionForWindow(sessionId: string, id: WindowId | null): void {
  if (!id) return
  sessionOwners.set(sessionId, id)
}

export function releaseSession(sessionId: string): void {
  sessionOwners.delete(sessionId)
}

export function windowForSession(sessionId: string): WindowId | null {
  const id = sessionOwners.get(sessionId)
  if (!id) return null
  return windows.has(id) ? id : null
}

/** Move every listed session to a new owner. Used when a closing window hands
 *  its live agents to a survivor: ownership must move BEFORE the survivor is
 *  told about them, or events emitted mid-handoff route to a dying window. */
export function transferSessions(sessionIds: Iterable<string>, to: WindowId): void {
  for (const sessionId of sessionIds) sessionOwners.set(sessionId, to)
}

export function sessionsOwnedBy(id: WindowId): string[] {
  const owned: string[] = []
  for (const [sessionId, owner] of sessionOwners) {
    if (owner === id) owned.push(sessionId)
  }
  return owned
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function deliver(targets: RegisteredWindow[], channel: string, args: unknown[]): void {
  recordOutboundIpcBreadcrumb(channel, args)
  for (const entry of targets) {
    if (entry.closing || entry.window.isDestroyed()) continue
    entry.window.webContents.send(channel, ...args)
  }
  // Observe AFTER the send so recording can never delay or break delivery, and
  // exactly ONCE per logical event regardless of how many windows received it —
  // a recording is of the event stream, not of the delivery fan-out.
  // The observer must not throw; it is a try/caught diagnostic sink.
  if (outboundObserver) {
    try {
      outboundObserver(channel, args)
    } catch {
      /* recording is a diagnostic; never let it break IPC */
    }
  }
}

function liveWindows(): RegisteredWindow[] {
  return [...windows.values()].filter(
    entry => !entry.closing && !entry.window.isDestroyed(),
  )
}

/** Process-wide state every window renders (AI Workspace changes, CLI update
 *  status, caffeinate, remote server status, LSP diagnostics). */
export function broadcastToWindows(channel: string, ...args: unknown[]): void {
  deliver(liveWindows(), channel, args)
}

export function sendToWindow(id: WindowId | null, channel: string, ...args: unknown[]): void {
  if (!id) return
  const entry = windows.get(id)
  deliver(entry ? [entry] : [], channel, args)
}

/** User-gesture traffic: native menu commands, dictation hotkeys, "open this AI
 *  workspace". The gesture happened in one place and its effect belongs there. */
export function sendToFocusedWindow(channel: string, ...args: unknown[]): void {
  sendToWindow(focusedWindowId(), channel, ...args)
}

/**
 * Session traffic. Routes to the owning window.
 *
 * WHY an unknown owner broadcasts instead of dropping: a dropped session event
 * silently freezes a pane, which is the single worst failure shape this
 * codebase knows (the rendering design principles' P6 — bias toward surviving,
 * because a row that survives is diagnosable while one that vanishes is not).
 * Ownership is claimed at id-mint time and released only on an explicit kill,
 * so "unowned" should mean "no window is displaying this" and the fallback
 * should effectively never fire. It is still a broadcast rather than a drop
 * because that reasoning is an argument, and an argument is not a guarantee.
 *
 * WHY there is no matching renderer-side "ignore sessions I don't own" guard,
 * even though it looks like the obvious belt to this suspenders:
 *
 * The renderer CANNOT distinguish "not mine" from "mine, but I have not
 * registered it yet". A pane's first events legitimately precede the
 * `session:spawn` IPC response — that is the whole reason ownership is claimed
 * from inside `spawn()` — so the renderer accumulates them under a sessionId it
 * has not seen before (`prev[sessionId] ?? emptyRuntime()`, eleven call sites).
 * A guard strict enough to reject a foreign session would also reject the first
 * frames of every new pane in its own window. So the fallback is instead made
 * rare by construction and made *visible* through the breadcrumb below, rather
 * than made harmless by a guard that cannot exist.
 */
export function sendToSessionWindow(
  sessionId: string,
  channel: string,
  ...args: unknown[]
): void {
  const owner = windowForSession(sessionId)
  if (owner) {
    sendToWindow(owner, channel, ...args)
    return
  }
  // Metadata only — lengths, never content. See the breadcrumb ring's notes.
  recordIpcDiagnosticBreadcrumb('window.route.unowned-session', {
    channel,
    sessionIdLength: sessionId.length,
    windowCount: windows.size,
  })
  broadcastToWindows(channel, ...args)
}

/** Test-only reset. Vitest module state persists across files in a worker. */
export function resetWindowRegistryForTests(): void {
  windows.clear()
  focusOrder.length = 0
  sessionOwners.clear()
  outboundObserver = null
  outboundIpcCounts.clear()
  outboundIpcBreadcrumbs.fill(undefined)
  outboundIpcBreadcrumbCount = 0
  outboundIpcBreadcrumbWriteIndex = 0
}
