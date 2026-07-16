import type { WorkflowClient } from './WorkflowClient'

export const ipcWorkflowClient: WorkflowClient = {
  available: true,
  // WHY every delegation reads `window.api` lazily: contextBridge installation and test setup do
  // not have a useful import-time ordering guarantee. Importing the client must remain inert;
  // choosing desktop transport happens when the provider is mounted, and calls happen later.
  getSnapshot: request => window.api.workflowGetSnapshot(request),
  readEvents: request => window.api.workflowReadEvents(request),
  subscribe(scope, listener) {
    // WHY visibility controls main-process interest rather than merely suppressing React updates:
    // Electron may suspend a hidden renderer. If main keeps `webContents.send`-ing durable event
    // bodies during that suspension, Chromium owns an IPC backlog which the renderer cannot
    // coalesce when it wakes. Removing interest before suspension lets main retain one integer
    // cursor and the visible renderer later repairs from the durable log.
    const offEvents = window.api.onWorkflowEvents(listener)
    let interested = false
    const syncInterest = (): void => {
      const next = document.visibilityState === 'visible'
      if (next === interested) return
      interested = next
      window.api.workflowSetRunInterest({ ...scope, interested })
    }
    document.addEventListener('visibilitychange', syncInterest)
    syncInterest()
    return () => {
      document.removeEventListener('visibilitychange', syncInterest)
      offEvents()
      if (interested) window.api.workflowSetRunInterest({ ...scope, interested: false })
    }
  },
  acknowledge: request => window.api.workflowAcknowledgeEvents(request),
  async cancel(request) {
    await window.api.workflowCancel(request)
  },
  async resume(request) {
    const response = await window.api.workflowResume(request)
    return response.run
  },
  async listSessionRuns(request) {
    const response = await window.api.workflowListSessionRuns(request)
    return response.runs
  },
  subscribeSessionRuns(listener) {
    return window.api.onWorkflowSessionRuns(listener)
  },
}
