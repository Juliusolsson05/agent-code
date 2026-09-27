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

  // #1283 item 1: the parent pane `from` now runs as `to`; main's tombstones
  // of its MCP-closed children follow (see OrchestrationBridge.carryParent).
  carryOrchestrationParent: (from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('orchestration:carry-parent', { from, to }),
}
