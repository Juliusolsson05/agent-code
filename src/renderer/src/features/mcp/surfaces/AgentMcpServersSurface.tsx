import { useAppStore } from '@renderer/app-state/hooks'
import { AgentMcpServersModal } from '@renderer/features/mcp/ui/AgentMcpServersModal'

// Mounted only while open for the same reason as McpServerDialogSurface: a
// staged draft belongs to one opening, for one captured agent.
export function AgentMcpServersSurface() {
  const sessionId = useAppStore(state => state.agentMcpServersSessionId)
  if (!sessionId) return null
  return <AgentMcpServersModal key={sessionId} />
}
