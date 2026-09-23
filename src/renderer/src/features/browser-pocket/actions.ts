import { isAgentSessionKind } from '@shared/types/providerKind'
import { DEVICE_PRESETS } from '@shared/browserPocket/devices'
import type { BrowserPocketConfig, SessionId, WorkspaceState } from '@renderer/workspace/types'

// Pure transforms over WorkspaceState for the browser pocket.
//
// WHY pure functions instead of workspace-hook callbacks: the same rules are
// needed by commands, by main's "agent asked to open its pocket" relay, by the
// chrome row and by tests, and a pure transform is testable against the
// recorded workspace files without the hook harness. Callers wrap them in
// `workspace.setState(s => …)`.
//
// Every transform returns the SAME object when nothing changes, so a no-op
// never triggers an autosave or a React render.

export const defaultMint = () => crypto.randomUUID()

export const MIN_SPLIT = 0.2
export const MAX_SPLIT = 0.8

function withPocket(state: WorkspaceState, sessionId: SessionId, update: (p: BrowserPocketConfig) => BrowserPocketConfig): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta?.browserPocket) return state
  const next = update(meta.browserPocket)
  if (next === meta.browserPocket) return state
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...meta, browserPocket: next } } }
}

/** A pocket may attach only to an agent: a terminal's dev server is found
 * through the agent's lane instead (spec §7.2), and extension views are not
 * web content. */
export function canHavePocket(state: WorkspaceState, sessionId: SessionId): boolean {
  const meta = state.sessions[sessionId]
  return Boolean(meta && isAgentSessionKind(meta.kind ?? 'claude'))
}

export function attachPocket(
  state: WorkspaceState,
  sessionId: SessionId,
  init?: { url?: string; view?: 'open' | 'collapsed' },
  mintId: () => string = defaultMint,
): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta || !canHavePocket(state, sessionId)) return state
  const existing = meta.browserPocket
  if (existing) {
    // Re-attaching never re-mints: a new pocketId would be a new, empty
    // cookie jar and a reloaded page.
    const url = init?.url ?? existing.url
    const view = init?.view ?? existing.view
    if (url === existing.url && view === existing.view) return state
    return { ...state, sessions: { ...state.sessions, [sessionId]: { ...meta, browserPocket: { ...existing, ...(url ? { url } : {}), view } } } }
  }
  const pocket: BrowserPocketConfig = {
    pocketId: mintId(),
    ...(init?.url ? { url: init.url } : {}),
    view: init?.view ?? 'open',
    profile: 'lane',
  }
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...meta, browserPocket: pocket } } }
}

export function detachPocket(state: WorkspaceState, sessionId: SessionId): WorkspaceState {
  const meta = state.sessions[sessionId]
  if (!meta?.browserPocket) return state
  const { browserPocket: _removed, ...rest } = meta
  return { ...state, sessions: { ...state.sessions, [sessionId]: rest } }
}

export const setPocketView = (state: WorkspaceState, sessionId: SessionId, view: 'open' | 'collapsed') =>
  withPocket(state, sessionId, p => (p.view === view ? p : { ...p, view }))

export const setPocketUrl = (state: WorkspaceState, sessionId: SessionId, url: string) =>
  withPocket(state, sessionId, p => (p.url === url ? p : { ...p, url }))

export const setPocketSplit = (state: WorkspaceState, sessionId: SessionId, split: number) =>
  withPocket(state, sessionId, p => {
    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Number.isFinite(split) ? split : 0.5))
    // Round so a drag does not write a new float to disk on every pixel.
    const rounded = Math.round(clamped * 100) / 100
    return p.split === rounded ? p : { ...p, split: rounded }
  })

export function setPocketProfile(state: WorkspaceState, sessionId: SessionId, profile: 'lane' | 'project'): WorkspaceState {
  return withPocket(state, sessionId, p => (p.profile === profile ? p : { ...p, profile }))
}

export function setPocketViewport(state: WorkspaceState, sessionId: SessionId, viewport: NonNullable<BrowserPocketConfig['viewport']>): WorkspaceState {
  if (viewport.mode === 'preset' && !(viewport.preset in DEVICE_PRESETS)) return state
  if (viewport.mode === 'free' && !(viewport.width >= 200 && viewport.width <= 4000 && viewport.height >= 200 && viewport.height <= 4000)) return state
  return withPocket(state, sessionId, p => (viewport.mode === 'fill' ? stripKey(p, 'viewport') : { ...p, viewport }))
}

export function setPocketColorScheme(state: WorkspaceState, sessionId: SessionId, scheme: 'light' | 'dark' | 'system'): WorkspaceState {
  return withPocket(state, sessionId, p => (scheme === 'system' ? stripKey(p, 'colorScheme') : p.colorScheme === scheme ? p : { ...p, colorScheme: scheme }))
}

export function setPocketZoom(state: WorkspaceState, sessionId: SessionId, zoom: number | null): WorkspaceState {
  return withPocket(state, sessionId, p => {
    if (zoom === null || Math.abs(zoom - 1) < 0.01) return stripKey(p, 'zoom')
    const clamped = Math.round(Math.min(3, Math.max(0.3, zoom)) * 100) / 100
    return p.zoom === clamped ? p : { ...p, zoom: clamped }
  })
}

/** Absent → attach open; open ↔ collapsed. What ⌘⇧B does. */
export function togglePocket(state: WorkspaceState, sessionId: SessionId, mintId: () => string = defaultMint): WorkspaceState {
  const pocket = state.sessions[sessionId]?.browserPocket
  if (!pocket) return attachPocket(state, sessionId, { view: 'open' }, mintId)
  return setPocketView(state, sessionId, pocket.view === 'open' ? 'collapsed' : 'open')
}

function stripKey<K extends keyof BrowserPocketConfig>(p: BrowserPocketConfig, key: K): BrowserPocketConfig {
  if (!(key in p)) return p
  const { [key]: _gone, ...rest } = p
  return rest as BrowserPocketConfig
}
