import { useAppStore } from '@renderer/app-state/hooks'
import { AgentTitlePrompt } from '@renderer/features/workspace/ui/AgentTitlePrompt'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// The surface owns only transient prompt chrome. The value itself commits to
// SessionMeta through Workspace.setAgentTitle, so autosave and rehydration keep
// the same single persistence path as every other durable session attribute.
export function AgentTitlePromptSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.agentTitlePromptSessionId)
  const close = useAppStore(state => state.closeAgentTitlePrompt)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null

  return (
    <AgentTitlePrompt
      open={sessionId !== null && meta !== null}
      initialTitle={meta?.title ?? ''}
      description={meta?.cwd ?? ''}
      onCancel={close}
      onSave={title => {
        if (sessionId) workspace.setAgentTitle(sessionId, title)
        close()
      }}
    />
  )
}
