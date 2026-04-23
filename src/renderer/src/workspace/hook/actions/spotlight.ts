import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'

import type {
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Spotlight mode — focused-pane zoom within the active tab. toggleSpotlight
// enters with the active tab's currently-focused session; exits if already
// on for the active tab. setSpotlightSession switches which session is
// showing inside Spotlight.

export function useSpotlightActions(
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  toggleSpotlight: () => void
  setSpotlightSession: (sessionId: SessionId) => void
} {
  const toggleSpotlight = useCallback(() => {
    const current = refs.stateRef.current
    const activeTab = current.tabs.find(t => t.id === current.activeTabId)
    if (!activeTab) return
    setSpotlight(prev => {
      if (prev?.tabId === activeTab.id) return null
      return {
        tabId: activeTab.id,
        focusedSessionId: activeTab.focusedSessionId,
      }
    })
  }, [refs.stateRef, setSpotlight])

  const setSpotlightSession = useCallback(
    (sessionId: SessionId) => {
      setSpotlight(prev => (prev ? { ...prev, focusedSessionId: sessionId } : prev))
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
        ),
      }))
    },
    [setSpotlight, setState],
  )

  return { toggleSpotlight, setSpotlightSession }
}
