import { ViewPromptsModal } from '@renderer/features/workspace/ui/ViewPromptsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function ViewPromptsSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.viewPromptsSessionId)
  const close = useAppStore(state => state.closeViewPrompts)
  return (
    <ViewPromptsModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      onClose={close}
    />
  )
}
