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
  buildVisibleDispatchRows,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { dispatchFocusedSessionId } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { selectedGridRelatedSessionId } from '@renderer/workspace/gridRelatedAgents'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

export function commandTargetSessionId(workspace: Workspace): string | null {
  return commandTargetSessionIdForState(workspace.state)
}

export function commandTargetSessionIdForState(state: WorkspaceState): SessionId | null {
  const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
  if (!state.dispatchMode) {
    // WHY grid related selection participates in command targeting:
    // the physical tile focus must remain the parent leaf, but once the pane is
    // visibly rendering a related child, global commands like reload/close/copy
    // need to act on the same session the composer is commanding. The selector
    // validates the child against current relationship state and falls back to
    // the parent if the child was closed or detached elsewhere.
    return selectedGridRelatedSessionId(
      state,
      activeTab?.id ?? state.activeTabId,
      activeTab?.focusedSessionId,
    )
  }

  // dispatchFocusedSessionId is the single tiled-aware reader: the focused
  // lane's agent in Tiled Dispatch (falling back to classic focus when the
  // lane is empty), else dispatchMode.focusedSessionId. Passing it — not the
  // raw dispatchMode.focusedSessionId — is what makes View Prompts / Reload /
  // Close / provider switch / debug panels target the lane the user actually
  // has focused instead of falling through to rows[0] (the first tile).
  // Classic Dispatch is byte-for-byte unchanged (the helper returns
  // dispatchMode.focusedSessionId when there is no `tiled`).
  const rows = buildVisibleDispatchRows(state)
  return selectVisibleDispatchRow(
    rows,
    dispatchFocusedSessionId(state.dispatchMode),
    activeTab?.focusedSessionId,
  )?.sessionId ?? null
}
