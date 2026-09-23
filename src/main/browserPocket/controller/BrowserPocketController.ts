import type { LanePort, PocketDrivingEvent, PocketFlags, PocketPickResult, PortWatchSession } from '@shared/browserPocket/types.js'

import { emptyBuffers, entriesSince, reduceCdpEvent, type CdpBuffers, type ConsoleEntry, type NetworkEntry } from '../core/cdpBuffers.js'

/**
 * Owns every pocket guest's CDP session, action queue and control epoch
 * (decomposition Stage 8 — isolated hard part #2). Main-only: the renderer
 * never imports this, it talks through ipc/browserPocket.ts, and agents talk
 * through mcp/runtime/browserTools.ts.
 *
 * The three rules T3 Code's shipped bugs taught (research §4, §7):
 * 1. Every action has its OWN deadline; a timeout resets only THIS pocket's
 *    debugger. T3 evicted the whole automation host on one timeout and every
 *    later call failed (#12273, #12898).
 * 2. Target resolution is by the caller's own session — there is no way to
 *    name another pocket (T3 #13051 read the wrong browser context).
 * 3. Agent input never moves the app's focus (T3 #10980/#11577): keyboard
 *    input uses CDP focus emulation on the guest, never webContents.focus().
 */

export type ToolErrorCode = 'no_pocket' | 'disabled' | 'timeout' | 'user_took_control' | 'paused_by_user' | 'devtools_open' | 'failed'
export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; code: ToolErrorCode; message: string }

/** The slice of Electron.Debugger we use — a fake replays recordings in tests. */
export type DebuggerLike = {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: object): Promise<any>
  on(event: 'message', listener: (event: unknown, method: string, params: any) => void): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener?(event: 'message', listener: (event: unknown, method: string, params: any) => void): unknown
}

/** The slice of Electron.WebContents we use. */
export type GuestLike = {
  id: number
  debugger: DebuggerLike
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  reload(): void
  canGoBack?(): boolean
  navigationHistory?: { goBack(): void; goForward(): void; canGoBack(): boolean; canGoForward(): boolean }
  capturePage(rect?: { x: number; y: number; width: number; height: number }, opts?: { stayHidden?: boolean }): Promise<ImageLike>
  setZoomFactor?(factor: number): void
  once(event: 'destroyed', listener: () => void): unknown
}

export type ImageLike = {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(opts: { width: number }): ImageLike
  toJPEG(quality: number): Buffer
}

export type ActionCtx = {
  cdp: DebuggerLike
  guest: GuestLike
  /** Declare an upcoming CDP mouse event at this point so its echo through
   * the guest's input-event is not mistaken for the user taking over. */
  expectPointer(x: number, y: number): void
  /** Same for CDP key events (echo is matched by time). */
  expectKeys(): void
  /** Throws `user_took_control` if a human acted since this action began. */
  checkEpoch(): void
  /** Report the agent's pointer for the ghost cursor. */
  pointer(x: number, y: number): void
}

type Pocket = {
  pocketId: string
  sessionId: string
  guest: GuestLike
  attached: boolean
  listenersInstalled: boolean
  queue: Promise<unknown>
  epoch: number
  paused: boolean
  resumeTimer: ReturnType<typeof setTimeout> | null
  expectedPointers: Array<{ x: number; y: number; until: number }>
  /** Any mouse report before this is our own echo, whatever its coordinates:
   * input-event may report widget pixels while we dispatch CSS pixels, which
   * differ under pocket zoom or a scaled device viewport (review A #7). */
  expectPointerAnyUntil: number
  expectKeysUntil: number
  /** A user pick is in progress: its click is not "taking control" (review A #4). */
  picking: boolean
  /** Page emulation to re-apply after a debugger re-attach, which clears it
   * (review A #6: a timeout reset silently dropped the colour scheme). */
  emulation: { colorScheme?: 'light' | 'dark' | null }
  buffers: CdpBuffers
  pickAbort: (() => void) | null
}

export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_TIMEOUT_MS = 15_000
/** D7: a takeover hands control back after this long without human input. */
export const TAKEOVER_IDLE_RESUME_MS = 60_000
const POINTER_ECHO_MS = 1000
const POINTER_ANY_ECHO_MS = 300
const KEY_ECHO_MS = 500

