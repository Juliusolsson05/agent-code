import { CloseCompletedAgentsModal } from '@renderer/features/workspace/ui/CloseCompletedAgentsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function CloseCompletedAgentsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.closeCompletedAgentsOpen)
  const close = useAppStore(state => state.closeCloseCompletedAgents)
  return <CloseCompletedAgentsModal open={open} workspace={workspace} onClose={close} />
}
