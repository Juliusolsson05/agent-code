import { useMemo } from 'react'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// Derive the focused agent's cwd — used by the Global Editor shell to
// pick a project root at tab-change time.
//
// WHY commandTargetSessionIdForState (and not tab.focusedSessionId
// or dispatchMode.focusedSessionId directly): Agent Code has TWO
// focus fields. Tab.focusedSessionId is the grid pane focus;
// dispatchMode.focusedSessionId is the list selection when Dispatch
// mode is on. Reading EITHER raw field misses the other half of the
// surfaces — a dispatch-mode user has tab.focusedSessionId === null,
// and a grid-mode user has dispatchMode === null. The
// commandTargetSessionId helper already encodes the right decision
// (see its inline doc — "the session that commands should target")
// and we want the editor to pick the same agent the command palette
// would address.
//
// WHY we DO NOT subscribe to this on every render in the shell:
// commandTargetSessionId changes on every within-tab focus shift
// (pane-to-pane in grid, list-row in dispatch). Earlier versions of
// GlobalEditorShell consumed this value as a render-time dep and
// blew up the editor's open tabs every time the user switched panes
// inside the same tab. The shell now reads this hook's output, but
// only commits it to the store when activeTabId itself changes —
// see the lastSyncedTabIdRef effect there.
//
// Returns null when no agent is focused (rare — only at boot before
// any tab opens, or in transient states between actions). The shell
// renders an empty-state stub in that case.
export function useFocusedAgentCwd(workspace: Workspace): string | null {
  return useMemo(() => {
    const id = commandTargetSessionIdForState(workspace.state)
    if (!id) return null
    const cwd = workspace.state.sessions[id]?.cwd
    return cwd ?? null
  }, [workspace.state])
}
