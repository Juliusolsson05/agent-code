import { WorktreesBar } from '@renderer/features/worktrees/ui/WorktreesBar'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export function WorktreesBarSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.worktreesBarOpen)
  const toggle = useAppStore(state => state.toggleWorktreesBar)
  if (!open) return null
  const targetId = commandTargetSessionId(workspace)
  return (
    <WorktreesBar
      cwd={targetId ? workspace.state.sessions[targetId]?.cwd ?? null : null}
      workspace={workspace}
      onClose={toggle}
    />
  )
}
