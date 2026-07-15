import type {
  StoredWorkflowEvent,
  WorkflowRunSnapshot,
  WorkflowRunStartResult,
  WorkflowService,
  WorkflowServiceScope,
} from 'workflow-mcp'
import { WorkflowServiceError } from 'workflow-mcp'

import { sendToMainWindow } from '@main/window/mainWindow.js'
import { workflowPayloadForRenderer } from '@main/workflows/workflowPayloadForRenderer.js'
import type {
  WorkflowCancelRequest,
  WorkflowCancelResult,
  WorkflowEventsBatch,
  WorkflowGetSnapshotRequest,
  WorkflowGetSnapshotResult,
  WorkflowReadEventsRequest,
  WorkflowReadEventsResult,
  WorkflowRunReferenceData,
  WorkflowResumeRequest,
  WorkflowResumeResult,
  WorkflowSessionRunsRequest,
  WorkflowSessionRunsResult,
} from '@shared/workflows/types.js'

const RENDERER_CLIENT_ID = 'agent-code-renderer'
const DEFAULT_BATCH_WINDOW_MS = 16

type WorkflowBridgeSender = (
  channel: 'workflows:event-batch' | 'workflows:session-runs',
  payload: WorkflowEventsBatch | WorkflowSessionRunsResult,
) => void

export type WorkflowBridgeOptions = {
  batchWindowMs?: number
  send?: WorkflowBridgeSender
}

/**
 * Main-process bridge between the durable WorkflowService and Electron IPC.
 *
 * WHY this is a singleton fan-out rather than an ipcMain listener per run:
 * workflow rows mount/unmount as feeds virtualize, renderer hot reloads, and a
 * user expands different agents. Tying service subscriptions to those React
 * lifetimes leaks listeners and creates tiny race windows where events exist
 * only in storage. One app-owned subscription publishes best-effort batches;
 * durable cursor reads remain the recovery authority.
 */
