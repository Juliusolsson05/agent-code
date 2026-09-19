import { ipcRenderer } from 'electron'

import { AGENT_ACTIVITY_SUMMARY_CHANNEL } from '@shared/agentActivity/summaryTypes.js'
import type { AgentActivityRange, AgentActivitySummary } from '@shared/agentActivity/summaryTypes.js'

// Agent Analytics (#964): read-only. Main records and summarizes; the window only
// asks for a range and paints the result.
export const agentActivityApi = {
  getAgentActivitySummary: (range: AgentActivityRange): Promise<AgentActivitySummary> =>
    ipcRenderer.invoke(AGENT_ACTIVITY_SUMMARY_CHANNEL, range),
}
