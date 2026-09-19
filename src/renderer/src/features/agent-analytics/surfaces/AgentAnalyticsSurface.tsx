import { AgentAnalyticsModal } from '@renderer/features/agent-analytics/ui/AgentAnalyticsModal'
import { useAppStore } from '@renderer/app-state/hooks'

export function AgentAnalyticsSurface() {
  const open = useAppStore(state => state.agentAnalyticsOpen)
  const close = useAppStore(state => state.closeAgentAnalytics)
  return <AgentAnalyticsModal open={open} onClose={close} />
}
