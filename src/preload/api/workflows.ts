import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  WorkflowCancelRequest,
  WorkflowCancelResult,
  WorkflowEventsBatch,
  WorkflowGetSnapshotRequest,
  WorkflowGetSnapshotResult,
  WorkflowReadEventsRequest,
  WorkflowReadEventsResult,
  WorkflowResumeRequest,
  WorkflowResumeResult,
} from '@shared/workflows/types.js'

export const workflowsApi = {
  workflowGetSnapshot: (
    request: WorkflowGetSnapshotRequest,
  ): Promise<WorkflowGetSnapshotResult> => ipcRenderer.invoke('workflows:snapshot', request),

  workflowReadEvents: (
    request: WorkflowReadEventsRequest,
  ): Promise<WorkflowReadEventsResult> => ipcRenderer.invoke('workflows:events', request),

  workflowCancel: (
    request: WorkflowCancelRequest,
  ): Promise<WorkflowCancelResult> => ipcRenderer.invoke('workflows:cancel', request),

  workflowResume: (
    request: WorkflowResumeRequest,
  ): Promise<WorkflowResumeResult> => ipcRenderer.invoke('workflows:resume', request),

  onWorkflowEvents: (cb: (batch: WorkflowEventsBatch) => void): Unsub =>
    subscribe('workflows:event-batch', cb),
}

