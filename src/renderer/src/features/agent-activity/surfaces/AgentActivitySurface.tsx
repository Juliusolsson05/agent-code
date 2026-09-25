import { AgentActivityView } from '@renderer/features/agent-activity/ui/AgentActivityView'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function AgentActivitySurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.agentActivityOpen)
  const close = useAppStore(state => state.closeAgentActivity)
  return <AgentActivityView open={open} workspace={workspace} onClose={close} />
}
