import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
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
  // WHY this never writes a lane or a tree focus: Reader is a takeover with its
  // own focusedSessionId. The original implementation mirrored every selection
  // into Tab.focusedSessionId, which corrupted the tab whenever the selected
  // row was not a tree leaf; the Dispatch-era fix moved the mirror to a classic
  // focus field. Both fields are gone (#992) and nothing replaces them.
  const setReaderModeSession = useCallback(
    (sessionId: SessionId) => {
      const snapshot = refs.stateRef.current
      // WHY this needs a guard like setReaderModeTarget/toggleReaderMode's
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
      // reader state — on the same transcript predicate the command surface
      // uses, so visibility and this direct-entry guard cannot disagree (see
      // the M5 note below for how that predicate evolved).
      //
      // WHY sessionHasTranscript instead of isAgentProviderKind (M5): the two
      // predicates used to diverge — isAgentProviderKind admits sessions with
      // no entries at all, and sessionHasTranscript existed to name that
      // difference. Since #971 they agree on OpenCode Terminal (its committed
      // entries load per #882, and Reader renders them as an overlay), so the
      // remaining gap this guard closes is a plain terminal slipping in
      // directly. readerCommands.ts gates on sessionHasTranscript for the same
      // reason; this guard must agree with its own command's own visibility
      // rule.
      if (!sessionHasTranscript(snapshot.sessions[sessionId])) return
      const rows = buildVisibleDispatchRows(snapshot)
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
      // Only the active PROJECT follows the Reader selection; see the matching
      // note in spotlight.ts. Reader holds its own focusedSessionId, and
      // paging through transcripts is not the user naming a lane occupant
      // (U2, #681), so no lane — and no tree focus, which no longer exists —
      // is written here.
      setState(prev => {
        const activeTabId = dispatchRow?.tabId ?? prev.activeTabId
        return activeTabId === prev.activeTabId ? prev : { ...prev, activeTabId }
      })
    },
    [refs.stateRef, setReaderMode, setState],
  )

  return { setReaderModeTarget, toggleReaderMode, setReaderModeSession }
}
