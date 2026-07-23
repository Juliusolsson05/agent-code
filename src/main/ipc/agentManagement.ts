import { ipcMain } from 'electron'

import type { AgentManagementBridge } from '@main/agentManagement/AgentManagementBridge.js'
import type { AgentManagementRendererResponse } from '@mcp/shared/agentManagementTypes.js'

export function registerAgentManagementIpc(bridge: AgentManagementBridge): void {
  ipcMain.handle(
    'agent-management:response',
    (_event, response: AgentManagementRendererResponse) => {
      bridge.resolve(response)
      return true
    },
  )
}
