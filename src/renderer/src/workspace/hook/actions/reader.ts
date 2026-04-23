import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// ReaderMode toggle. Mirrors toggleSpotlight: enters with the active
// tab's currently-focused session, exits if already on for the active
// tab. Closes Spotlight on entry; tile-tabs are preserved in state
// and suppressed by App.tsx render precedence.

export function useReaderActions(
  setReaderMode: WorkspaceSetReaderMode,
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  toggleReaderMode: () => void
  setReaderModeSession: (sessionId: SessionId) => void
} {
  const toggleReaderMode = useCallback(() => {
    const current = refs.stateRef.current
    const activeTab = current.tabs.find(t => t.id === current.activeTabId)
    if (!activeTab) return
    setSpotlight(null)
    setReaderMode(prev => {
      if (prev?.tabId === activeTab.id) return null
      return {
        tabId: activeTab.id,
        focusedSessionId: activeTab.focusedSessionId,
      }
    })
  }, [refs.stateRef, setReaderMode, setSpotlight])

  // Switch which session is being read inside ReaderMode. Mirrors
  // setSpotlightSession exactly — also updates the tab's
  // focusedSessionId so leaving Reader returns to that pane.
  const setReaderModeSession = useCallback(
    (sessionId: SessionId) => {
      setReaderMode(prev => (prev ? { ...prev, focusedSessionId: sessionId } : prev))
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
        ),
      }))
    },
    [setReaderMode, setState],
  )

  return { toggleReaderMode, setReaderModeSession }
}
