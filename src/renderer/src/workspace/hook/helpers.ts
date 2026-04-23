import { useCallback } from 'react'

import { emptyRuntime, type SessionRuntime } from '../workspaceState'
import type { SessionId } from '../types'
import {
  appendFeedDebugLog,
  type FeedDebugInput,
} from '../runtime/feedDebug'
import { withDerivedSessionStatus } from '../semantic/helpers'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from './context'
import type { WorkspaceRefs } from './refs'

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
    const tab = snap.tabs.find(t => t.id === snap.activeTabId)
    const sessionId = tab?.focusedSessionId
    if (!sessionId) return
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      return {
        ...prev,
        [sessionId]: {
          ...current,
          scrollToLatestRequest: current.scrollToLatestRequest + 1,
        },
      }
    })
  }, [refs.stateRef, setRuntimes])

  return {
    updateRuntime,
    appendFeedDebug,
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
