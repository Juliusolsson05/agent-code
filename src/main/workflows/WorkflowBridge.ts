import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  StoredWorkflowEvent,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunStartResult,
  WorkflowService,
  WorkflowServiceScope,
} from 'workflow-mcp'
import { WorkflowServiceError } from 'workflow-mcp'
import { createWorkflowState } from 'workflow-mcp/state'

import {
  recordIpcDiagnosticBreadcrumb,
  sendToWindow,
  windowForSession,
  windowIdForWebContentsId,
} from '@main/window/windowRegistry.js'
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
// WHY the durable API is count-paged while the renderer contract is byte-paged: asking the store
// for 500 records can materialize and project a large burst before the byte admission policy gets
// a chance to stop it. A small count ceiling is a second, independent work bound. One legacy event
// can still be large on disk, but at most one small prefix is parsed/projected per renderer request
// and an oversized projected event fails before structured clone.
const MAX_DURABLE_EVENTS_PER_RENDERER_READ = 32

type RendererRunInterest = {
  cwd: string
  acknowledgedCursor: number
  /** Highest cursor main has actually returned through snapshot/readEvents to this renderer. */
  provenCursor: number
  inFlightCursor: number | null
}

type RunDeliveryState = {
  cwd: string
  runId: string
  latestCursor: number
  interests: Map<number, RendererRunInterest>
}

/**
 * Who a workflow message is for.
 *
 * WHY two shapes rather than one window id: the bridge knows its addressee two
 * different ways depending on the message. Session-runs is about one agent, so
 * the owning window is derived from the session. Event batches are answers to a
 * delivery interest a specific renderer registered, and that interest is already
 * keyed by `rendererId` — so the renderer is the address, and using the session
 * instead would misdeliver after a session moved between windows while a cursor
 * hint was still in flight.
 */
export type WorkflowBridgeTarget =
  | { sessionId: string }
  | { rendererId: number }

type WorkflowBridgeSender = (
  target: WorkflowBridgeTarget,
  channel: 'workflows:event-batch' | 'workflows:session-runs',
  payload: WorkflowEventsBatch | WorkflowSessionRunsResult,
) => void

function sendToTargetWindow(
  target: WorkflowBridgeTarget,
  channel: 'workflows:event-batch' | 'workflows:session-runs',
  payload: WorkflowEventsBatch | WorkflowSessionRunsResult,
): void {
  const windowId = 'sessionId' in target
    ? windowForSession(target.sessionId)
    : windowIdForWebContentsId(target.rendererId)
  // An unresolvable target is a closed window or a session whose owner is
  // mid-handoff. `sendToWindow(null, …)` is a no-op, which is the right
  // outcome: workflow state is durable in WorkflowService, so a missed cursor
  // hint costs a delivery, never data. The renderer re-registers interest when
  // it mounts again.
  sendToWindow(windowId, channel, payload)
}

