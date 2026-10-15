import { AgentStatusPanel } from '@renderer/features/agent-status/ui/AgentStatusPanel'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId, useCommandTargetInputs } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export function AgentStatusPanelSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.agentStatusPanelOpen)
  const close = useAppStore(state => state.closeAgentStatusPanel)
  // Follows the keyboard into and out of the Sidekick (useCommandTargetInputs
  // WHY). ABOVE the early return: this surface stays mounted while closed, so
  // a hook after `if (!open)` changed the hook count on open and crashed
  // React ("Rendered more hooks", #1517 review).
  useCommandTargetInputs()
  if (!open) return null
  // App.tsx's guard was `agentStatusPanelOpen && commandTargetId` — no
  // target session means no panel, not an empty panel.
  const targetId = commandTargetSessionId(workspace)
  if (!targetId) return null
  return <AgentStatusPanel sessionId={targetId} workspace={workspace} onClose={close} />
}