class Aborted extends Error {}
class Timeout extends Error {}

export type ControllerDeps = {
  now(): number
  emitDriving(event: PocketDrivingEvent): void
  /** Ask the renderer (which owns SessionMeta) to attach/open a pocket. */
  requestOpen(sessionId: string, url?: string): void
  setWatchedSessions(sessions: PortWatchSession[]): void
  lanePorts(sessionId: string): LanePort[]
  /** Ask the renderer to change the pocket's viewport (it owns SessionMeta). */
  requestViewport(sessionId: string, viewport: PocketViewportRequest): void
}

export type PocketViewportRequest = { mode: 'fill' } | { mode: 'preset'; preset: string } | { mode: 'free'; width: number; height: number }

export class BrowserPocketController {
  private pockets = new Map<string, Pocket>()
  private flags: PocketFlags = { enabled: false, allowEvaluate: false }
  private snapshotCursor = new Map<string, number>()
  private registrationWaiters = new Map<string, Array<() => void>>()

  constructor(private readonly deps: ControllerDeps) {}

  // ---------------------------------------------------------------- IPC side

  setFlags(flags: PocketFlags): void {
    this.flags = flags
    // Off means off: no debugger stays attached to a page the user can no
    // longer see controlled (review A #9).
    if (!flags.enabled) for (const p of this.pockets.values()) this.detach(p)
  }

  isEnabled(): boolean {
    return this.flags.enabled
  }

  allowEvaluate(): boolean {
    return this.flags.enabled && this.flags.allowEvaluate
  }

  register(pocketId: string, sessionId: string, guest: GuestLike): void {
    const existing = this.pockets.get(pocketId)
    if (existing && existing.guest === guest) {
      // An id remap (reload / provider switch). Carry the "since last
      // snapshot" cursor, or the first snapshot after a reload repeats every
      // old console error (review A #9).
      if (existing.sessionId !== sessionId) {
        const cursor = this.snapshotCursor.get(existing.sessionId)
        this.snapshotCursor.delete(existing.sessionId)
        if (cursor !== undefined) this.snapshotCursor.set(sessionId, cursor)
      }
      existing.sessionId = sessionId
    } else {
      if (existing) {
        this.detach(existing)
        if (existing.resumeTimer) clearTimeout(existing.resumeTimer)
      }
      this.pockets.set(pocketId, {
        pocketId, sessionId, guest, attached: false, listenersInstalled: false, queue: Promise.resolve(),
        epoch: 0, paused: false, resumeTimer: null, expectedPointers: [], expectPointerAnyUntil: 0, expectKeysUntil: 0,
        picking: false, emulation: {}, buffers: emptyBuffers(), pickAbort: null,
      })
      guest.once('destroyed', () => {
        const current = this.pockets.get(pocketId)
        if (current?.guest === guest) this.forget(current)
      })
    }
    for (const resolve of this.registrationWaiters.get(sessionId) ?? []) resolve()
    this.registrationWaiters.delete(sessionId)
  }

  async unregister(pocketId: string): Promise<void> {
    const p = this.pockets.get(pocketId)
    if (!p) return
    // Detach BEFORE the renderer drops the <webview>: destroying a guest with
    // an attached debugger is a main-process use-after-free (electron#53819).
    this.detach(p)
    this.forget(p)
  }

  noteHumanInput(pocketId: string, at?: { x: number; y: number }): void {
    const p = this.pockets.get(pocketId)
    if (!p) return
    const now = this.deps.now()
    // Is this the echo of our own CDP input? Whether CDP input passes the
    // guest's before-input-event/input-event is unverified on 43.7.x
    // (decomposition U6b), so every report is filtered against what we are
    // dispatching ourselves.
    if (p.picking) return
    p.expectedPointers = p.expectedPointers.filter(e => e.until > now)
    if (at && (now < p.expectPointerAnyUntil || p.expectedPointers.some(e => Math.abs(e.x - at.x) <= 1 && Math.abs(e.y - at.y) <= 1))) return
    if (!at && now < p.expectKeysUntil) return
    p.epoch++
    if (!p.paused) {
      p.paused = true
      this.deps.emitDriving({ pocketId, state: 'user-paused' })
    }
    this.armIdleResume(p)
  }

