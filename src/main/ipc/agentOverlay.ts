import { ipcMain } from 'electron'

import type {
  AgentOverlaySnapshot,
  OverlayAgentActivity,
  OverlayAgentRow,
} from '@shared/types/agentOverlay.js'
import { focusMainWindow, sendToMainWindow } from '@main/window/mainWindow.js'
import {
  isAgentOverlayEnabled,
  persistAgentOverlayExpanded,
  publishAgentOverlaySnapshot,
  resizeAgentOverlayContent,
  toggleAgentOverlay,
} from '@main/window/overlayWindow.js'

// IPC for the floating agent-status overlay. Three distinct flows share
// the agent-overlay:* prefix — worth keeping straight:
//
//   main renderer → main:   report (snapshot publishing), toggle/get-enabled
//   overlay       → main:   set-expanded, resize, focus-session
//   main → overlay:         agent-overlay:state (sent by overlayWindow.ts,
//                           NOT from here — it goes to the overlay window's
//                           webContents, not through sendToMainWindow)
//   main → main renderer:   enabled-changed, focus-session relay
//
// send (fire-and-forget) vs handle (invoke) split: everything on the hot
// path (snapshot reports, resize on every render) is send — the sender
// never needs an answer and awaiting one would just serialize the stream.

// Runtime bounds for the report payload. The sender is our own renderer,
// but this data crosses the IPC trust boundary, gets CACHED in main
// (lastSnapshot), and is REPLAYED to the overlay window on every load —
// so a malformed or oversized payload wouldn't be a one-off glitch, it
// would be persistent main-process memory and a crash the overlay
// re-triggers on every open. Bound everything; never trust a cast
// (PR #514 review finding 5).
const OVERLAY_ACTIVITIES: ReadonlySet<string> = new Set([
  'starting',
  'working',
  'running',
  'idle',
  'exited',
] satisfies OverlayAgentActivity[])
const MAX_AGENTS = 200
const MAX_THEME_JSON_CHARS = 32_000

function capString(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function sanitizeSnapshot(raw: unknown): AgentOverlaySnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const agentsRaw = (raw as { agents?: unknown }).agents
  if (!Array.isArray(agentsRaw)) return null

  const agents: OverlayAgentRow[] = []
  for (const item of agentsRaw.slice(0, MAX_AGENTS)) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const sessionId = capString(record['sessionId'], 128)
    if (!sessionId) continue
    const activityRaw = record['activity']
    agents.push({
      sessionId,
      title: capString(record['title'], 200) ?? '',
      projectTitle: capString(record['projectTitle'], 120) ?? '',
      pinned: record['pinned'] === true,
      activity:
        typeof activityRaw === 'string' && OVERLAY_ACTIVITIES.has(activityRaw)
          ? (activityRaw as OverlayAgentActivity)
          : 'idle',
      attentionLabel: capString(record['attentionLabel'], 80),
      statusText: capString(record['statusText'], 160),
    })
  }

  // Theme is renderer-owned opaque JSON (see shared/types/agentOverlay.ts)
  // — shape-validate to "plain bounded object" and nothing more; dropping
  // it degrades the overlay to default theme, never to a crash.
  let theme: Record<string, unknown> | null = null
  const themeRaw = (raw as { theme?: unknown }).theme
  if (themeRaw && typeof themeRaw === 'object' && !Array.isArray(themeRaw)) {
    try {
      if (JSON.stringify(themeRaw).length <= MAX_THEME_JSON_CHARS) {
        theme = themeRaw as Record<string, unknown>
      }
    } catch {
      // Circular/unserializable theme → drop it.
    }
  }

  return { agents, theme }
}

export function registerAgentOverlayIpc(): void {
  ipcMain.handle('agent-overlay:toggle', () => toggleAgentOverlay())
  ipcMain.handle('agent-overlay:get-enabled', () => isAgentOverlayEnabled())

  ipcMain.on('agent-overlay:report', (_event, raw: unknown) => {
    const snapshot = sanitizeSnapshot(raw)
    if (snapshot) publishAgentOverlaySnapshot(snapshot)
  })

  ipcMain.on('agent-overlay:set-expanded', (_event, expanded: unknown) => {
    persistAgentOverlayExpanded(expanded === true)
  })

  ipcMain.on('agent-overlay:resize', (_event, size: { width?: unknown; height?: unknown }) => {
    // Defensive narrowing rather than a cast: this arrives from renderer JS
    // and feeds straight into window geometry — NaN here means an invisible
    // or unusable window with no error anywhere.
    const width = typeof size?.width === 'number' && Number.isFinite(size.width) ? size.width : null
    const height = typeof size?.height === 'number' && Number.isFinite(size.height) ? size.height : null
    if (width === null || height === null) return
    resizeAgentOverlayContent({ width, height })
  })

  ipcMain.on('agent-overlay:focus-session', (_event, payload: { sessionId?: unknown }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null
    if (!sessionId) return
    // Main owns the OS-level part (raise + focus the app window); the
    // renderer owns the workspace part (which tab/pane that session lives
    // in) — main has no idea about tabs, so it relays.
    focusMainWindow()
    sendToMainWindow('agent-overlay:focus-session', { sessionId })
  })
}
