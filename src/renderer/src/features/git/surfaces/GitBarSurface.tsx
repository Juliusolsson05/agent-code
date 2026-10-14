import { GitBar } from '@renderer/features/git/ui/GitBar'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId, useCommandTargetInputs } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// Side panel (#494): conditionally MOUNTED (not open-prop) — exactly the
// `{gitBarOpen && <GitBar/>}` semantics App.tsx had. Renders inside the
// main flex row via sidePanelSurfaces.
export function GitBarSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.gitBarOpen)
  const toggle = useAppStore(state => state.toggleGitBar)
  // Follows the keyboard into and out of the Sidekick (useCommandTargetInputs
  // WHY). ABOVE the early return: this surface stays mounted while closed, so
  // a hook after `if (!open)` changed the hook count on open and crashed
  // React ("Rendered more hooks", #1517 review).
  useCommandTargetInputs()
  if (!open) return null
  const targetId = commandTargetSessionId(workspace)
  return (
    <GitBar
      cwd={targetId ? workspace.state.sessions[targetId]?.cwd ?? null : null}
      onClose={toggle}
    />
  )
}