export class WorkflowBridge {
  private readonly pendingByRun = new Map<string, StoredWorkflowEvent[]>()
  private readonly runsBySession = new Map<
    string,
    { cwd: string; slots: Map<string, WorkflowRunReferenceData> }
  >()
  private readonly send: WorkflowBridgeSender
  private readonly batchWindowMs: number
  private unsubscribe: (() => void) | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly service: WorkflowService,
    options: WorkflowBridgeOptions = {},
  ) {
    this.send = options.send ?? sendToMainWindow
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.service.subscribe(event => this.enqueue(event))
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    // A graceful shutdown/reload should deliver the already-persisted tail if
    // a renderer still exists. Losing it would still be safe (the next cursor
    // read heals it), but flushing makes the ordinary path feel immediate.
    this.flush()
  }

  async getSnapshot(request: WorkflowGetSnapshotRequest): Promise<WorkflowGetSnapshotResult> {
    const { cwd, runId } = validateRunScope(request)
    let snapshot: WorkflowRunSnapshot
    try {
      snapshot = await this.service.snapshot(rendererScope(cwd), runId)
    } catch (error) {
      // A feed can legitimately retain a historical workflow tool result after
      // its local run directory was removed. Treat absence as an empty client
      // state, while preserving scope-forbidden and storage failures as real
      // errors; swallowing those would turn an authorization bug into a blank
      // card that is almost impossible to diagnose.
      if (error instanceof WorkflowServiceError && error.code === 'run-not-found') return null
      throw error
    }
    return {
      cwd,
      runId,
      cursor: snapshot.cursor,
      manifest: snapshot.manifest,
      state: workflowPayloadForRenderer(snapshot.state),
    }
  }

  registerRun(sessionId: string, cwd: string, run: WorkflowRunStartResult): void {
    const normalizedSessionId = nonEmpty(sessionId, 'sessionId')
    const normalizedCwd = nonEmpty(cwd, 'cwd')
    const existing = this.runsBySession.get(normalizedSessionId)
    const session = existing?.cwd === normalizedCwd
      ? existing
      : { cwd: normalizedCwd, slots: new Map<string, WorkflowRunReferenceData>() }

    // WHY a resume updates its original slot instead of appending another row: WorkflowService
    // correctly creates a new immutable run for every resume, but product navigation represents
    // one workflow lineage. The bridge is the first app-owned layer that knows both the MCP client
    // session and the returned lineage, so this is the only reliable place to preserve that view.
    let slotRunId = run.runId
    if (run.resumedFromRunId) {
      for (const [candidateSlot, reference] of session.slots) {
        if (reference.runId === run.resumedFromRunId) {
          slotRunId = candidateSlot
          break
        }
      }
    }
    session.slots.set(slotRunId, {
      cwd: normalizedCwd,
      ...cloneStartResult(run),
    })
    this.runsBySession.set(normalizedSessionId, session)
    this.publishSessionRuns(normalizedSessionId, session)
  }

  getSessionRuns(request: WorkflowSessionRunsRequest): WorkflowSessionRunsResult {
    if (!request || typeof request !== 'object') {
      throw new TypeError('Workflow session request is required')
    }
    const sessionId = nonEmpty(request.sessionId, 'sessionId')
    const cwd = nonEmpty(request.cwd, 'cwd')
    const session = this.runsBySession.get(sessionId)
    return {
      sessionId,
      cwd,
      runs: session?.cwd === cwd
        ? [...session.slots.values()].map(reference => cloneReference(reference))
        : [],
    }
  }

  async readEvents(request: WorkflowReadEventsRequest): Promise<WorkflowReadEventsResult> {
    const { cwd, runId } = validateRunScope(request)
    const page = await this.service.readEvents(rendererScope(cwd), {
      runId,
      ...(request.after === undefined ? {} : { after: nonNegativeInteger(request.after, 'after') }),
      ...(request.limit === undefined ? {} : { limit: positiveInteger(request.limit, 'limit') }),
      ...(request.waitMs === undefined ? {} : { waitMs: nonNegativeInteger(request.waitMs, 'waitMs') }),
    })
    return {
      cwd,
      runId: page.runId,
      fromCursor: page.fromCursor,
      toCursor: page.toCursor,
      events: workflowPayloadForRenderer(page.events),
      hasMore: page.hasMore,
    }
  }

  async cancel(request: WorkflowCancelRequest): Promise<WorkflowCancelResult> {
    const { cwd, runId } = validateRunScope(request)
    await this.service.cancel(
      rendererScope(cwd),
      runId,
      request.reason === undefined ? undefined : nonEmpty(request.reason, 'reason'),
    )
    return { ok: true }
  }

  async resume(request: WorkflowResumeRequest): Promise<WorkflowResumeResult> {
    const { cwd, runId } = validateRunScope(request)
    const run = await this.service.resume(rendererScope(cwd), {
      runId,
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: nonEmpty(request.idempotencyKey, 'idempotencyKey') }),
    })
    const ownerSessionId = this.findSessionForRun(cwd, runId)
    if (ownerSessionId) this.registerRun(ownerSessionId, cwd, run)
    return { ok: true, run: cloneStartResult(run) }
  }

  private findSessionForRun(cwd: string, runId: string): string | null {
    for (const [sessionId, session] of this.runsBySession) {
      if (session.cwd !== cwd) continue
      for (const reference of session.slots.values()) {
        if (reference.runId === runId) return sessionId
      }
    }
    return null
  }

  private publishSessionRuns(
    sessionId: string,
    session: { cwd: string; slots: Map<string, WorkflowRunReferenceData> },
  ): void {
    this.send('workflows:session-runs', {
      sessionId,
      cwd: session.cwd,
      runs: [...session.slots.values()].map(reference => cloneReference(reference)),
    })
  }

  private enqueue(event: StoredWorkflowEvent): void {
    const pending = this.pendingByRun.get(event.runId)
    if (pending) pending.push(event)
    else this.pendingByRun.set(event.runId, [event])

    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.batchWindowMs)
  }

  private flush(): void {
    if (this.pendingByRun.size === 0) return
    const batches = [...this.pendingByRun.entries()]
    this.pendingByRun.clear()

    for (const [runId, events] of batches) {
      if (events.length === 0) continue
      // The service publishes only after append and preserves each run's
      // cursor order. Do not collapse activity.updated records here: every
      // durable event is part of replay state, and renderer gap detection must
      // see the same sequence whether it arrived by IPC or by disk-backed read.
      this.send('workflows:event-batch', {
        runId,
        fromCursor: events[0]!.cursor,
        toCursor: events[events.length - 1]!.cursor,
        // Durable storage keeps its exact records. The renderer gets a bounded projection so one
        // verbose command cannot turn a routine structured clone into seconds of UI starvation.
        events: workflowPayloadForRenderer(events),
      })
    }
  }
}

function rendererScope(cwd: string): WorkflowServiceScope {
  return { cwd, clientId: RENDERER_CLIENT_ID }
}

function validateRunScope(request: WorkflowGetSnapshotRequest): { cwd: string; runId: string } {
  if (!request || typeof request !== 'object') throw new TypeError('Workflow request is required')
  return {
    cwd: nonEmpty(request.cwd, 'cwd'),
    runId: nonEmpty(request.runId, 'runId'),
  }
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`)
  }
  return value
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`)
  }
  return value
}

function cloneStartResult(run: WorkflowRunStartResult): WorkflowResumeResult['run'] {
  return {
    runId: run.runId,
    status: run.status,
    workflow: { ...run.workflow },
    cursor: run.cursor,
    ...(run.resumedFromRunId === undefined ? {} : { resumedFromRunId: run.resumedFromRunId }),
  }
}

function cloneReference(reference: WorkflowRunReferenceData): WorkflowRunReferenceData {
  return {
    ...reference,
    ...(reference.workflow ? { workflow: { ...reference.workflow } } : {}),
  }
}
