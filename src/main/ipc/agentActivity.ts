import { ipcMain } from 'electron'
import { z } from 'zod'

import type { AgentActivityRecorder } from '@main/agentActivity/AgentActivityRecorder.js'
import { getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'
import { AGENT_ACTIVITY_SUMMARY_CHANNEL } from '@shared/agentActivity/summaryTypes.js'

// Agent Analytics summary for the window (#964).
//
// WHY a registered-window guard: the history names tabs, repositories and agents
// the user worked on. Application windows may read it; an extension frame or any
// other web contents that can reach ipcRenderer may not.
const range = z.enum(['24h', '7d', '30d', 'all'])

export function registerAgentActivityIpc(recorder: AgentActivityRecorder): void {
  ipcMain.handle(AGENT_ACTIVITY_SUMMARY_CHANNEL, (event, raw: unknown) => {
    const windowId = windowIdFor(event.sender)
    if (!windowId || !getBrowserWindow(windowId) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent Analytics requires a registered application window.')
    }
    return recorder.summary(range.parse(raw))
  })
}
