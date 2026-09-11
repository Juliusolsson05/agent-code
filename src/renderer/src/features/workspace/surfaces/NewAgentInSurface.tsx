import { NewAgentInDialog } from '@renderer/features/workspace/ui/NewAgentInDialog'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// New Agent In… (#852). A boolean flag, not a captured target — choosing the
// project is what the dialog is for; see UiShellState.newAgentInOpen.
export function NewAgentInSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.newAgentInOpen)
  const close = useAppStore(state => state.closeNewAgentIn)
  return <NewAgentInDialog open={open} workspace={workspace} onClose={close} />
}
