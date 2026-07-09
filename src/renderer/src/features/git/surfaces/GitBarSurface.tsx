import { GitBar } from '@renderer/features/git/ui/GitBar'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// Side panel (#494): conditionally MOUNTED (not open-prop) — exactly the
// `{gitBarOpen && <GitBar/>}` semantics App.tsx had. Renders inside the
// main flex row via sidePanelSurfaces.
export function GitBarSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.gitBarOpen)
  const toggle = useAppStore(state => state.toggleGitBar)
  if (!open) return null
  const targetId = commandTargetSessionId(workspace)
  return (
    <GitBar
      cwd={targetId ? workspace.state.sessions[targetId]?.cwd ?? null : null}
      onClose={toggle}
    />
  )
}
