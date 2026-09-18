import { ipcMain } from 'electron'
import { z } from 'zod'
import { broadcastToWindows, getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'
import type { GoalLoopService } from './GoalLoopService.js'

const sessionIdList = z.array(z.string().min(1)).max(10_000)
const controlRequest = z.object({
  sessionId: z.string().min(1),
  action: z.enum(['pause', 'resume', 'stop', 'raise-cap']),
  value: z.number().int().min(1).max(200).optional(),
})

function assertApplicationWindow(event: Electron.IpcMainInvokeEvent): void {
  const windowId = windowIdFor(event.sender)
  if (!windowId || !getBrowserWindow(windowId) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Goal Loop requires a registered application window.')
  }
}

export function registerGoalLoopIpc(service: GoalLoopService): void {
  ipcMain.handle('goal-loop:read', (event, raw: unknown) => {
    assertApplicationWindow(event)
    const ids = new Set(sessionIdList.parse(raw))
    return Object.fromEntries(Object.entries(service.snapshot()).filter(([id]) => ids.has(id)))
  })
  // The renderer may steer (pause/resume/stop/raise) any loop it can see:
  // creating loops stays MCP-only (the model writes the prompt), but
  // controlling a running loop is exactly the user's modal surface.
  ipcMain.handle('goal-loop:control', (event, raw: unknown) => {
    assertApplicationWindow(event)
    const request = controlRequest.parse(raw)
    return service.control(request.sessionId, request)
  })
  // Fan-out is a dumb invalidation ping (no payload): the renderer re-reads
  // per pane, so a broadcast body would only duplicate state across panes and
  // invite races between two copies of the same loop.
  service.on('changed', () => broadcastToWindows('goal-loop:changed'))
}
