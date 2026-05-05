// Single source of truth for "which session is the user currently
// commanding?" — a Dispatch-aware focus reader.
//
// WHY this is its own file:
//
//   The detached-sessions model split focus into two fields. Tab.focusedSessionId
//   is grid-only (it has a hard "must be a leaf in tab.root" invariant) and
//   drives reader, spotlight, resize, split, duplicate, and bury. Dispatch
//   selection lives on dispatchMode.focusedSessionId and can point at a
//   detached session that has no tile-tree placement at all.
//
//   Most lifecycle commands (close, kill, provider replace, copy assistant,
//   prompt template) want "whatever the user is visibly commanding right now"
//   regardless of which surface is on screen. Reading tab.focusedSessionId
//   directly silently ignores Dispatch selection; reading
//   dispatchMode.focusedSessionId directly silently ignores grid focus when
//   Dispatch is off. Importing this helper documents the intent — call sites
//   that use this file are saying "I work on detached AND grid sessions",
//   while call sites that read tab.focusedSessionId directly are explicitly
//   declaring "I am grid-only."
//
//   Keep that distinction visible in the diff. Don't fold this into
//   useWorkspace as a derived getter that everything reads automatically;
//   the explicit import is the documentation.

import {
  buildDispatchGroups,
  flattenDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

export function commandTargetSessionId(workspace: Workspace): string | null {
  return commandTargetSessionIdForState(workspace.state)
}

export function commandTargetSessionIdForState(state: WorkspaceState): SessionId | null {
  const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
  if (!state.dispatchMode) return activeTab?.focusedSessionId ?? null

  const rows = flattenDispatchRows(buildDispatchGroups(state))
  return selectVisibleDispatchRow(
    rows,
    state.dispatchMode.focusedSessionId,
    activeTab?.focusedSessionId,
  )?.sessionId ?? null
}
