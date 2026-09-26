import { ipcMain } from 'electron'
import { z } from 'zod'
import { broadcastToWindows, getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'
import { GOAL_LOOP_CONTROL_ACTIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop.js'
import type { GoalLoopService } from './GoalLoopService.js'

const sessionIdList = z.array(z.string().min(1)).max(10_000)
const carryRequest = z.object({ from: z.string().min(1), to: z.string().min(1) })
const controlRequest = z.object({
  sessionId: z.string().min(1),
  action: z.enum(GOAL_LOOP_CONTROL_ACTIONS),
  // The ceiling, not a literal 200: the renderer clamps Raise cap to the same
  // constant, and a drifted copy here would reject the request it builds.
  value: z.number().int().min(1).max(GOAL_LOOP_MAX_CONTINUATIONS_CEILING).optional(),
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
  // #1279: the renderer commits every replacement (old pane id -> new), so it
  // is the one that can say which loop follows which pane. Same trust level
  // as control above: an application window may already steer any loop.
  ipcMain.handle('goal-loop:carry', (event, raw: unknown) => {
    assertApplicationWindow(event)
    const request = carryRequest.parse(raw)
    return service.carry(request.from, request.to)
  })
  // Fan-out is a dumb invalidation ping (no payload): the renderer re-reads
  // per pane, so a broadcast body would only duplicate state across panes and
  // invite races between two copies of the same loop.
  service.on('changed', () => broadcastToWindows('goal-loop:changed'))
}
