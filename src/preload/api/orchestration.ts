import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type {
  OrchestrationRendererRequest,
  OrchestrationRendererResponse,
} from '@mcp/shared/orchestrationTypes.js'
import type { Unsub } from '@preload/api/types.js'

export const orchestrationApi = {
  onOrchestrationRequest: (
    cb: (request: OrchestrationRendererRequest) => void,
  ): Unsub => subscribe('orchestration:request', cb),

  resolveOrchestrationRequest: (
    response: OrchestrationRendererResponse,
  ): Promise<boolean> => ipcRenderer.invoke('orchestration:response', response),
}
