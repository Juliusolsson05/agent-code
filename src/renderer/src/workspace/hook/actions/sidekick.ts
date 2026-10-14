import { useCallback } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import { fileSessionAsSidekick } from '@renderer/workspace/pool'
import { DEFAULT_SIDEKICK_PANEL } from '@renderer/workspace/sidekickPanel'
import type { SessionId, SessionMeta, SidekickPanelState } from '@renderer/workspace/types'

// Workspace writes for Sidekick rows and the panel pointer (#1493).
//
// WHY these live in the workspace hook and not the sidekick feature: they are
// the ONLY code that puts a sidekick row into, or takes one out of,
// `state.sessions`, and `state.sessions` is the workspace's. Keeping every
// writer of a membership fact in one module is the rule pool.ts states for
// projects ("the NEXT fact a filing or a removal has to maintain gets added
// in one place"). The feature (features/sidekick) decides WHEN; these decide
// HOW, and nothing else in the renderer writes a `sidekickId`.

export type SidekickRowActions = {
  /** File spawn's freshly written row as a sidekick, in one commit (I4). */
  fileSpawnAsSidekick: (sessionId: SessionId, sidekickId: string) => void
  /**
   * Insert the row a sidekick record describes, when this window has just
   * become its holder (attach or take). `draft` restores the composer.
   * A row already present is left alone: the holder's live row is newer than
   * any record main returns.
   */
  adoptSidekickRow: (sessionId: SessionId, meta: SessionMeta, draft?: string) => void
  /**
   * Drop a sidekick row WITHOUT killing its process: main moved the sidekick
   * to another window, or removed it and already killed the process. Never a
   * pane close — closeSession refuses sidekick rows on purpose, so no Undo
   * entry, no kill and no project bookkeeping can run for one.
   */
  releaseSidekickRow: (sessionId: SessionId) => void
  /** Patch this window's panel pointer (open, width, shown sidekick). */
  setSidekickPanel: (patch: Partial<SidekickPanelState>) => void
}

export function useSidekickRowActions(
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
): SidekickRowActions {
  const fileSpawnAsSidekick = useCallback((sessionId: SessionId, sidekickId: string) => {
    setState(prev => {
      const sessions = fileSessionAsSidekick(prev.sessions, sessionId, sidekickId)
      return sessions === prev.sessions ? prev : { ...prev, sessions }
    })
  }, [setState])

  const adoptSidekickRow = useCallback((sessionId: SessionId, meta: SessionMeta, draft?: string) => {
    if (!meta.sidekickId) return
    setState(prev => {
      if (prev.sessions[sessionId]) return prev
      // Strip any project membership a malformed record might carry: a row is
      // never both (types.ts sidekickId invariant).
      const { projectId: _projectId, joinedAt: _joinedAt, ...row } = meta
      return { ...prev, sessions: { ...prev.sessions, [sessionId]: row } }
    })
    setRuntimes(prev => {
      if (prev[sessionId]) return prev
      return { ...prev, [sessionId]: { ...emptyRuntime(), ...(draft ? { draftInput: draft } : {}) } }
    })
  }, [setRuntimes, setState])

  const releaseSidekickRow = useCallback((sessionId: SessionId) => {
    setState(prev => {
      const meta = prev.sessions[sessionId]
      if (!meta?.sidekickId) return prev
      const { [sessionId]: _released, ...sessions } = prev.sessions
      return {
        ...prev,
        sessions,
        // Defensive: guards keep a sidekick out of pins (I5), but a pointer
        // into a row this window no longer holds must never survive the drop.
        pinnedSessionIds: prev.pinnedSessionIds.filter(id => id !== sessionId),
      }
    })
    setRuntimes(prev => {
      if (!prev[sessionId]) return prev
      const { [sessionId]: _released, ...rest } = prev
      return rest
    })
  }, [setRuntimes, setState])

  const setSidekickPanel = useCallback((patch: Partial<SidekickPanelState>) => {
    setState(prev => {
      const current = prev.sidekickPanel ?? DEFAULT_SIDEKICK_PANEL
      const next = { ...current, ...patch }
      if (next.open === current.open && next.width === current.width && next.sidekickId === current.sidekickId && prev.sidekickPanel) return prev
      return { ...prev, sidekickPanel: next }
    })
  }, [setState])

  return { fileSpawnAsSidekick, adoptSidekickRow, releaseSidekickRow, setSidekickPanel }
}
