import type {
  StoredWorkflowEvent,
  WorkflowRunManifest,
  WorkflowState,
} from 'workflow-mcp/state'

export type WorkflowRunReference = {
  runId: string
  cwd?: string
  status?: string
  cursor?: number
  workflow?: {
    name: string
    title?: string
    description?: string
  }
  resumedFromRunId?: string
}

export type WorkflowSnapshotEnvelope = {
  runId: string
  cwd: string
  cursor: number
  manifest?: WorkflowRunManifest
  state: WorkflowState
}

export type WorkflowEventBatch = {
  runId: string
  cwd?: string
  fromCursor: number
  toCursor: number
  events: StoredWorkflowEvent[]
}

export type WorkflowEventPage = WorkflowEventBatch & {
  hasMore: boolean
}

export type WorkflowRunScope = {
  cwd: string
  runId: string
}

export type WorkflowSessionRunScope = {
  sessionId: string
  cwd: string
}

export type WorkflowSessionRunsSnapshot = WorkflowSessionRunScope & {
  runs: WorkflowRunReference[]
}

/**
 * The renderer-facing workflow boundary deliberately mirrors capabilities, not Electron IPC.
 *
 * WHY: feed rows are shared by the desktop and remote client. Letting a row reach into
 * `window.api` would make merely importing the feed depend on Electron and recreate the exact
 * transport coupling that SessionFeedContext removed. Desktop supplies an IPC implementation;
 * remote and tests can supply a different client or use the inert default.
 */
export interface WorkflowClient {
  readonly available: boolean
  getSnapshot(scope: WorkflowRunScope): Promise<WorkflowSnapshotEnvelope | null>
  readEvents(
    scope: WorkflowRunScope & {
      after: number
      limit?: number
      waitMs?: number
    },
  ): Promise<WorkflowEventPage>
  subscribe(listener: (batch: WorkflowEventBatch) => void): () => void
  cancel(scope: WorkflowRunScope & { reason?: string }): Promise<void>
  resume(
    scope: WorkflowRunScope & { idempotencyKey?: string },
  ): Promise<WorkflowRunReference>
  listSessionRuns(scope: WorkflowSessionRunScope): Promise<WorkflowRunReference[]>
  subscribeSessionRuns(listener: (snapshot: WorkflowSessionRunsSnapshot) => void): () => void
}

/**
 * Missing workflow transport is a supported environment, not an exceptional render state.
 *
 * The phone client consumes the same feed modules but does not currently proxy workflow IPC.
 * A throwing default would crash an otherwise readable transcript as soon as it encountered a
 * historical workflow tool call. This null client preserves that history and lets the row say
 * live details are desktop-only without lying about a connection attempt.
 */
export const unavailableWorkflowClient: WorkflowClient = {
  available: false,
  async getSnapshot() {
    return null
  },
  async readEvents(scope) {
    return {
      runId: scope.runId,
      cwd: scope.cwd,
      fromCursor: scope.after,
      toCursor: scope.after,
      events: [],
      hasMore: false,
    }
  },
  subscribe() {
    return () => {}
  },
  async cancel() {},
  async resume(scope) {
    return { runId: scope.runId, cwd: scope.cwd }
  },
  async listSessionRuns() {
    return []
  },
  subscribeSessionRuns() {
    return () => {}
  },
}
