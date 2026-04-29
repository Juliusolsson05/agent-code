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

import type { Workspace } from '@renderer/workspace/workspaceStore'

export function commandTargetSessionId(workspace: Workspace): string | null {
  return (
    workspace.dispatchMode?.focusedSessionId ??
    workspace.activeTab?.focusedSessionId ??
    null
  )
}