  /** Main's key forwarding asks this before treating a guest key as an app
   * chord: the agent's own CDP keys must reach the page (review A #5). */
  agentTyping(pocketId: string): boolean {
    const p = this.pockets.get(pocketId)
    return p !== undefined && this.deps.now() < p.expectKeysUntil
  }

  takeOver(pocketId: string): void {
    const p = this.pockets.get(pocketId)
    if (!p) return
    p.epoch++
    if (!p.paused) { p.paused = true; this.deps.emitDriving({ pocketId, state: 'user-paused' }) }
    this.armIdleResume(p)
  }

  resume(pocketId: string): void {
    const p = this.pockets.get(pocketId)
    if (!p) return
    if (p.resumeTimer) clearTimeout(p.resumeTimer)
    p.resumeTimer = null
    if (p.paused) { p.paused = false; this.deps.emitDriving({ pocketId, state: null }) }
  }

  setWatchedSessions(sessions: PortWatchSession[]): void {
    this.deps.setWatchedSessions(sessions)
  }

  async thumbnail(pocketId: string): Promise<string | null> {
    const p = this.pockets.get(pocketId)
    if (!p || p.guest.isDestroyed()) return null
    try {
      const image = await withTimeout(p.guest.capturePage(undefined, { stayHidden: true }), 1000)
      if (image.isEmpty()) return null
      const small = image.getSize().width > 320 ? image.resize({ width: 320 }) : image
      return `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`
    } catch {
      return null
    }
  }

  async applyEmulation(pocketId: string, emulation: { colorScheme?: 'light' | 'dark' | null; zoom?: number }): Promise<void> {
    const p = this.pockets.get(pocketId)
    if (!p || p.guest.isDestroyed()) return
    // Chromium hands the HOST window's zoom to guests; each pocket re-asserts
    // its own and never reads it back (T3 #12319: host zoom leaking made the
    // guest viewport 1.44× and every resize time out).
    if (typeof emulation.zoom === 'number') p.guest.setZoomFactor?.(emulation.zoom)
    if (emulation.colorScheme !== undefined) {
      p.emulation.colorScheme = emulation.colorScheme
      if (!this.flags.enabled) return
      try {
        this.ensureAttached(p)
        await p.guest.debugger.sendCommand('Emulation.setEmulatedMedia', { features: emulation.colorScheme ? [{ name: 'prefers-color-scheme', value: emulation.colorScheme }] : [] })
      } catch { /* a guest mid-navigation; the next emulation call reapplies */ }
    }
  }

  // ----------------------------------------------------------- agent side

  pocketIdFor(sessionId: string): string | null {
    for (const p of this.pockets.values()) if (p.sessionId === sessionId && !p.guest.isDestroyed()) return p.pocketId
    return null
  }

  lanePorts(sessionId: string): LanePort[] {
    return this.deps.lanePorts(sessionId)
  }

  /**
   * Make sure the caller has a live pocket, optionally at `url`. The renderer
   * owns SessionMeta, so main can only ASK for a pocket (collapsed — never
   * a popped panel) and wait for the guest to register.
   */
  async openPocketFor(sessionId: string, url: string | undefined, waitMs = 8000): Promise<'opened' | 'already' | 'timeout' | 'disabled'> {
    if (!this.flags.enabled) return 'disabled'
    // An existing pocket is NOT navigated here: the caller navigates through
    // run(), which honours the user's takeover and the queue. Sending the URL
    // to the renderer as well navigated the page while the user had control
    // and raced the tool's own load (review A #3).
    if (this.pocketIdFor(sessionId)) return 'already'
    let resolveWaiter!: () => void
    const registered = new Promise<void>(resolve => { resolveWaiter = resolve })
    this.registrationWaiters.set(sessionId, [...(this.registrationWaiters.get(sessionId) ?? []), resolveWaiter])
    this.deps.requestOpen(sessionId, url)
    const ok = await Promise.race([registered.then(() => true), sleep(waitMs).then(() => false)])
    if (!ok) {
      // Drop our waiter so abandoned opens do not accumulate (review A #9).
      const rest = (this.registrationWaiters.get(sessionId) ?? []).filter(w => w !== resolveWaiter)
      if (rest.length) this.registrationWaiters.set(sessionId, rest); else this.registrationWaiters.delete(sessionId)
    }
    return ok ? 'opened' : 'timeout'
  }

