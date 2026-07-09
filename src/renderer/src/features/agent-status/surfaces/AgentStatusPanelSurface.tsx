import { AgentStatusPanel } from '@renderer/features/agent-status/ui/AgentStatusPanel'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export function AgentStatusPanelSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.agentStatusPanelOpen)
  const close = useAppStore(state => state.closeAgentStatusPanel)
  if (!open) return null
  // App.tsx's guard was `agentStatusPanelOpen && commandTargetId` — no
  // target session means no panel, not an empty panel.
  const targetId = commandTargetSessionId(workspace)
  if (!targetId) return null
  return <AgentStatusPanel sessionId={targetId} workspace={workspace} onClose={close} />
}
