import type { WorkflowClient } from './WorkflowClient'

export const ipcWorkflowClient: WorkflowClient = {
  available: true,
  // WHY every delegation reads `window.api` lazily: contextBridge installation and test setup do
  // not have a useful import-time ordering guarantee. Importing the client must remain inert;
  // choosing desktop transport happens when the provider is mounted, and calls happen later.
  getSnapshot: request => window.api.workflowGetSnapshot(request),
  readEvents: request => window.api.workflowReadEvents(request),
  subscribe: listener => window.api.onWorkflowEvents(listener),
  async cancel(request) {
    await window.api.workflowCancel(request)
  },
  async resume(request) {
    const response = await window.api.workflowResume(request)
    return response.run
  },
}
