import { useAppStore } from '@renderer/app-state/hooks'
import { AgentTitlePrompt } from '@renderer/features/workspace/ui/AgentTitlePrompt'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { resumeAutoAgentTitleInWorkspace } from '@renderer/workspace/agentTitle'

// The surface owns only transient prompt chrome. The value itself commits to
// SessionMeta through Workspace.setAgentTitle, so autosave and rehydration keep
// the same single persistence path as every other durable session attribute.
export function AgentTitlePromptSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.agentTitlePromptSessionId)
  const close = useAppStore(state => state.closeAgentTitlePrompt)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const canResumeAutoTitle = Boolean(meta?.builtInMcpDomains?.includes('auto_title')
    && meta?.kind !== 'terminal'
    && (meta?.titleMode === 'manual' || meta?.titleMode === 'paused' || (meta?.title && meta?.titleMode !== 'auto')))

  return (
    <AgentTitlePrompt
      open={sessionId !== null && meta !== null}
      initialTitle={meta?.title ?? ''}
      description={meta?.cwd ?? ''}
      autoTitleEnabled={meta?.kind !== 'terminal' && Boolean(meta?.builtInMcpDomains?.includes('auto_title'))}
      onCancel={close}
      onSave={title => {
        if (sessionId) workspace.setAgentTitle(sessionId, title)
        close()
      }}
      onResumeAutoTitle={canResumeAutoTitle ? () => {
        if (sessionId) useAppStore.getState().setWorkspaceState(state => resumeAutoAgentTitleInWorkspace(state, sessionId))
        close()
      } : undefined}
    />
  )
}
