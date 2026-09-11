import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  buildVisibleDispatchRows,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveFocusSurfaceTarget } from '@renderer/workspace/hook/actions/focusSurfaceTarget'
import { sessionHasTranscript } from '@renderer/workspace/transcriptAvailability'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// ReaderMode toggle. Mirrors toggleSpotlight: enters with the same command
// target the palette/keybind layer exposes, exits whenever Reader is already
// open. Closes Spotlight on entry; tile-tabs are preserved in state and
// suppressed by App.tsx render precedence.

export function useReaderActions(
  setReaderMode: WorkspaceSetReaderMode,
  setSpotlight: WorkspaceSetSpotlight,
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
): {
  setReaderModeTarget: (sessionId: SessionId | null) => boolean
  toggleReaderMode: () => void
  setReaderModeSession: (sessionId: SessionId) => void
} {
  // Explicit desired state lets command clients select a non-focused agent
  // without a focus-then-toggle race. Ownership uses the same placement query
  // as UI toggles, including detached and related sessions.
  const setReaderModeTarget = useCallback((sessionId: SessionId | null) => {
    if (sessionId === null) { setReaderMode(null); return true }
    const current = refs.stateRef.current
    const target = resolveFocusSurfaceTarget(current, sessionId)
    if (!target) return false
    if (!isAgentProviderKind(current.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER)) return false
    setSpotlight(null)
    setState(prev => ({ ...prev, activeTabId: target.tabId }))
    setReaderMode({ tabId: target.tabId, focusedSessionId: sessionId })
    return true
  }, [refs.stateRef, setReaderMode, setState, setSpotlight])

  const toggleReaderMode = useCallback(() => {
    const current = refs.stateRef.current
    const target = resolveFocusSurfaceTarget(current)
    setSpotlight(null)
    setReaderMode(prev => {
      if (prev) return null
      if (!target) return prev
      const kind = current.sessions[target.sessionId]?.kind ?? DEFAULT_PROVIDER
      // Reader Mode reads the pane's committed transcript through the
      // provider-registered renderer/extractor. Registry membership — not a
      // hardcoded pair — is the correct predicate: every registered
      // AgentProviderKind ships a transcript view (see
      // src/providers/<kind>/renderer/), so OpenCode is just as valid a
      // Reader target as Claude or Codex.
      if (!isAgentProviderKind(kind)) return prev
      return {
        tabId: target.tabId,
        focusedSessionId: target.sessionId,
      }
    })
  }, [refs.stateRef, setReaderMode, setSpotlight])

  // Switch which session is being read inside ReaderMode.
  //
  // WHY Dispatch mode is special here: detached sessions are not tile-tree
  // leaves, and Tab.focusedSessionId is a grid-only invariant. The original
  // Reader implementation wrote every selected reader session into
  // Tab.focusedSessionId, which corrupts the tab whenever the selected row is
  // detached. In Dispatch, keep focus on dispatchMode.focusedSessionId and
  // activeTabId instead; outside Dispatch, preserve the older grid behavior.
  const setReaderModeSession = useCallback(
    (sessionId: SessionId) => {
      const snapshot = refs.stateRef.current
      // WHY this needs the same guard as setReaderModeTarget/toggleReaderMode
      // (#865): Reader Mode is agent-only by design (Design D2) because it
      // renders a provider-registered transcript view, and a terminal has no
      // such view. Those two siblings already refuse a non-agent kind before
      // touching state; this one — the "switch which session Reader is
      // showing" entry point — did not, so it was relying only on ReaderView's
      // own filter to keep a terminal off screen. That filter is a rendering
      // accident, not a contract: any caller reaching this action directly
      // (e.g. the external operator's agents.show, which after #865 no longer
      // refuses terminals for placement/metadata capabilities) could point
      // Reader Mode at a session it cannot render. Refuse without changing
      // reader state, exactly like the siblings.
      //
      // WHY sessionHasTranscript instead of isAgentProviderKind (M5): the two
      // predicates diverged. isAgentProviderKind admits OpenCode Terminal
      // (kind 'opencode', providerRuntime 'terminal') — it IS an agent-kind
      // session — but it never loads a transcript (see
      // transcriptAvailability.ts's WHY), so Reader would accept it here and
      // then render nothing. readerCommands.ts already gates on
      // sessionHasTranscript for the same reason; this guard must agree with
      // its own command's own visibility rule.
      if (!sessionHasTranscript(snapshot.sessions[sessionId])) return
      const rows = snapshot.dispatchMode
        ? buildVisibleDispatchRows(snapshot)
        : []
      const dispatchRow = rows.find(row => row.sessionId === sessionId) ?? null
      setReaderMode(prev => (
        prev
          ? {
              ...prev,
              tabId: dispatchRow?.tabId ?? prev.tabId,
              focusedSessionId: sessionId,
            }
          : prev
      ))
      setState(prev => {
        // Tab.focusedSessionId is a grid-only field (its invariant:
        // must be a leaf in `tab.root`). Non-Dispatch Reader now
        // surfaces detached agents in its session list (via
        // resolveTabSessions), so a detached id can reach this
        // handler. The pre-existing comment above already explained
        // the Dispatch case; the same reasoning applies to detached
        // sessions clicked from a non-Dispatch Reader view — only
        // mirror to focusedSessionId when the id is actually a leaf.
        // For a detached selection, Reader's own focusedSessionId
        // holds the choice; we don't need to (and must not) mirror
        // it to the grid-only field.
        const activeTab = prev.tabs.find(t => t.id === prev.activeTabId) ?? null
        const isGridLeaf = activeTab ? collectLeaves(activeTab.root).includes(sessionId) : false
        return {
          ...prev,
          activeTabId: dispatchRow?.tabId ?? prev.activeTabId,
          dispatchMode: prev.dispatchMode && dispatchRow
            ? { ...prev.dispatchMode, focusedSessionId: sessionId }
            : prev.dispatchMode,
          tabs: prev.dispatchMode
            ? prev.tabs
            : prev.tabs.map(t =>
                t.id === prev.activeTabId && isGridLeaf
                  ? { ...t, focusedSessionId: sessionId }
                  : t,
              ),
        }
      })
    },
    [refs.stateRef, setReaderMode, setState],
  )

  return { setReaderModeTarget, toggleReaderMode, setReaderModeSession }
}
