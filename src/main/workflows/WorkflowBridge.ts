import type {
  StoredWorkflowEvent,
  WorkflowRunSnapshot,
  WorkflowRunStartResult,
  WorkflowService,
  WorkflowServiceScope,
} from 'workflow-mcp'
import { WorkflowServiceError } from 'workflow-mcp'

import {
  recordIpcDiagnosticBreadcrumb,
  sendToMainWindow,
} from '@main/window/mainWindow.js'
import { workflowPayloadForRenderer } from '@main/workflows/workflowPayloadForRenderer.js'
import type {
  WorkflowCancelRequest,
  WorkflowCancelResult,
  WorkflowEventsAcknowledgement,
  WorkflowEventsBatch,
  WorkflowGetSnapshotRequest,
  WorkflowGetSnapshotResult,
  WorkflowReadEventsRequest,
  WorkflowReadEventsResult,
  WorkflowRunReferenceData,
  WorkflowRunInterestRequest,
  WorkflowResumeRequest,
  WorkflowResumeResult,
  WorkflowSessionRunsRequest,
  WorkflowSessionRunsResult,
} from '@shared/workflows/types.js'

const RENDERER_CLIENT_ID = 'agent-code-renderer'
// WHY workflow UI freshness is frame-scale rather than event-scale: one parallel agent can emit a
// start/completion pair for every tool, and several agents do so concurrently. A 100 ms window still
// drove multiple durable reads plus full workflow React commits per second for every visible run.
// Half a second remains visibly live while giving the renderer one coherent state transition for a
// burst and leaving input/heartbeat work guaranteed gaps between commits.
const DEFAULT_BATCH_WINDOW_MS = 500
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024

type RendererRunInterest = {
  cwd: string
  acknowledgedCursor: number
  inFlightCursor: number | null
}

type RunDeliveryState = {
  latestCursor: number
  interests: Map<number, RendererRunInterest>
}

type WorkflowBridgeSender = (
  channel: 'workflows:event-batch' | 'workflows:session-runs',
  payload: WorkflowEventsBatch | WorkflowSessionRunsResult,
) => void

export type WorkflowBridgeOptions = {
  batchWindowMs?: number
  maxBatchBytes?: number
  send?: WorkflowBridgeSender
}

/**
 * Main-process bridge between the durable WorkflowService and Electron IPC.
 *
 * WHY this is a singleton fan-out rather than an ipcMain listener per run:
 * workflow rows mount/unmount as feeds virtualize, renderer hot reloads, and a
 * user expands different agents. One app-owned subscription observes durable progress, while
 * renderer lifetimes register only delivery interest. Main sends at most one unacknowledged cursor
 * hint per interested run; event bodies cross IPC only through byte-bounded durable reads. This
 * distinction is what lets a 120-agent producer remain independent of renderer speed.
 */
