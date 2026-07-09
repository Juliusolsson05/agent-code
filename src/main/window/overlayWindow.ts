import { app, BrowserWindow, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import type { AgentOverlaySnapshot } from '@shared/types/agentOverlay.js'
import { STATE_DIR } from '@main/storage/paths.js'
import { onMainWindowClosed, sendToMainWindow } from '@main/window/mainWindow.js'

// The floating agent-status overlay window (issue: "see agent status while
// in Chrome"). A tiny frameless always-on-top BrowserWindow that lives
// OUTSIDE the main window's lifecycle: it must stay visible when the main
// window is unfocused, hidden, or on another Space — that is its entire
// reason to exist.
//
// This module mirrors mainWindow.ts's module-scoped-singleton shape on
// purpose (same reload-safety rationale). It does NOT go through
// sendToMainWindow — the overlay has its own dedicated channels
// (agent-overlay:*) pushed directly at its webContents, so the
// single-window assumption in mainWindow.ts stays intact and the session
// forwarder never needs a fan-out refactor.

const __dirname = dirname(fileURLToPath(import.meta.url))

let overlayWindow: BrowserWindow | null = null

// ---------------------------------------------------------------------------
// Persisted state. Tiny JSON beside workspace.json — position, pill/list
// mode, and whether the overlay is enabled at all, so an enabled overlay
// comes back after an app restart without re-running the palette command.
// ---------------------------------------------------------------------------

const OVERLAY_STATE_FILE = join(STATE_DIR, 'agent-overlay.json')

type PersistedOverlayState = {
  enabled: boolean
  expanded: boolean
  position: { x: number; y: number } | null
}

const state: PersistedOverlayState = {
  enabled: false,
  expanded: false,
  position: null,
}

// Snapshot cache. The main renderer reports continuously; the overlay
// window may not exist yet (created lazily on first toggle) or may be
// mid-reload. Caching the latest snapshot lets did-finish-load render
// real data immediately instead of waiting for the next store change in
// the main renderer — same late-subscriber rationale as SessionManager's
// per-session snapshot cache.
let lastSnapshot: AgentOverlaySnapshot | null = null

// Serializes IPC against the async state restore. The agent-overlay IPC
// handlers are registered (registerAllIpc) BEFORE initAgentOverlay runs,
// so a very early toggle/get-enabled could act on the default state and
// then be silently overwritten when loadPersistedState resolves (PR #514
// review finding 4). Every public read/write of `state.enabled` awaits
// this instead. Starts resolved so unit-style callers that never ran
// init don't deadlock.
let restoreDone: Promise<void> = Promise.resolve()

let persistTimer: NodeJS.Timeout | null = null

function schedulePersist(): void {
  // Debounced fire-and-forget. 'moved' fires on every drag tick, and this
  // file is pure convenience state — losing the last 200ms of position on
  // a crash is fine; blocking window events on fs writes is not.
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void (async () => {
      try {
        await mkdir(STATE_DIR, { recursive: true })
        await writeFile(OVERLAY_STATE_FILE, JSON.stringify(state, null, 2))
      } catch {
        // Persistence is best-effort; the overlay works fine with defaults.
      }
    })()
  }, 200)
}

/**
 * Synchronous write-through for moments when the debounce would lose
 * data: app quit (the 200ms timer dies with the process) and
 * enabled-toggles (losing a drag position is cosmetic; losing the
 * user's on/off choice breaks the "comes back after restart" contract).
 */
function flushPersistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(OVERLAY_STATE_FILE, JSON.stringify(state, null, 2))
  } catch {
    // Same best-effort contract as schedulePersist.
  }
}

async function loadPersistedState(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(OVERLAY_STATE_FILE, 'utf8')) as Partial<PersistedOverlayState>
    state.enabled = raw.enabled === true
    state.expanded = raw.expanded === true
    if (
      raw.position &&
      typeof raw.position.x === 'number' &&
      typeof raw.position.y === 'number'
    ) {
      state.position = { x: raw.position.x, y: raw.position.y }
    }
  } catch {
    // Missing/corrupt file → defaults (disabled). Never fail startup.
  }
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

// The renderer drives sizing (it measures its own content and asks for a
// resize), but main clamps to sane bounds so a renderer bug can never
// produce a 4000px or 0px window that the user can't grab.
const MIN_W = 120
const MAX_W = 460
const MIN_H = 30
const MAX_H = 560
const DEFAULT_W = 240
const DEFAULT_H = 40
const SCREEN_MARGIN = 16

