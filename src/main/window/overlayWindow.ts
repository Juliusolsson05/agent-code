import { app, BrowserWindow, screen } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import type { AgentOverlaySnapshot } from '@shared/types/agentOverlay.js'
import { STATE_DIR } from '@main/storage/paths.js'
import { sendToMainWindow } from '@main/window/mainWindow.js'

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

function createOverlayWindow(): void {
  const pos = state.position ?? defaultPosition()
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
      // Same runtime-relative preload path as the main window — and the
      // same trap: this is a filesystem path resolved at runtime from
      // out/main/, NOT a vite alias. See the long comment in
      // mainWindow.ts before "fixing" it.
      preload: join(__dirname, '../preload/index.mjs'),
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

  overlayWindow.webContents.on('did-finish-load', () => {
    // Initial state push: cached snapshot + persisted expanded mode.
    // `expanded` is intentionally ONLY sent here — see AgentOverlayStateEvent.
    sendToOverlay({ snapshot: lastSnapshot, expanded: state.expanded })
  })

  overlayWindow.once('ready-to-show', () => {
    // showInactive, never show(): even the first reveal must not pull key
    // focus from whatever the user is doing.
    overlayWindow?.showInactive()
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
  void loadPersistedState().then(() => {
    if (state.enabled) createOverlayWindow()
    // Tell the main renderer the restored enabled state so the reporter
    // hook starts publishing without a round-trip race: the renderer also
    // pulls via agent-overlay:get-enabled on mount, but that can resolve
    // before this async restore finishes — the push wins either way.
    sendToMainWindow('agent-overlay:enabled-changed', { enabled: state.enabled })
  })

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

/** Toggle the overlay on/off. Returns the new enabled state. */
export function toggleAgentOverlay(): boolean {
  state.enabled = !state.enabled
  if (state.enabled) {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow()
    } else {
      overlayWindow.showInactive()
    }
  } else {
    // Hide, don't destroy: re-toggling is instant and keeps the renderer's
    // measured size/expanded UI state warm. The window dies with the app.
    overlayWindow?.hide()
  }
  schedulePersist()
  sendToMainWindow('agent-overlay:enabled-changed', { enabled: state.enabled })
  return state.enabled
}

export function isAgentOverlayEnabled(): boolean {
  return state.enabled
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
  // placement growing INTO the screen instead of off its top edge.
  overlayWindow.setBounds({ x, y, width, height })
  overlayWindow.setResizable(false)
}