export class WorkflowBridge {
  private readonly deliveryByRun = new Map<string, RunDeliveryState>()
  private readonly runsBySession = new Map<
    string,
    { cwd: string; slots: Map<string, WorkflowRunReferenceData> }
  >()
  private readonly send: WorkflowBridgeSender
  private readonly batchWindowMs: number
  private readonly maxBatchBytes: number
  private unsubscribe: (() => void) | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly service: WorkflowService,
    options: WorkflowBridgeOptions = {},
  ) {
    this.send = options.send ?? sendToMainWindow
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    this.maxBatchBytes = positiveInteger(
      options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
      'maxBatchBytes',
    )
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
    // WHY shutdown drops live hints: every hinted event is already durable, and a renderer which
    // is itself unloading cannot acknowledge delivery. Flushing here used to create one last IPC
    // burst exactly when Chromium was tearing its queues down.
    this.deliveryByRun.clear()
  }

  setRunInterest(rendererId: number, request: WorkflowRunInterestRequest): void {
    const { cwd, runId } = validateRunScope(request)
    if (typeof request.interested !== 'boolean') {
      throw new TypeError('interested must be a boolean')
    }

    if (!request.interested) {
      const delivery = this.deliveryByRun.get(runId)
      delivery?.interests.delete(rendererId)
      if (delivery?.interests.size === 0) this.deliveryByRun.delete(runId)
      return
    }

    const delivery = this.deliveryByRun.get(runId) ?? {
      latestCursor: 0,
      interests: new Map<number, RendererRunInterest>(),
    }
    const existing = delivery.interests.get(rendererId)
    if (!existing || existing.cwd !== cwd) {
      delivery.interests.set(rendererId, {
        cwd,
        acknowledgedCursor: 0,
        inFlightCursor: null,
      })
    }
    this.deliveryByRun.set(runId, delivery)

    // A renderer re-registers after returning from Page Visibility `hidden`. Events emitted while
    // it was suspended were intentionally not queued, so prime from the durable snapshot cursor.
    // Any event published while this async read is in flight updates the same state through
    // enqueue(), and max() below preserves the newer authority.
    void this.primeRunInterest(rendererId, cwd, runId)
  }

  acknowledgeEvents(rendererId: number, request: WorkflowEventsAcknowledgement): void {
    const { cwd, runId } = validateRunScope(request)
    const cursor = nonNegativeInteger(request.cursor, 'cursor')
    const delivery = this.deliveryByRun.get(runId)
    const interest = delivery?.interests.get(rendererId)
    recordIpcDiagnosticBreadcrumb('workflows:acknowledge-events', {
      rendererId,
      runId,
      cursor,
      accepted: Boolean(delivery && interest && interest.cwd === cwd),
    })
    // An acknowledgement can race visibilitychange/unmount. Once interest is gone there is no
    // in-flight slot to release, so late success is harmless and must not resurrect the run.
    if (!delivery || !interest || interest.cwd !== cwd) return
    interest.acknowledgedCursor = Math.max(interest.acknowledgedCursor, cursor)
    if (interest.inFlightCursor !== null && cursor >= interest.inFlightCursor) {
      interest.inFlightCursor = null
    }
    if (delivery.latestCursor > interest.acknowledgedCursor) this.scheduleFlush()
  }

  clearRendererInterests(rendererId: number): void {
    for (const [runId, delivery] of this.deliveryByRun) {
      delivery.interests.delete(rendererId)
      if (delivery.interests.size === 0) this.deliveryByRun.delete(runId)
    }
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
    const projected = byteBoundedEvents(page.events, this.maxBatchBytes)
    const response = {
      cwd,
      runId: page.runId,
      fromCursor: page.fromCursor,
      toCursor: projected.events.at(-1)?.cursor ?? page.fromCursor,
      events: projected.events,
      hasMore: page.hasMore || projected.truncated,
    }
    recordIpcDiagnosticBreadcrumb('workflows:events-result', {
      runId,
      requestAfter: request.after ?? 0,
      fromCursor: response.fromCursor,
      toCursor: response.toCursor,
      eventsCount: response.events.length,
      projectedBytes: projected.bytes,
      hasMore: response.hasMore,
    })
    return response
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
    const ownerSessionId = this.findSessionForRun(cwd, runId)
    const run = await this.service.resume({
      cwd,
      // Preserve the parent session's MCP scope when a user clicks Resume in the renderer. Without
      // this, tool-driven starts inherit connected servers but UI-driven resumes mysteriously lose
      // them even though both runs belong to the same visible workflow lineage.
      clientId: ownerSessionId ?? RENDERER_CLIENT_ID,
    }, {
      runId,
      ...(request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: nonEmpty(request.idempotencyKey, 'idempotencyKey') }),
    })
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
    const delivery = this.deliveryByRun.get(event.runId)
    // No visible workflow view is interested. The event is already in WorkflowService's journal;
    // retaining or cloning it here would create a second, unbounded queue with no consumer.
    if (!delivery || delivery.interests.size === 0) return
    delivery.latestCursor = Math.max(delivery.latestCursor, event.cursor)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.batchWindowMs)
  }

  private flush(): void {
    for (const [runId, delivery] of this.deliveryByRun) {
      for (const interest of delivery.interests.values()) {
        if (
          interest.inFlightCursor !== null ||
          delivery.latestCursor <= interest.acknowledgedCursor
        ) continue
        const toCursor = delivery.latestCursor
        // Agent Code currently has one BrowserWindow, so the sender targets that window and one
        // interest exists per run. Keeping rendererId in state still makes reload cleanup precise;
        // a future multi-window product must make WorkflowBridgeSender target-aware before sharing
        // this loop across windows.
        this.send('workflows:event-batch', {
          cwd: interest.cwd,
          runId,
          fromCursor: interest.acknowledgedCursor + 1,
          toCursor,
          events: [],
        })
        interest.inFlightCursor = toCursor
      }
    }
  }

  private async primeRunInterest(rendererId: number, cwd: string, runId: string): Promise<void> {
    try {
      const snapshot = await this.service.snapshot(rendererScope(cwd), runId)
      const delivery = this.deliveryByRun.get(runId)
      const interest = delivery?.interests.get(rendererId)
      if (!delivery || !interest || interest.cwd !== cwd) return
      delivery.latestCursor = Math.max(delivery.latestCursor, snapshot.cursor)
      if (delivery.latestCursor > interest.acknowledgedCursor) this.scheduleFlush()
    } catch (error) {
      // Historical transcript references can outlive pruned workflow storage. The store's own
      // snapshot request renders the user-facing unavailable/error state; interest priming is only
      // a latency optimization and should not add an unhandled rejection during mount.
      if (error instanceof WorkflowServiceError && error.code === 'run-not-found') return
      console.warn('[workflows] Unable to prime renderer run interest', { runId, error })
    }
  }
}

function byteBoundedEvents(
  events: readonly StoredWorkflowEvent[],
  maxBytes: number,
): { events: StoredWorkflowEvent[]; truncated: boolean; bytes: number } {
  const selected: StoredWorkflowEvent[] = []
  let bytes = 2 // JSON array brackets; exact envelope overhead is small and constant.
  for (const durable of events) {
    const projected = workflowPayloadForRenderer(durable)
    const eventBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8') + 1
    // WHY an oversized first event fails closed instead of using the old
    // "always make progress" escape hatch: that exception made the advertised
    // 512 KiB cap fictional exactly for the legacy payloads most likely to
    // freeze structured clone. Modern ContentReference events are compacted
    // above. A malformed legacy event now produces a visible/retryable workflow
    // error while the durable journal remains intact, rather than taking down
    // the entire app to preserve one inspector row.
    if (eventBytes > maxBytes) {
      throw new RangeError(
        `Workflow event at cursor ${durable.cursor} projects to ${eventBytes} bytes, exceeding the ${maxBytes}-byte renderer safety cap.`,
      )
    }
    if (bytes + eventBytes > maxBytes) break
    selected.push(projected)
    bytes += eventBytes
  }
  return { events: selected, truncated: selected.length < events.length, bytes }
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
    ...(run.scriptPath === undefined ? {} : { scriptPath: run.scriptPath }),
    transcriptDirectory: run.transcriptDirectory,
    ...(run.resumedFromRunId === undefined ? {} : { resumedFromRunId: run.resumedFromRunId }),
  }
}

function cloneReference(reference: WorkflowRunReferenceData): WorkflowRunReferenceData {
  return {
    ...reference,
    ...(reference.workflow ? { workflow: { ...reference.workflow } } : {}),
  }
}