function defaultPosition(): { x: number; y: number } {
  // Top-right of the primary display's work area — out of the way of both
  // the dock and the typical browser tab strip, and consistent with where
  // most "status" pips live. The user can drag it anywhere; we persist it.
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - DEFAULT_W - SCREEN_MARGIN,
    y: area.y + SCREEN_MARGIN,
  }
}

/**
 * Keep the overlay grabbable. Two ways it can end up off-screen with no
 * recovery path (it has no menu, no taskbar entry, no edges to grab):
 * a persisted position on a display that no longer exists (monitor
 * unplugged), and an expand-resize near a screen edge growing past the
 * work area. Clamp against whichever display best matches the requested
 * bounds so multi-monitor drags still land where the user put it.
 */
function clampBoundsToDisplay(bounds: Electron.Rectangle): Electron.Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function createOverlayWindow(): void {
  const requested = state.position ?? defaultPosition()
  const pos = clampBoundsToDisplay({ ...requested, width: DEFAULT_W, height: DEFAULT_H })
  overlayWindow = new BrowserWindow({
    width: DEFAULT_W,
    height: DEFAULT_H,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    // Transparent + shadowless: the renderer draws its own rounded pill;
    // the window is just an invisible rectangle around it.
    transparent: true,
    hasShadow: false,
    // resizable:false blocks USER edge-resizing of the frameless window;
    // programmatic resizes below temporarily flip it (see resizeOverlayContent).
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // focusable:false is load-bearing: the overlay must never steal key
    // focus from Chrome (or from Agent Code itself). Mouse events still
    // arrive on non-focusable windows, so clicks to expand / focus an
    // agent keep working.
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      // The overlay gets its OWN slim preload (src/preload/overlay.ts),
      // not the main window's index.mjs: the full bridge exposes every
      // privileged API (fs, git, sessions, remote...) and this window
      // needs exactly four overlay methods. Same runtime-path trap as
      // mainWindow.ts though: this is a filesystem path resolved from
      // out/main/ at runtime, NOT a vite alias.
      preload: join(__dirname, '../preload/overlay.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 'floating' + visibleOnFullScreen keeps the overlay above normal app
  // windows AND visible over a fullscreen Chrome Space on macOS — the
  // "am I done yet?" glance from another app is the core use case.
  overlayWindow.setAlwaysOnTop(true, 'floating')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  overlayWindow.on('moved', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const [x, y] = overlayWindow.getPosition()
    state.position = { x, y }
    schedulePersist()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  // Same hardening stance as the main window (see mainWindow.ts): the
  // overlay carries a preload bridge, so even though it only ever loads
  // our own overlay.html, any navigation or window.open escape would
  // hand that bridge to foreign content. Deny both outright — unlike the
  // main window there is no legitimate external-link path here.
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlayWindow.webContents.on('will-navigate', event => {
    event.preventDefault()
  })

  overlayWindow.webContents.on('did-finish-load', () => {
    // Initial state push: cached snapshot + persisted expanded mode.
    // `expanded` is intentionally ONLY sent here — see AgentOverlayStateEvent.
    sendToOverlay({ snapshot: lastSnapshot, expanded: state.expanded })
  })

  overlayWindow.once('ready-to-show', () => {
    // showInactive, never show(): even the first reveal must not pull key
    // focus from whatever the user is doing. Guarded on enabled because a
    // fast toggle-on→toggle-off can land the disable while the window is
    // still loading — an unguarded reveal would resurrect it.
    if (state.enabled) overlayWindow?.showInactive()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    void overlayWindow.loadFile(join(__dirname, '../renderer/overlay.html'))
  }
}

function sendToOverlay(payload: { snapshot: AgentOverlaySnapshot | null; expanded?: boolean }): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('agent-overlay:state', payload)
  }
}

// ---------------------------------------------------------------------------
// Public API (called from ipc/agentOverlay.ts and main/index.ts)
// ---------------------------------------------------------------------------

export function initAgentOverlay(): void {
  restoreDone = loadPersistedState().then(() => {
    if (state.enabled) createOverlayWindow()
    // Tell the main renderer the restored enabled state so the reporter
    // hook starts publishing without a round-trip race: the renderer also
    // pulls via agent-overlay:get-enabled on mount, but that can resolve
    // before this async restore finishes — the push wins either way.
    sendToMainWindow('agent-overlay:enabled-changed', { enabled: state.enabled })
  })

  // The overlay's lifetime is keyed to the MAIN window, not the app: its
  // data source is the main renderer, so once that closes the overlay
  // could only show frozen state — and a surviving overlay would keep
  // `window-all-closed` (session/service cleanup) from ever firing.
  // destroy(), not close(): nothing in the overlay needs a close
  // ceremony, and destroy is immune to any future close-prevention.
  // Recreation on Dock re-activation goes through syncAgentOverlayWindow.
  onMainWindowClosed(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy()
    overlayWindow = null
  })

  // Quit can arrive inside the persist debounce window; flush so a
  // toggle-then-quit never loses the enabled flag.
  app.on('before-quit', flushPersistNow)

  // Auto-hide while Agent Code itself is focused: the main window already
  // shows richer status everywhere, so the overlay would be pure clutter.
  // Window-level focus events (not app-level) because the overlay must
  // stay up when the user merely switches between OTHER apps.
  //
  // Note the deliberate asymmetry with toggle-on: enabling the overlay
  // while Agent Code is focused still shows it (feedback that the command
  // did something); the auto-hide engages on the NEXT focus cycle.
  app.on('browser-window-focus', (_event, win) => {
    if (!state.enabled) return
    if (win !== overlayWindow) overlayWindow?.hide()
  })
  app.on('browser-window-blur', () => {
    if (!state.enabled) return
    // Blur fires before any successor focus. Defer one tick: if focus
    // moved to another Agent Code window (devtools, main), the focus
    // handler above runs and getFocusedWindow() is non-null here — keep
    // hidden. If the user went to Chrome, nothing is focused — show.
    setTimeout(() => {
      if (!state.enabled || !overlayWindow || overlayWindow.isDestroyed()) return
      if (BrowserWindow.getFocusedWindow() === null) overlayWindow.showInactive()
    }, 80)
  })
}

/** Toggle the overlay on/off. Returns the new enabled state. Awaits the
 *  persisted-state restore so an early palette toggle can never race it
 *  (finding 4) — invoke-based IPC makes the async shape free. */
export async function toggleAgentOverlay(): Promise<boolean> {
  await restoreDone
  state.enabled = !state.enabled
  if (state.enabled) {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
    } else {
      overlayWindow.showInactive()
    }
  } else {
    // Hide, don't destroy: re-toggling is instant and keeps the renderer's
    // measured size/expanded UI state warm. The window dies with the main
    // window (onMainWindowClosed above) or the app.
    overlayWindow?.hide()
  }
  // Synchronous persist, not the debounce: the on/off choice is the one
  // piece of state whose loss the user actually notices after a restart.
  flushPersistNow()
  sendToMainWindow('agent-overlay:enabled-changed', { enabled: state.enabled })
  return state.enabled
}

export async function isAgentOverlayEnabled(): Promise<boolean> {
  await restoreDone
  return state.enabled
}

/**
 * Recreate the overlay window if it should exist but doesn't — called
 * from the macOS `activate` path after the main window is recreated
 * (the overlay was destroyed together with the previous main window).
 */
export function syncAgentOverlayWindow(): void {
  void restoreDone.then(() => {
    if (!state.enabled) return
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow()
  })
}

export function publishAgentOverlaySnapshot(snapshot: AgentOverlaySnapshot): void {
  lastSnapshot = snapshot
  // Forward even while hidden — the overlay re-appears on main-window blur
  // and must already be current at that instant, not one store-change later.
  sendToOverlay({ snapshot })
}

export function persistAgentOverlayExpanded(expanded: boolean): void {
  state.expanded = expanded
  schedulePersist()
}

export function resizeAgentOverlayContent(size: { width: number; height: number }): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const width = Math.round(Math.min(MAX_W, Math.max(MIN_W, size.width)))
  const height = Math.round(Math.min(MAX_H, Math.max(MIN_H, size.height)))
  const [x, y] = overlayWindow.getPosition()
  // resizable:false also blocks programmatic setBounds on some platforms
  // (macOS honors it, Windows historically doesn't — the flag's semantics
  // are user-resize but implementations disagree). Flipping it around the
  // call costs nothing and removes the platform question entirely.
  overlayWindow.setResizable(true)
  // Keep the top-left corner anchored: the window grows down/right when
  // the pill expands into the list, which matches the default top-right
  // placement growing INTO the screen instead of off its top edge —
  // then clamp, so an expand near a screen edge can't push the window
  // (and its only grabbable area) past the work area.
  overlayWindow.setBounds(clampBoundsToDisplay({ x, y, width, height }))
  overlayWindow.setResizable(false)
}
