import type {
  StoredWorkflowEvent,
  WorkflowRunManifest,
  WorkflowState,
} from 'workflow-mcp/state'

export type WorkflowRunReferenceData = {
  runId: string
  cwd: string
  status?: string
  cursor?: number
  workflow?: {
    name: string
    title?: string
    description?: string
  }
  /** Editable Claude-visible definition; immutable run bytes stay in the private workflow store. */
  scriptPath?: string
  transcriptDirectory?: string
  resumedFromRunId?: string
}

export type WorkflowSessionRunsRequest = {
  sessionId: string
  cwd: string
}

export type WorkflowSessionRunsResult = {
  sessionId: string
  cwd: string
  runs: WorkflowRunReferenceData[]
}

/**
 * Clone-safe contracts for the Electron main <-> renderer workflow bridge.
 *
 * WHY `cwd` travels with every control/read request: a workflow run is not a
 * global capability merely because its opaque id leaked into a transcript.
 * WorkflowService applies project-scope authorization using the same cwd that
 * scoped the MCP client which started the run. The renderer is trusted local
 * UI, but keeping that scope explicit means IPC cannot accidentally grow a
 * less restrictive contract than MCP.
 */
export type WorkflowRunIpcScope = {
  cwd: string
  runId: string
}

export type WorkflowGetSnapshotRequest = WorkflowRunIpcScope

export type WorkflowGetSnapshotResult = {
  cwd: string
  runId: string
  cursor: number
  manifest: WorkflowRunManifest
  state: WorkflowState
} | null

export type WorkflowReadEventsRequest = WorkflowRunIpcScope & {
  after?: number
  limit?: number
  waitMs?: number
}

export type WorkflowReadEventsResult = {
  cwd: string
  runId: string
  fromCursor: number
  toCursor: number
  events: StoredWorkflowEvent[]
  hasMore: boolean
}

export type WorkflowCancelRequest = WorkflowRunIpcScope & {
  reason?: string
}

export type WorkflowCancelResult = {
  ok: true
}

export type WorkflowResumeRequest = WorkflowRunIpcScope & {
  idempotencyKey?: string
}

export type WorkflowResumeResult = {
  ok: true
  run: {
    runId: string
    status: string
    workflow?: {
      name: string
      title?: string
      description?: string
    }
    cursor: number
    scriptPath?: string
    transcriptDirectory?: string
    resumedFromRunId?: string
  }
}

/**
 * One event subscription serves the whole renderer. Rows filter by runId and
 * heal gaps through workflowReadEvents; main never allocates one listener per
 * React component. Cursor bounds are repeated outside `events` so a consumer
 * can reject stale/empty batches without walking payload objects first.
 */
export type WorkflowEventsBatch = {
  runId: string
  fromCursor: number
  toCursor: number
  events: StoredWorkflowEvent[]
}
