import { AgentViewModePickerModal } from '@renderer/features/workspace/ui/AgentViewModePickerModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function AgentViewModePickerSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.agentViewModePickerSessionId)
  const close = useAppStore(state => state.closeAgentViewModePicker)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  return (
    <AgentViewModePickerModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      globalMode={agentViewMode}
      onClose={close}
    />
  )
}
