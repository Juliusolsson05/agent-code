import { RewindToPromptModal } from '@renderer/features/workspace/ui/RewindToPromptModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function RewindToPromptSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.rewindPromptSessionId)
  const close = useAppStore(state => state.closeRewindPrompt)
  return (
    <RewindToPromptModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      onClose={close}
    />
  )
}