  consoleSince(sessionId: string, opts: { sinceLastSnapshot?: boolean } = {}): ConsoleEntry[] {
    const p = this.bySession(sessionId)
    if (!p) return []
    return entriesSince(p.buffers.console, opts.sinceLastSnapshot ? this.snapshotCursor.get(sessionId) : undefined)
  }

  networkSince(sessionId: string, opts: { sinceLastSnapshot?: boolean } = {}): NetworkEntry[] {
    const p = this.bySession(sessionId)
    if (!p) return []
    return entriesSince(p.buffers.network, opts.sinceLastSnapshot ? this.snapshotCursor.get(sessionId) : undefined)
  }

  markSnapshot(sessionId: string): void {
    const p = this.bySession(sessionId)
    if (p) this.snapshotCursor.set(sessionId, p.buffers.seq)
  }

  async run<T>(sessionId: string, action: string, fn: (ctx: ActionCtx) => Promise<T>, opts: { mutating?: boolean; timeoutMs?: number; describe?: string } = {}): Promise<ToolOutcome<T>> {
    if (!this.flags.enabled) return { ok: false, code: 'disabled', message: 'Browser Pocket is turned off in Settings → Experimental.' }
    const p = this.bySession(sessionId)
    if (!p) return { ok: false, code: 'no_pocket', message: 'You have no browser pocket open. Call browser_open first.' }
    if (opts.mutating && p.paused) return { ok: false, code: 'paused_by_user', message: 'The user took control of the browser. Stop browser actions until they hand it back.' }
    if (opts.mutating && p.guest.isDevToolsOpened()) return { ok: false, code: 'devtools_open', message: 'DevTools is open on this pocket; the agent cannot act on the page until it is closed.' }

    const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const startEpoch = p.epoch
    let timer: ReturnType<typeof setTimeout> | undefined
    // Set when this call has already answered the agent "timeout". An action
    // still waiting in the queue (or mid-way) must then never act on the page:
    // otherwise the agent retries and the page gets a double click or double
    // submit, and the late "driving" signal pins the pocket as agent-driven
    // (review A #2).
    let cancelled = false
    const work = p.queue.then(async () => {
      if (cancelled) throw new Timeout()
      if (opts.mutating) this.deps.emitDriving({ pocketId: p.pocketId, state: 'agent', action: opts.describe ?? action })
      this.ensureAttached(p)
      const ctx: ActionCtx = {
        cdp: p.guest.debugger,
        guest: p.guest,
        expectPointer: (x, y) => {
          const now = this.deps.now()
          p.expectedPointers.push({ x, y, until: now + POINTER_ECHO_MS })
          p.expectPointerAnyUntil = now + POINTER_ANY_ECHO_MS
        },
        expectKeys: () => { p.expectKeysUntil = this.deps.now() + KEY_ECHO_MS },
        checkEpoch: () => {
          if (cancelled) throw new Timeout()
          if (opts.mutating && p.epoch !== startEpoch) throw new Aborted()
        },
        pointer: (x, y) => this.deps.emitDriving({ pocketId: p.pocketId, state: 'agent', action: opts.describe ?? action, point: { x, y } }),
      }
      if (opts.mutating) ctx.checkEpoch()
      return await fn(ctx)
    })
    // The queue must survive a failed or timed-out action.
    p.queue = work.catch(() => undefined)
    try {
      const value = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), timeoutMs) })])
      return { ok: true, value }
    } catch (error) {
      if (error instanceof Aborted) return { ok: false, code: 'user_took_control', message: 'The user interacted with the page; the action was stopped.' }
      if (error instanceof Timeout) {
        cancelled = true
        // Reset ONLY this pocket: detach its debugger (re-attached lazily on
        // the next call) and start a fresh queue so the stalled promise
        // cannot block the next action.
        this.detach(p)
        p.queue = Promise.resolve()
        return { ok: false, code: 'timeout', message: `${action} did not finish within ${timeoutMs} ms.` }
      }
      return { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      if (timer) clearTimeout(timer)
      if (opts.mutating && !p.paused) this.deps.emitDriving({ pocketId: p.pocketId, state: null })
    }
  }

  /**
   * browser_resize. The renderer sizes the page element to the device viewport
   * (ui/layout.ts fitViewport), so the agent and the user always see the same
   * breakpoints — T3 Code emulated metrics over CDP for the agent while the
   * user saw another size (#3712/#8469). Main only relays the request.
   */
  async resizeViewport(sessionId: string, viewport: PocketViewportRequest): Promise<ToolOutcome<void>> {
    if (!this.flags.enabled) return { ok: false, code: 'disabled', message: 'Browser Pocket is turned off in Settings → Experimental.' }
    const p = this.bySession(sessionId)
    if (!p) return { ok: false, code: 'no_pocket', message: 'You have no browser pocket open. Call browser_open first.' }
    if (p.paused) return { ok: false, code: 'paused_by_user', message: 'The user took control of the browser. Stop browser actions until they hand it back.' }
    this.deps.requestViewport(sessionId, viewport)
    // Give the renderer a frame to resize and the page a moment to reflow
    // before the agent's next snapshot.
    await sleep(300)
    return { ok: true, value: undefined }
  }

  // ----------------------------------------------------------- picker

  async pick(pocketId: string): Promise<PocketPickResult | null> {
    const p = this.pockets.get(pocketId)
    if (!p || !this.flags.enabled) return null
    // A second pick replaces the first instead of leaving it hanging for 60 s.
    p.pickAbort?.()
    const { pickElement } = await import('./picker.js')
    // Through the queue, so an agent's CDP click can never land while the
    // inspect overlay is armed (the overlay would take it as the pick), and
    // with `picking` set so the user's pick click does not pause the agent
    // (review A #4).
    const job = p.queue.then(async () => {
      p.picking = true
      try {
        return await pickElement(p, () => this.ensureAttached(p), abort => { p.pickAbort = abort })
      } finally {
        p.picking = false
      }
    })
    p.queue = job.catch(() => undefined)
    return job.catch(() => null)
  }

  cancelPick(pocketId: string): void {
    this.pockets.get(pocketId)?.pickAbort?.()
  }

  // ----------------------------------------------------------- internals

  private bySession(sessionId: string): Pocket | undefined {
    for (const p of this.pockets.values()) if (p.sessionId === sessionId && !p.guest.isDestroyed()) return p
    return undefined
  }

  private ensureAttached(p: Pocket): void {
    if (p.attached && p.guest.debugger.isAttached()) return
    if (!p.guest.debugger.isAttached()) p.guest.debugger.attach('1.3')
    p.attached = true
    // A fresh attach has no emulation; restore what the user chose.
    if (p.emulation.colorScheme) {
      void p.guest.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: p.emulation.colorScheme }] }).catch(() => {})
    }
    if (!p.listenersInstalled) {
      p.listenersInstalled = true
      p.guest.debugger.on('message', (_event, method, params) => reduceCdpEvent(p.buffers, method, params, this.deps.now()))
      p.guest.debugger.on('detach', () => { p.attached = false })
    }
    // Buffers need these domains; failures surface on the first real command.
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable', 'DOM.enable', 'Accessibility.enable']) {
      void p.guest.debugger.sendCommand(method).catch(() => {})
    }
  }

  private detach(p: Pocket): void {
    p.pickAbort?.()
    if (p.attached || p.guest.debugger.isAttached()) {
      try { p.guest.debugger.detach() } catch { /* already gone */ }
    }
    p.attached = false
  }

  private forget(p: Pocket): void {
    if (p.resumeTimer) clearTimeout(p.resumeTimer)
    this.pockets.delete(p.pocketId)
    this.snapshotCursor.delete(p.sessionId)
  }

  private armIdleResume(p: Pocket): void {
    if (p.resumeTimer) clearTimeout(p.resumeTimer)
    p.resumeTimer = setTimeout(() => this.resume(p.pocketId), TAKEOVER_IDLE_RESUME_MS)
  }
}

export type PocketInternals = Pocket

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
}
