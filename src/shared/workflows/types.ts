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

export type WorkflowRunInterestRequest = WorkflowRunIpcScope & {
  interested: boolean
}

export type WorkflowEventsAcknowledgement = WorkflowRunIpcScope & {
  cursor: number
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
 * Live delivery is deliberately a cursor hint, not another copy of durable truth. `events` stays
 * in the contract for compatibility with remote/test clients, but Electron main sends it empty:
 * an interested renderer catches up through the byte-bounded `workflowReadEvents` path and then
 * acknowledges the cursor. That gives main one in-flight notification per visible run instead of
 * an unbounded structured-clone queue when a workflow emits faster than React can render.
 */
export type WorkflowEventsBatch = {
  runId: string
  cwd?: string
  fromCursor: number
  toCursor: number
  events: StoredWorkflowEvent[]
}
