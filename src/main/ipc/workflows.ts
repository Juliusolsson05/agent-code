import { ipcMain } from 'electron'

import type { WorkflowBridge } from '@main/workflows/WorkflowBridge.js'
import type {
  WorkflowCancelRequest,
  WorkflowGetSnapshotRequest,
  WorkflowReadEventsRequest,
  WorkflowResumeRequest,
  WorkflowSessionRunsRequest,
} from '@shared/workflows/types.js'

export function registerWorkflowIpc(bridge: WorkflowBridge): void {
  // WHY the handlers delegate to one bridge instead of reaching directly into
  // WorkflowService: the bridge is the IPC policy boundary. It applies the
  // renderer client scope, validates clone-boundary inputs, and owns the one
  // event subscription. Keeping that in one place prevents future preload
  // methods from accidentally bypassing cwd authorization.
  ipcMain.handle(
    'workflows:snapshot',
    (_event, request: WorkflowGetSnapshotRequest) => bridge.getSnapshot(request),
  )
  ipcMain.handle(
    'workflows:events',
    (_event, request: WorkflowReadEventsRequest) => bridge.readEvents(request),
  )
  ipcMain.handle(
    'workflows:cancel',
    (_event, request: WorkflowCancelRequest) => bridge.cancel(request),
  )
  ipcMain.handle(
    'workflows:resume',
    (_event, request: WorkflowResumeRequest) => bridge.resume(request),
  )
  ipcMain.handle(
    'workflows:list-session-runs',
    (_event, request: WorkflowSessionRunsRequest) => bridge.getSessionRuns(request),
  )
}
