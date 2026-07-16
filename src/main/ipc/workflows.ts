import { ipcMain } from 'electron'
import type { WebContents } from 'electron'

import type { WorkflowBridge } from '@main/workflows/WorkflowBridge.js'
import type {
  WorkflowCancelRequest,
  WorkflowEventsAcknowledgement,
  WorkflowGetSnapshotRequest,
  WorkflowReadEventsRequest,
  WorkflowResumeRequest,
  WorkflowRunInterestRequest,
  WorkflowSessionRunsRequest,
} from '@shared/workflows/types.js'

const trackedRendererLifecycles = new WeakSet<WebContents>()

export function registerWorkflowIpc(bridge: WorkflowBridge): void {
  // WHY the handlers delegate to one bridge instead of reaching directly into
  // WorkflowService: the bridge is the IPC policy boundary. It applies the
  // renderer client scope, validates clone-boundary inputs, and owns the one
  // event subscription. Keeping that in one place prevents future preload
  // methods from accidentally bypassing cwd authorization.
  ipcMain.handle(
    'workflows:snapshot',
    (event, request: WorkflowGetSnapshotRequest) => bridge.getSnapshot(request, event.sender.id),
  )
  ipcMain.handle(
    'workflows:events',
    (event, request: WorkflowReadEventsRequest) => bridge.readEvents(request, event.sender.id),
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
  ipcMain.on(
    'workflows:set-run-interest',
    (event, request: WorkflowRunInterestRequest) => {
      trackRendererLifecycle(event.sender, bridge)
      try {
        bridge.setRunInterest(event.sender.id, request)
      } catch (error) {
        // One-way interest control cannot reject back across contextBridge. Treat malformed input
        // as a renderer bug, preserve the main process, and leave durable reads unavailable to the
        // bad request rather than accidentally widening its scope.
        console.warn('[workflows] Rejected renderer run interest', error)
      }
    },
  )
  ipcMain.on(
    'workflows:acknowledge-events',
    (event, request: WorkflowEventsAcknowledgement) => {
      try {
        bridge.acknowledgeEvents(event.sender.id, request)
      } catch (error) {
        console.warn('[workflows] Rejected renderer workflow acknowledgement', error)
      }
    },
  )
}

function trackRendererLifecycle(sender: WebContents, bridge: WorkflowBridge): void {
  if (trackedRendererLifecycles.has(sender)) return
  trackedRendererLifecycles.add(sender)
  const clear = (): void => bridge.clearRendererInterests(sender.id)
  sender.once('destroyed', clear)
  sender.on('did-start-navigation', details => {
    // A renderer reload does not necessarily destroy WebContents, and React never gets a reliable
    // chance to run subscription cleanup after a crash. Clear the old document's delivery leases
    // at navigation start; the newly loaded preload/renderer registers fresh interest after mount.
    // Same-document hash/history navigation retains the JavaScript context and its live leases.
    if (details.isMainFrame && !details.isSameDocument) clear()
  })
}
