import { CloseOldAgentsModal } from '@renderer/features/workspace/ui/CloseOldAgentsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function CloseOldAgentsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.closeOldAgentsOpen)
  const close = useAppStore(state => state.closeCloseOldAgents)
  return <CloseOldAgentsModal open={open} workspace={workspace} onClose={close} />
}
