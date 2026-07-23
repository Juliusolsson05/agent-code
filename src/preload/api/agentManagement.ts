import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  AgentManagementRendererRequest,
  AgentManagementRendererResponse,
} from '@mcp/shared/agentManagementTypes.js'

export const agentManagementApi = {
  onAgentManagementRequest: (
    callback: (request: AgentManagementRendererRequest) => void,
  ): Unsub => subscribe('agent-management:request', callback),

  resolveAgentManagementRequest: (
    response: AgentManagementRendererResponse,
  ): Promise<boolean> => ipcRenderer.invoke('agent-management:response', response),
}
