import { useCallback } from 'react'

import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId } from '@renderer/workspace/types'
import {
  appendFeedDebugLog,
  type FeedDebugInput,
} from '@renderer/workspace/runtime/feedDebug'
import { withDerivedSessionStatus } from '@renderer/workspace/semantic/helpers'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// -----------------------------------------------------------------------------
// Cross-cutting runtime helpers
//
// updateRuntime / appendFeedDebug / getRuntime / toggleTailMode /
// scrollFocusedToLatest are used by many other actions and live here
// so every sub-hook can consume them through the context without
// re-declaring them.
// -----------------------------------------------------------------------------

export function useWorkspaceHelpers(
  runtimes: Record<SessionId, SessionRuntime>,
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
): {
  updateRuntime: (sessionId: SessionId, patch: Partial<SessionRuntime>) => void
  appendFeedDebug: (sessionId: SessionId, input: FeedDebugInput) => void
  acknowledgeSession: (sessionId: SessionId) => void
  getRuntime: (sessionId: SessionId) => SessionRuntime
  toggleTailMode: (sessionId: SessionId) => void
  scrollFocusedToLatest: () => void
} {
  const updateRuntime = useCallback(
    (sessionId: SessionId, patch: Partial<SessionRuntime>) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        return {
          ...prev,
          [sessionId]: withDerivedSessionStatus({ ...current, ...patch }),
        }
      })
    },
    [setRuntimes],
  )

  const appendFeedDebug = useCallback(
    (sessionId: SessionId, input: FeedDebugInput) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = appendFeedDebugLog(current, input)
        if (next === current) return prev
        return {
          ...prev,
          [sessionId]: next,
        }
      })
    },
    [setRuntimes],
  )

  const acknowledgeSession = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current || (current.unreadSince === null && current.unreadKind === null)) return prev
        return {
          ...prev,
          [sessionId]: {
            ...current,
            unreadSince: null,
            unreadKind: null,
          },
        }
      })
    },
    [setRuntimes],
  )

  const getRuntime = useCallback(
    (sessionId: SessionId): SessionRuntime => {
      return runtimes[sessionId] ?? emptyRuntime()
    },
    [runtimes],
  )

  const toggleTailMode = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        return {
          ...prev,
          [sessionId]: {
            ...current,
            tailMode: !current.tailMode,
          },
        }
      })
    },
    [setRuntimes],
  )

  const scrollFocusedToLatest = useCallback(() => {
    const snap = refs.stateRef.current
    // WHY command-target instead of tab.focusedSessionId:
    //
    // In Dispatch Mode the visible row may be a detached session (no
    // tile-tree placement at all) or a grid row that didn't mutate
    // tab.focusedSessionId. Reading tab.focusedSessionId here would
    // scroll the underlying grid pane while the user expects "End" /
    // Jump-to-Latest to act on the row they see highlighted in the
    // Dispatch list. commandTargetSessionIdForState routes through the
    // same row-derived selector the palette and provider actions use,
    // so all "act on the visible thing" commands agree.
    const sessionId = commandTargetSessionIdForState(snap)
    if (!sessionId) return
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      return {
        ...prev,
        [sessionId]: {
          ...current,
          unreadSince: null,
          unreadKind: null,
          scrollToLatestRequest: current.scrollToLatestRequest + 1,
        },
      }
    })
  }, [refs.stateRef, setRuntimes])

  return {
    updateRuntime,
    appendFeedDebug,
    acknowledgeSession,
    getRuntime,
    toggleTailMode,
    scrollFocusedToLatest,
  }
}

// -----------------------------------------------------------------------------
// Pane toast — declared here instead of actions/toast.ts because many
// actions want to show a toast and the helpers+toast pair is atomic
// enough to stay together.
// -----------------------------------------------------------------------------

export function usePaneToast(
  paneToastTimers: WorkspaceRefs['paneToastTimers'],
  updateRuntime: (id: SessionId, patch: Partial<SessionRuntime>) => void,
): (sessionId: SessionId, message: string, durationMs?: number) => void {
  // Single-slot, auto-dismiss. Calling showPaneToast while a previous
  // toast is still visible replaces it and resets the timer. The
  // timeout ref lives outside React state so we can clear it without
  // causing a re-render.
  return useCallback(
    (sessionId: SessionId, message: string, durationMs = 2000) => {
      // Clear any in-flight timer for this pane.
      const prev = paneToastTimers.current[sessionId]
      if (prev) clearTimeout(prev)

      updateRuntime(sessionId, { paneToast: message })

      paneToastTimers.current[sessionId] = setTimeout(() => {
        updateRuntime(sessionId, { paneToast: null })
        delete paneToastTimers.current[sessionId]
      }, durationMs)
    },
    [paneToastTimers, updateRuntime],
  )
}

// Re-export so callers that want to apply state setters through a
// provided updater without reimporting here can chain cleanly.
export function applyRuntimeUpdate<T>(prev: T, next: T | ((prev: T) => T)): T {
  return typeof next === 'function'
    ? (next as (prev: T) => T)(prev)
    : next
}
