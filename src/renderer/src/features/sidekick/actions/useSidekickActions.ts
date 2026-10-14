import { useCallback, useMemo } from 'react'

import { useAppStore } from '@renderer/app-state/store'
import { sidekickHomeDir, useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import type { Workspace } from '@renderer/workspace/hook'
import type { SessionMeta } from '@renderer/workspace/types'
import type { SidekickAttachResult, SidekickId } from '@shared/sidekicks/types'
import type { AgentProviderKind, AgentProviderRuntime } from '@shared/types/providerKind'

// What the Sidekick panel and picker DO (#1493). The workspace's row actions
// (workspace/hook/actions/sidekick.ts) decide how a row enters or leaves
// `state.sessions`; this module decides when, and talks to main.
//
// "Live here" is never asked of main by window id. It is a fact about this
// window's own state: a window holds a sidekick exactly when its
// `state.sessions` has the row (plan I2). Main's summary says WHETHER some
// window holds it (`liveWindowId`); if one does and this window has no row,
// it is live elsewhere.

export type SidekickPlace =
  | { kind: 'none' }
  | { kind: 'here'; sessionId: string }
  | { kind: 'elsewhere' }
  | { kind: 'asleep' }

export function sidekickPlace(sessions: Record<string, SessionMeta>, sidekickId: SidekickId | null): SidekickPlace {
  if (!sidekickId) return { kind: 'none' }
  for (const [sessionId, meta] of Object.entries(sessions)) {
    if (meta.sidekickId === sidekickId) return { kind: 'here', sessionId }
  }
  const summary = useSidekickIndexStore.getState().view?.sidekicks.find(entry => entry.id === sidekickId)
  if (!summary) return { kind: 'none' }
  return summary.liveWindowId ? { kind: 'elsewhere' } : { kind: 'asleep' }
}

export type CreateSidekickOptions = { kind: AgentProviderKind; providerRuntime?: AgentProviderRuntime }

export type SidekickActions = {
  createSidekick: (options: CreateSidekickOptions) => Promise<SidekickId>
  /** Show a sidekick this window does not hold: attach a sleeping one. */
  showSidekick: (sidekickId: SidekickId) => Promise<SidekickAttachResult | { ok: true; held: true }>
  /** "Open here": move it from the window holding it. */
  openHere: (sidekickId: SidekickId) => Promise<SidekickAttachResult>
  removeSidekick: (sidekickId: SidekickId) => Promise<void>
  /** Handler for `sidekick:released`: drop the row, never kill. */
  onReleased: (event: { sidekickId: SidekickId; sessionId: string }) => void
}

export function useSidekickActions(workspace: Workspace): SidekickActions {
  const createSidekick = useCallback(async ({ kind, providerRuntime }: CreateSidekickOptions): Promise<SidekickId> => {
    const homeDir = sidekickHomeDir()
    if (!homeDir) throw new Error('Sidekicks are still loading; try again in a moment.')
    // Minted HERE so the row can be filed in the same commit spawn's row lands
    // (fileSpawnAsSidekick below). Main validates it and refuses a collision.
    const sidekickId = crypto.randomUUID()
    // spawn resolves a Hermes connection itself (remote kinds only), and main
    // claims the new session's lease for THIS window at id-mint time — which
    // is exactly the precondition register checks.
    const sessionId = await workspace.spawn(homeDir, { kind, providerRuntime })
    workspace.fileSpawnAsSidekick(sessionId, sidekickId)
    const meta = latestSessionMeta(sessionId)
    const registered = await window.api.registerSidekick({ id: sidekickId, sessionId, meta })
    if (!registered.ok) {
      // The process is running but nothing durable names it. Retire it rather
      // than leave an agent no picker can ever reach again.
      await workspace.killSession(sessionId, 'sidekick.register-failed').catch(() => undefined)
      workspace.releaseSidekickRow(sessionId)
      throw new Error(`Could not save the sidekick: ${registered.reason}`)
    }
    workspace.setSidekickPanel({ open: true, sidekickId })
    return sidekickId
  }, [workspace])

  const adoptAndWake = useCallback(async (result: SidekickAttachResult): Promise<SidekickAttachResult> => {
    if (!result.ok) return result
    const { record } = result
    const meta = record.meta as SessionMeta | null
    if (!meta || typeof meta !== 'object') return { ok: false, reason: 'not-found' }
    workspace.adoptSidekickRow(record.sessionId, { ...meta, sidekickId: record.id }, record.draft)
    // WHY wake through the ordinary path: session:recover from the holder
    // adopts a live backend after a move (kind/runtime/cwd match the record),
    // or cold-starts a sleeping one under the same local id with its native
    // resume id. Either way the pane sees exactly what a parked lane agent
    // sees when it is selected.
    await workspace.ensureSessionLive(record.sessionId, 'sidekick.attach').catch(() => undefined)
    // A moved backend may sit on a permission or a question; re-emit its
    // cached conditions to this, the new holder (session:reseed-conditions).
    await window.api.reseedSessionConditions([record.sessionId]).catch(() => 0)
    return result
  }, [workspace])

  const showSidekick = useCallback(async (sidekickId: SidekickId) => {
    const place = sidekickPlace(liveSessions(), sidekickId)
    if (place.kind === 'here') return { ok: true as const, held: true as const }
    return await adoptAndWake(await window.api.attachSidekick(sidekickId))
  }, [adoptAndWake, workspace])

  const openHere = useCallback(async (sidekickId: SidekickId) => {
    return await adoptAndWake(await window.api.takeSidekick(sidekickId))
  }, [adoptAndWake])

  const removeSidekick = useCallback(async (sidekickId: SidekickId) => {
    const place = sidekickPlace(liveSessions(), sidekickId)
    // Main kills with its own authority, from any window; this window only
    // drops its row afterwards (and main's `released` would do it too).
    const result = await window.api.removeSidekick(sidekickId)
    if (!result.ok) throw new Error(`Could not remove the sidekick: ${result.reason}`)
    if (place.kind === 'here') workspace.releaseSidekickRow(place.sessionId)
    const panel = useAppStore.getState().workspaceState.sidekickPanel
    if (panel?.sidekickId === sidekickId) {
      const next = useSidekickIndexStore.getState().view?.sidekicks
        .filter(entry => entry.id !== sidekickId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
      workspace.setSidekickPanel({ sidekickId: next?.id ?? null })
    }
  }, [workspace])

  const onReleased = useCallback((event: { sidekickId: SidekickId; sessionId: string }) => {
    // Keep the panel pointer: the panel now shows "Live in another window"
    // (or picks another sidekick if this one was removed — the index view
    // update handles that, see SidekickPanel).
    workspace.releaseSidekickRow(event.sessionId)
  }, [workspace])

  return useMemo(() => ({ createSidekick, showSidekick, openHere, removeSidekick, onReleased }), [
    createSidekick, showSidekick, openHere, removeSidekick, onReleased,
  ])
}

/**
 * The row as committed so far. WHY not `workspace.state`: the Workspace
 * object is a render-time snapshot, and spawn + fileSpawnAsSidekick committed
 * after it was taken. The app store is the live source.
 */
function liveSessions(): Record<string, SessionMeta> {
  return useAppStore.getState().workspaceState.sessions
}

function latestSessionMeta(sessionId: string): SessionMeta | null {
  return useAppStore.getState().workspaceState.sessions[sessionId] ?? null
}
