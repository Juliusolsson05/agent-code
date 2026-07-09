import { BuryPanePrompt } from '@renderer/features/workspace/ui/BuryPanePrompt'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function BuryPanePromptSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.buryPromptSessionId)
  const close = useAppStore(state => state.closeBuryPrompt)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  return (
    <BuryPanePrompt
      open={sessionId !== null && meta !== null}
      title={
        meta
          ? `${meta.kind ?? DEFAULT_PROVIDER} · ${meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd}`
          : ''
      }
      description={meta?.cwd ?? ''}
      onCancel={close}
      onConfirm={note => {
        if (!sessionId) return
        workspace.buryFocused(note, sessionId)
      }}
    />
  )
}