export type WorkflowBridgeOptions = {
  batchWindowMs?: number
  maxBatchBytes?: number
  send?: WorkflowBridgeSender
  /**
   * Where replaced-pane aliases persist (#1280). Omitted, carries still move
   * the runs for this process but a restart files them under the id they
   * started with.
   */
  aliasFile?: string
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
  private readonly deliveryByScope = new Map<string, RunDeliveryState>()
  private readonly runsBySession = new Map<
    string,
    { cwd: string; slots: Map<string, WorkflowRunReferenceData> }
  >()
  private readonly latestLifecycleByRunId = new Map<
    string,
    { status: string; cursor: number }
  >()
  private readonly send: WorkflowBridgeSender
  private readonly batchWindowMs: number
  private readonly maxBatchBytes: number
  private unsubscribe: (() => void) | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Replaced pane id -> its successor (#1280). A run is filed under the
   * session that started it, in memory and as its durable clientId, and a
   * replaced pane gets a new id; without this its workflow cards vanished,
   * and a restart rebuilt them under the dead id for good. The durable
   * clientId stays what workflow-mcp recorded (it is attribution only there);
   * this map is how the app finds the pane that owns it now.
   */
  private readonly aliases = new Map<string, string>()
  private readonly aliasFile: string | null
  private aliasSave: Promise<void> = Promise.resolve()
  private aliasTempCounter = 0

  constructor(
    private readonly service: WorkflowService,
    options: WorkflowBridgeOptions = {},
  ) {
    this.send = options.send ?? sendToTargetWindow
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    this.maxBatchBytes = positiveInteger(
      options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
      'maxBatchBytes',
    )
    this.aliasFile = options.aliasFile ?? null
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return
    this.unsubscribe = this.service.subscribe(event => this.enqueue(event))
    await this.loadAliases()
    // Snapshot what the file held, so pruning below can only drop edges it
    // loaded. A carry the renderer lands while listStoredRunReferences is
    // awaited is live-process state and must survive even though no stored
    // run names its source yet (the late-registration case it exists for).
    const loaded = new Map(this.aliases)
    if (typeof this.service.listStoredRunReferences === 'function') {
      const references = await this.service.listStoredRunReferences()
      const clientIds = new Set<string>()
      for (const reference of references) {
        if (!reference.clientId) continue
        clientIds.add(reference.clientId)
        const { cwd, clientId, ...run } = reference
        this.upsertRun(this.resolveSession(clientId), cwd, run)
      }
      await this.pruneAliases(loaded, clientIds)
    }
  }

  /**
   * The pane `from` was replaced by `to` (#1280): its runs now belong to `to`.
   * Called by the renderer at the same commit points that carry a goal loop,
   * and by Undo Close, which resumes the same conversation under a fresh id.
   *
   * WHY the alias is recorded even when `from` owns no runs yet (#1325 review
   * A1): a workflow the pane's MCP started just before the swap registers
   * through `registerRun(from, ...)` when its tool call returns, which can be
   * after this commit, and its durable clientId is `from` forever. Without the
   * edge that run lands in a dead slot now and after every restart. The file
   * stays small because `start()` prunes every edge no stored run reaches.
   */
  async carrySession(from: string, to: string): Promise<void> {
    const source = nonEmpty(from, 'from')
    const target = nonEmpty(to, 'to')
    if (source === target) return
    const moving = this.runsBySession.get(source)
    const existing = this.runsBySession.get(target)
    if (moving && existing && existing.cwd !== moving.cwd) {
      // WHY skip instead of letting one side win (#1325 review A4): a slot
      // holds runs for one cwd, so a merge is impossible, and overwriting the
      // target silently deleted runs the successor already showed. Every
      // renderer carry is a same-cwd replacement, so reaching this means the
      // two ids are not really one pane; leaving both slots (and recording no
      // alias) keeps each run visible where it was instead of guessing.
      console.warn('[workflows] not carrying workflow runs across different working directories')
      return
    }
    // `target` is a live pane now. An older edge out of it (it was replaced
    // once and is back) would send its runs to a pane that no longer exists,
    // and with this carry could form a cycle, so it goes.
    this.aliases.delete(target)
    this.aliases.set(source, target)
    let session = existing
    if (moving) {
      // WHY merge through collapseLineage (#1325 review A5): the successor may
      // already hold a Resume of one of the moved runs (registered under the
      // new id before this carry landed). A plain map merge showed parent and
      // child as two cards, while a restart, which goes through upsertRun,
      // shows one; both paths must produce the same representation. Moved
      // slots go first so the oldest slot key keeps its React identity.
      session = existing
        ? { cwd: moving.cwd, slots: new Map([...moving.slots, ...existing.slots]) }
        : moving
      collapseLineage(session.slots)
      this.runsBySession.delete(source)
      this.runsBySession.set(target, session)
    }
    await this.saveAliases()
    if (moving && session) {
      this.publishSessionRuns(source, { cwd: moving.cwd, slots: new Map() })
      this.publishSessionRuns(target, session)
    }
  }

  /** Follow the replacement chain to the pane that owns a clientId today. */
  private resolveSession(sessionId: string): string {
    let current = sessionId
    const seen = new Set<string>()
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current)
      current = this.aliases.get(current)!
    }
    return current
  }

  private async loadAliases(): Promise<void> {
    if (!this.aliasFile) return
    try {
      const parsed = JSON.parse(await readFile(this.aliasFile, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [from, to] of Object.entries(parsed as Record<string, unknown>)) {
        if (from && typeof to === 'string' && to) this.aliases.set(from, to)
      }
    } catch {
      // Missing (no pane was ever replaced) or unreadable: runs are then filed
      // under the id they started with, today's behaviour. The runs
      // themselves are safe in the workflow store either way.
    }
  }

  /**
   * Drop loaded edges that no stored run's clientId reaches. WHY: every
   * replacement now records an edge (see carrySession), so without this the
   * file grows with every reload for the life of the install. An edge only
   * matters for a run whose durable clientId leads through it; a late
   * registration from a previous process cannot happen after a restart, so
   * after the inventory an unreachable loaded edge is dead weight.
   */
  private async pruneAliases(
    loaded: ReadonlyMap<string, string>,
    clientIds: ReadonlySet<string>,
  ): Promise<void> {
    const reachable = new Set<string>()
    for (const clientId of clientIds) {
      let current = clientId
      while (this.aliases.has(current) && !reachable.has(current)) {
        reachable.add(current)
        current = this.aliases.get(current)!
      }
    }
    let pruned = false
    for (const [from, to] of loaded) {
      // Only an edge that is still exactly what the file held: a carry during
      // start() may have rewritten it, and that one is live.
      if (reachable.has(from) || this.aliases.get(from) !== to) continue
      this.aliases.delete(from)
      pruned = true
    }
    if (pruned) await this.saveAliases()
  }

  /**
   * WHY serialized (#1325 review B): Reload Agents fires one carry per pane
   * without awaiting. With independent writers an older snapshot could
   * rename last and erase a newer edge on disk while memory still had it, so
   * the loss only showed after a restart. Each queued write snapshots the map
   * when it runs, so the last write always carries every edge made so far.
   */
  private saveAliases(): Promise<void> {
    const write = this.aliasSave.then(() => this.writeAliases())
    this.aliasSave = write
    return write
  }

  private async writeAliases(): Promise<void> {
    if (!this.aliasFile) return
    // Temp file + rename: a crash mid-write must not leave half a JSON
    // document, which loadAliases would read as no aliases at all. The counter
    // keeps two writes in the same millisecond off one temp path.
    this.aliasTempCounter += 1
    const temporary = `${this.aliasFile}.${process.pid}.${Date.now()}.${this.aliasTempCounter}.tmp`
    try {
      await mkdir(dirname(this.aliasFile), { recursive: true })
      await writeFile(temporary, JSON.stringify(Object.fromEntries(this.aliases)), { mode: 0o600 })
      await rename(temporary, this.aliasFile)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      // The move already happened in memory; only a restart would lose it.
      // Never rejects, so one failed write cannot wedge the queue behind it.
      console.warn('[workflows] could not persist a replaced pane\'s workflow runs:', error)
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    // WHY shutdown drops live hints: every hinted event is already durable, and a renderer which
    // is itself unloading cannot acknowledge delivery. Flushing here used to create one last IPC
    // burst exactly when Chromium was tearing its queues down.
    this.deliveryByScope.clear()
    this.latestLifecycleByRunId.clear()
  }

  setRunInterest(rendererId: number, request: WorkflowRunInterestRequest): void {
    const { cwd, runId } = validateRunScope(request)
    const key = runScopeKey(cwd, runId)
    if (typeof request.interested !== 'boolean') {
      throw new TypeError('interested must be a boolean')
    }

    if (!request.interested) {
      const delivery = this.deliveryByScope.get(key)
      delivery?.interests.delete(rendererId)
      if (delivery?.interests.size === 0) this.deliveryByScope.delete(key)
      return
    }

    const delivery = this.deliveryByScope.get(key) ?? {
      cwd,
      runId,
      latestCursor: 0,
      interests: new Map<number, RendererRunInterest>(),
    }
    const existing = delivery.interests.get(rendererId)
    if (!existing || existing.cwd !== cwd) {
      delivery.interests.set(rendererId, {
        cwd,
        acknowledgedCursor: 0,
        provenCursor: 0,
        inFlightCursor: null,
      })
    }
    this.deliveryByScope.set(key, delivery)

    // A renderer re-registers after returning from Page Visibility `hidden`. Events emitted while
    // it was suspended were intentionally not queued, so prime from the durable snapshot cursor.
    // Any event published while this async read is in flight updates the same state through
    // enqueue(), and max() below preserves the newer authority.
    void this.primeRunInterest(rendererId, cwd, runId)
  }

  acknowledgeEvents(rendererId: number, request: WorkflowEventsAcknowledgement): void {
    const { cwd, runId } = validateRunScope(request)
    const cursor = nonNegativeInteger(request.cursor, 'cursor')
    const delivery = this.deliveryByScope.get(runScopeKey(cwd, runId))
    const interest = delivery?.interests.get(rendererId)
    const accepted = Boolean(
      delivery &&
      interest &&
      interest.cwd === cwd &&
      cursor <= interest.provenCursor,
    )
    recordIpcDiagnosticBreadcrumb('workflows:acknowledge-events', {
      rendererId,
      runId,
      cursor,
      accepted,
    })
    // An acknowledgement can race visibilitychange/unmount. Once interest is gone there is no
    // in-flight slot to release, so late success is harmless and must not resurrect the run.
    if (!delivery || !interest || interest.cwd !== cwd || cursor > interest.provenCursor) return
    interest.acknowledgedCursor = Math.max(interest.acknowledgedCursor, cursor)
    // WHY every proven acknowledgement releases the lease, even when it reports the renderer's
    // previous cursor: a durable read can fail after main sent a cursor hint. The renderer acks its
    // last admitted cursor as a NACK, allowing main to issue a fresh hint. Requiring cursor >= the
    // hinted target permanently wedged that run after one transient IPC/storage error.
    interest.inFlightCursor = null
    if (delivery.latestCursor > interest.acknowledgedCursor) this.scheduleFlush()
  }

  clearRendererInterests(rendererId: number): void {
    for (const [key, delivery] of this.deliveryByScope) {
      delivery.interests.delete(rendererId)
      if (delivery.interests.size === 0) this.deliveryByScope.delete(key)
    }
  }

  async getSnapshot(
    request: WorkflowGetSnapshotRequest,
    rendererId?: number,
  ): Promise<WorkflowGetSnapshotResult> {
    const { cwd, runId } = validateRunScope(request)
    let manifest: WorkflowRunSnapshot['manifest']
    try {
      manifest = workflowManifestForRenderer(
        await this.service.status(rendererScope(cwd), runId),
      )
    } catch (error) {
      // A feed can legitimately retain a historical workflow tool result after
      // its local run directory was removed. Treat absence as an empty client
      // state, while preserving scope-forbidden and storage failures as real
      // errors; swallowing those would turn an authorization bug into a blank
      // card that is almost impossible to diagnose.
      if (error instanceof WorkflowServiceError && error.code === 'run-not-found') return null
      throw error
    }
    // Status proves this is the durable upper bound even though the bootstrap payload starts at
    // cursor zero. This permits a remounted cached renderer store to acknowledge state it already
    // reduced before unmount, while still rejecting cursors beyond durable truth.
    this.noteProvenCursor(rendererId, cwd, runId, manifest.cursor)
    // WHY bootstrap returns an empty projection instead of a fully reduced snapshot: a snapshot's
    // activity arrays grow with the whole run and therefore cannot have an honest byte ceiling.
    // The manifest is compact authority for status/latest cursor; the renderer reconstructs state
    // from the same byte-bounded durable pages used for live gap repair, yielding between pages.
    // This also makes restart cost proportional to admitted pages rather than one fatal clone.
    return {
      cwd,
      runId,
      cursor: 0,
      manifest,
      state: createWorkflowState(runId),
    }
  }

  registerRun(sessionId: string, cwd: string, run: WorkflowRunStartResult): void {
    // WHY resolve here (#1325 review A1/A2): callers name the session they
    // captured when the work started. The MCP onRunStarted callback holds the
    // tool call's scope, and Resume holds the owner it found before awaiting
    // the service; either can land after the pane was replaced. Filing under
    // the captured id would recreate the dead pane's slot.
    const { sessionId: normalizedSessionId, session } = this.upsertRun(
      this.resolveSession(nonEmpty(sessionId, 'sessionId')),
      cwd,
      run,
    )
    this.publishSessionRuns(normalizedSessionId, session)
  }

  private upsertRun(
    sessionId: string,
    cwd: string,
    run: WorkflowRunStartResult,
  ): {
    sessionId: string
    session: { cwd: string; slots: Map<string, WorkflowRunReferenceData> }
  } {
    const normalizedSessionId = nonEmpty(sessionId, 'sessionId')
    const normalizedCwd = nonEmpty(cwd, 'cwd')
    const existing = this.runsBySession.get(normalizedSessionId)
    const session = existing?.cwd === normalizedCwd
      ? existing
      : { cwd: normalizedCwd, slots: new Map<string, WorkflowRunReferenceData>() }

    let reference: WorkflowRunReferenceData = {
      cwd: normalizedCwd,
      ...cloneStartResult(run),
    }
    const lifecycle = this.latestLifecycleByRunId.get(run.runId)
    // WHY a lifecycle event may legitimately predate registration: workflow-mcp starts execution
    // before its tool handler returns the launch reference, and startup inventory is asynchronous.
    // A short workflow can therefore complete while there is no session slot to update. Keeping
    // the event's cursor authority here prevents the later launch/inventory snapshot from reviving
    // a completed run as Active. Cursor comparison is essential because restart inventory can also
    // be newer than an old event retained by this process.
    if (lifecycle && lifecycle.cursor >= (reference.cursor ?? 0)) {
      reference = { ...reference, ...lifecycle }
    }
    session.slots.set(run.runId, reference)
    collapseLineage(session.slots)
    this.runsBySession.set(normalizedSessionId, session)
    return { sessionId: normalizedSessionId, session }
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

  async readEvents(
    request: WorkflowReadEventsRequest,
    rendererId?: number,
  ): Promise<WorkflowReadEventsResult> {
    const { cwd, runId } = validateRunScope(request)
    const requestedLimit = request.limit === undefined
      ? MAX_DURABLE_EVENTS_PER_RENDERER_READ
      : positiveInteger(request.limit, 'limit')
    const page = await this.service.readEvents(rendererScope(cwd), {
      runId,
      ...(request.after === undefined ? {} : { after: nonNegativeInteger(request.after, 'after') }),
      limit: Math.min(requestedLimit, MAX_DURABLE_EVENTS_PER_RENDERER_READ),
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
    this.noteProvenCursor(rendererId, cwd, runId, response.toCursor)
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
    if (
      request.abandonUnconfirmedProvider !== undefined &&
      typeof request.abandonUnconfirmedProvider !== 'boolean'
    ) {
      throw new TypeError('abandonUnconfirmedProvider must be a boolean')
    }
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
      ...(request.abandonUnconfirmedProvider === undefined
        ? {}
        : { abandonUnconfirmedProvider: request.abandonUnconfirmedProvider }),
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
    this.send({ sessionId }, 'workflows:session-runs', {
      sessionId,
      cwd: session.cwd,
      runs: [...session.slots.values()].map(reference => cloneReference(reference)),
    })
  }

  private enqueue(event: StoredWorkflowEvent): void {
    this.publishRunLifecycleTransition(event)
    let interested = false
    for (const delivery of this.deliveryByScope.values()) {
      if (delivery.runId !== event.runId || delivery.interests.size === 0) continue
      delivery.latestCursor = Math.max(delivery.latestCursor, event.cursor)
      interested = true
    }
    // No visible workflow view is interested. The event is already in WorkflowService's journal;
    // retaining or cloning it here would create a second, unbounded queue with no consumer.
    if (interested) this.scheduleFlush()
  }

  private publishRunLifecycleTransition(event: StoredWorkflowEvent): void {
    const status = workflowStatusFromEvent(event)
    if (!status) return

    const previousLifecycle = this.latestLifecycleByRunId.get(event.runId)
    // Durable events normally arrive in order, but the bridge must not make status correctness
    // depend on subscription scheduling. An older delayed run.started must never turn a terminal
    // reference back into Active while preserving the terminal event's higher cursor.
    if (previousLifecycle && previousLifecycle.cursor > event.cursor) return
    this.latestLifecycleByRunId.set(event.runId, { status, cursor: event.cursor })

    for (const [sessionId, session] of this.runsBySession) {
      let changed = false
      for (const [slot, reference] of session.slots) {
        if (reference.runId !== event.runId) continue
        if ((reference.cursor ?? 0) > event.cursor) continue
        const cursor = event.cursor
        if (reference.status === status && reference.cursor === cursor) continue
        session.slots.set(slot, { ...reference, status, cursor })
        changed = true
      }
      // WHY session-run pushes follow lifecycle events, not the complete event stream: selectors
      // need to distinguish live work from history even when no inspector is mounted, but cloning
      // the list for every agent/tool event would recreate the render pressure the cursor-batched
      // bridge was designed to remove. Run lifecycle transitions are rare and are the only events
      // that can change the active/inactive navigation treatment.
      if (changed) this.publishSessionRuns(sessionId, session)
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, this.batchWindowMs)
  }

  private flush(): void {
    for (const delivery of this.deliveryByScope.values()) {
      for (const [rendererId, interest] of delivery.interests) {
        if (
          interest.inFlightCursor !== null ||
          delivery.latestCursor <= interest.acknowledgedCursor
        ) continue
        const toCursor = delivery.latestCursor
        // The interest map is keyed by rendererId precisely so this loop can
        // address the renderer that asked. With several windows open, two of
        // them can hold interest in the SAME run (the same project open in
        // both), and each needs its own cursor hint against its own
        // acknowledged cursor — one shared send would leave the other window's
        // acknowledgement permanently behind.
        this.send({ rendererId }, 'workflows:event-batch', {
          cwd: interest.cwd,
          runId: delivery.runId,
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
      const manifest = await this.service.status(rendererScope(cwd), runId)
      const delivery = this.deliveryByScope.get(runScopeKey(cwd, runId))
      const interest = delivery?.interests.get(rendererId)
      if (!delivery || !interest || interest.cwd !== cwd) return
      delivery.latestCursor = Math.max(delivery.latestCursor, manifest.cursor)
      if (delivery.latestCursor > interest.acknowledgedCursor) this.scheduleFlush()
    } catch (error) {
      // Historical transcript references can outlive pruned workflow storage. The store's own
      // snapshot request renders the user-facing unavailable/error state; interest priming is only
      // a latency optimization and should not add an unhandled rejection during mount.
      if (error instanceof WorkflowServiceError && error.code === 'run-not-found') return
      console.warn('[workflows] Unable to prime renderer run interest', { runId, error })
    }
  }

  private noteProvenCursor(
    rendererId: number | undefined,
    cwd: string,
    runId: string,
    cursor: number,
  ): void {
    if (rendererId === undefined) return
    const interest = this.deliveryByScope.get(runScopeKey(cwd, runId))?.interests.get(rendererId)
    if (!interest || interest.cwd !== cwd) return
    interest.provenCursor = Math.max(interest.provenCursor, cursor)
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
    const eventBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8')
    const separatorBytes = selected.length === 0 ? 0 : 1
    // WHY an oversized first event fails closed instead of using the old
    // "always make progress" escape hatch: that exception made the advertised
    // 512 KiB cap fictional exactly for the legacy payloads most likely to
    // freeze structured clone. Modern ContentReference events are compacted
    // above. A malformed legacy event now produces a visible/retryable workflow
    // error while the durable journal remains intact, rather than taking down
    // the entire app to preserve one inspector row.
    if (2 + eventBytes > maxBytes) {
      throw new RangeError(
        `Workflow event at cursor ${durable.cursor} projects to ${eventBytes} bytes, exceeding the ${maxBytes}-byte renderer safety cap.`,
      )
    }
    if (bytes + separatorBytes + eventBytes > maxBytes) break
    selected.push(projected)
    bytes += separatorBytes + eventBytes
  }
  return { events: selected, truncated: selected.length < events.length, bytes }
}

function runScopeKey(cwd: string, runId: string): string {
  return `${cwd}\u0000${runId}`
}

function workflowStatusFromEvent(event: StoredWorkflowEvent): string | null {
  switch (event.event.type) {
    case 'run.started': return 'running'
    case 'run.cancellation_requested': return 'cancellation_requested'
    case 'run.completed':
      return event.event.payload.withErrors === true ? 'completed_with_errors' : 'completed'
    case 'run.failed': return 'failed'
    case 'run.cancelled': return 'cancelled'
    case 'run.interrupted': return 'interrupted'
    default: return null
  }
}

function workflowManifestForRenderer(manifest: WorkflowRunManifest): WorkflowRunManifest {
  // WHY status is projected even though it is much smaller than a reduced snapshot: workflow
  // metadata and terminal error text ultimately originate in user-authored definitions/providers.
  // A pathological description must not smuggle an unbounded string through the one bootstrap IPC
  // message that otherwise has a hard size invariant. Durable events retain complete diagnostic
  // content through ContentReference; the renderer manifest only needs identity, lineage, and a
  // compact label while it reconstructs those events page by page.
  const bounded = (value: string): string => value.slice(0, 4 * 1024)
  return {
    schemaVersion: manifest.schemaVersion,
    runId: bounded(manifest.runId),
    cwd: bounded(manifest.cwd),
    workflow: {
      name: bounded(manifest.workflow.name),
      description: bounded(manifest.workflow.description),
      ...(manifest.workflow.title === undefined
        ? {}
        : { title: bounded(manifest.workflow.title) }),
      ...(manifest.workflow.sourceHash === undefined
        ? {}
        : { sourceHash: bounded(manifest.workflow.sourceHash) }),
      ...(manifest.workflow.filePath === undefined
        ? {}
        : { filePath: bounded(manifest.workflow.filePath) }),
    },
    status: manifest.status,
    cursor: manifest.cursor,
    createdAt: bounded(manifest.createdAt),
    updatedAt: bounded(manifest.updatedAt),
    ...(manifest.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: bounded(manifest.idempotencyKey) }),
    ...(manifest.resumedFromRunId === undefined
      ? {}
      : { resumedFromRunId: bounded(manifest.resumedFromRunId) }),
    ...(manifest.cancellationReason === undefined
      ? {}
      : { cancellationReason: bounded(manifest.cancellationReason) }),
    ...(manifest.error === undefined ? {} : { error: bounded(manifest.error) }),
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

/**
 * Fold every resumed run into its parent's slot so a lineage is one card.
 * Shared by upsertRun and carrySession so a live merge and a restart build the
 * same representation (#1325 review A5).
 */
function collapseLineage(slots: Map<string, WorkflowRunReferenceData>): void {
  // WHY collapse after insertion instead of choosing a slot from the incoming run alone:
  // startup storage inventory has no parent-before-child ordering contract. A successor may be
  // seen before its parent, and a three-run lineage can arrive newest, oldest, middle. Repeatedly
  // replacing any present parent with its present child converges on the leaf while retaining the
  // oldest slot key for stable React identity. Live resumes take the same path, so restart and
  // in-process navigation cannot drift into different lineage representations.
  while (true) {
    const entries = [...slots.entries()]
    // Collapse from the oldest available edge toward the leaf. If C→B is collapsed before B→A,
    // B's own ancestry disappears with its card and A can no longer be recognized as the same
    // lineage. A valid resume graph is acyclic, so at least one present edge has a parent whose
    // own parent is not present; absence of such an edge means corrupt/cyclic lineage, which is
    // safer to display as separate cards than to spin or discard an arbitrary run.
    const edge = entries
      .map(([childSlot, child]) => {
        if (!child.resumedFromRunId) return null
        const parentEntry = entries.find(([, parent]) => parent.runId === child.resumedFromRunId)
        if (!parentEntry || parentEntry[0] === childSlot) return null
        const [, parent] = parentEntry
        const parentHasPresentParent = parent.resumedFromRunId !== undefined &&
          entries.some(([, candidate]) => candidate.runId === parent.resumedFromRunId)
        return parentHasPresentParent
          ? null
          : { childSlot, child, parentSlot: parentEntry[0] }
      })
      .find((candidate): candidate is {
        childSlot: string
        child: WorkflowRunReferenceData
        parentSlot: string
      } => candidate !== null)
    if (!edge) break
    slots.delete(edge.childSlot)
    slots.set(edge.parentSlot, edge.child)
  }
}
