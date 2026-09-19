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

export function resolveFocusSurfaceTarget(state: WorkspaceState, explicitSessionId?: SessionId): FocusSurfaceTarget | null {
  const sessionId = explicitSessionId ?? commandTargetSessionIdForState(state)
  if (!sessionId || !state.sessions[sessionId]) return null

  // The index row is asked first because it is what the user sees: a row
  // carries the project it is LISTED under. (Gated on "Dispatch is on" until
  // the stage became a required field, #992.)
  const row = buildVisibleDispatchRows(state).find(item => item.sessionId === sessionId)
  if (row) {
    return { tabId: row.tabId, sessionId }
  }

  // WHY this does an ownership lookup instead of assuming activeTabId: an
  // explicit target (an MCP caller, a Performance Monitor row) can name an
  // agent the index does not list, such as a pinned one. Reader/Spotlight
  // store the OWNING project so their pill lists use the same membership as
  // the index. activeTabId is only a label (U4) and need not name the project
  // the target belongs to.
  const owner = state.tabs.find(tab => resolveTabSessions(state, tab.id).includes(sessionId))
  return owner ? { tabId: owner.id, sessionId } : null
}
