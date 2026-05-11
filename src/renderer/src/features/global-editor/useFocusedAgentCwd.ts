import { useMemo } from 'react'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// Derive the focused agent's cwd — the file tree's root.
//
// WHY commandTargetSessionIdForState (and not tab.focusedSessionId
// or dispatchMode.focusedSessionId directly): cc-shell has TWO
// focus fields. Tab.focusedSessionId is the grid pane focus;
// dispatchMode.focusedSessionId is the list selection when
// Dispatch mode is on. The "right answer" for which agent the
// editor should follow depends on surface — and the
// commandTargetSessionId helper already encodes that decision
// (see its inline doc — "the session that commands should
// target"). Reading EITHER raw field misses the other half of
// the surfaces.
//
// WHY a hook (not a plain selector): we derive `cwd` from
// `state.sessions[id].cwd`, and useMemo lets us avoid re-deriving
// on every render when the inputs haven't changed. The hook also
// gives callers a stable contract — they can swap in a different
// "focused" strategy later (e.g. last-active rather than
// command-target) without changing call sites.
//
// Returns null when no agent is focused (rare — only at boot
// before any tab opens). The shell renders an empty-state stub in
// that case.
export function useFocusedAgentCwd(workspace: Workspace): string | null {
  return useMemo(() => {
    const id = commandTargetSessionIdForState(workspace.state)
    if (!id) return null
    const cwd = workspace.state.sessions[id]?.cwd
    return cwd ?? null
  }, [workspace.state])
}
