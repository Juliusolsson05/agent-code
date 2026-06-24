import {
  buildVisibleDispatchRows,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, TabId, WorkspaceState } from '@renderer/workspace/types'

export type FocusSurfaceTarget = {
  tabId: TabId
  sessionId: SessionId
}

export function resolveFocusSurfaceTarget(state: WorkspaceState): FocusSurfaceTarget | null {
  const sessionId = commandTargetSessionIdForState(state)
  if (!sessionId || !state.sessions[sessionId]) return null

  if (state.dispatchMode) {
    const row = buildVisibleDispatchRows(state).find(item => item.sessionId === sessionId)
    if (row) {
      return { tabId: row.tabId, sessionId }
    }
  }

  // WHY this does an ownership lookup instead of assuming activeTabId:
  // focus-takeover commands are wired to commandTargetSessionIdForState, which
  // can legitimately resolve a visible grid-related child instead of the
  // physical tab leaf. That child is usually detached and owned by the same
  // project tab via projectTabId. Reader/Spotlight store the owner tab id so
  // their pill lists use the same membership model as the normal workspace
  // surfaces; activeTabId is only a layout pointer and is stale in several
  // Dispatch/Tiled Dispatch flows.
  const owner = state.tabs.find(tab => resolveTabSessions(state, tab.id).includes(sessionId))
  return owner ? { tabId: owner.id, sessionId } : null
}
