import { ipcMain } from 'electron'

import type { OrchestrationBridge } from '@main/orchestration/OrchestrationBridge.js'
import type { OrchestrationRendererResponse } from '@mcp/shared/orchestrationTypes.js'

export function registerOrchestrationIpc(bridge: OrchestrationBridge): void {
  ipcMain.handle(
    'orchestration:response',
    (_evt, response: OrchestrationRendererResponse) => {
      bridge.resolve(response)
      return true
    },
  )
}
