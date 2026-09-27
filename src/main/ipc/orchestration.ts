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
  // #1283 item 1: the renderer commits every pane replacement and remaps its
  // LIVE orchestration children itself; only it can tell main that the
  // tombstones of closed children follow too. Same trust as
  // workflows:carry-session and goal-loop:carry: an application window can
  // already list, read and close any orchestration child it can see.
  ipcMain.handle(
    'orchestration:carry-parent',
    (_evt, request: { from?: unknown; to?: unknown } | undefined) => {
      bridge.carryParent(request?.from, request?.to)
    },
  )
}
