import { useMemo, useSyncExternalStore } from 'react'
import {
  createWorkflowState,
  reduceWorkflowState,
  type StoredWorkflowEvent,
  type WorkflowState,
} from 'workflow-mcp/state'

import type {
  WorkflowClient,
  WorkflowEventBatch,
  WorkflowRunScope,
} from '../client/WorkflowClient'

export type WorkflowRunView = {
  phase: 'loading' | 'ready' | 'unavailable' | 'error'
  snapshot: WorkflowState
  /** Oldest-to-newest immutable ancestors; `snapshot` remains the live run authority. */
  history: WorkflowState[]
  cursor: number
  error?: string
}

type Listener = () => void

function storedCursor(event: StoredWorkflowEvent): number {
  return event.cursor
}

function validBatchForScope(batch: WorkflowEventBatch, scope: WorkflowRunScope): boolean {
  return (
    batch.runId === scope.runId &&
    (batch.cwd === undefined || batch.cwd === scope.cwd)
  )
}

function yieldToRenderer(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0))
}

/**
 * One cursor-checked projection for one durable workflow run.
 *
 * WHY this is an external store instead of component state: the same run can appear twice in a
 * transcript (launch plus resume/link), while event bursts can contain dozens of agent activity
 * updates. A shared store reduces each event once and gives every card an immutable snapshot.
 * `useSyncExternalStore` also gives React a coherent view when a batch lands during a concurrent
 * render; ad-hoc effects/setState cannot promise that.
 */
export class WorkflowRunStore {
  private readonly listeners = new Set<Listener>()
  private view: WorkflowRunView
  private stopPush: (() => void) | null = null
  private started = false
  private generation = 0
  private bootstrapping = false
  private pendingBeforeSnapshot: WorkflowEventBatch[] = []
  private syncTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly client: WorkflowClient,
    readonly scope: WorkflowRunScope,
  ) {
    this.view = {
      phase: client.available ? 'loading' : 'unavailable',
      snapshot: createWorkflowState(scope.runId),
      history: [],
      cursor: 0,
    }
  }

  getSnapshot = (): WorkflowRunView => this.view

  canEvict(): boolean {
    return this.listeners.size === 0 && !this.started
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    if (!this.started) void this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  retry(): void {
    this.stop()
    this.setView({
      phase: 'loading',
      snapshot: this.view.snapshot,
      history: this.view.history,
      cursor: this.view.cursor,
    })
    if (this.listeners.size > 0) void this.start()
  }

  private setView(next: WorkflowRunView): void {
    if (
      next.phase === this.view.phase &&
      next.snapshot === this.view.snapshot &&
      next.history === this.view.history &&
      next.cursor === this.view.cursor &&
      next.error === this.view.error
    ) return
    this.view = next
    for (const listener of this.listeners) listener()
  }

  private stop(): void {
    this.generation += 1
    this.started = false
    this.stopPush?.()
    this.stopPush = null
    this.bootstrapping = false
    this.pendingBeforeSnapshot = []
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const generation = ++this.generation
    this.bootstrapping = true

    if (!this.client.available) {
      this.setView({
        phase: 'unavailable',
        snapshot: this.view.snapshot,
        history: this.view.history,
        cursor: this.view.cursor,
      })
      return
    }

    // Subscribe BEFORE reading the snapshot. Otherwise an event persisted between the snapshot
    // response and listener registration is invisible until another event happens to reveal the
    // sequence gap. Batches received during bootstrap are buffered, then compared against the
    // authoritative snapshot cursor.
    try {
      this.stopPush = this.client.subscribe(this.scope, (batch) => {
        if (!validBatchForScope(batch, this.scope) || generation !== this.generation) return
        if (this.bootstrapping) {
          this.pendingBeforeSnapshot.push(batch)
          return
        }
        this.enqueueBatch(batch, generation)
      })
      const envelope = await this.client.getSnapshot(this.scope)
      if (generation !== this.generation) return
      if (!envelope) {
        this.setView({
          phase: 'error',
          snapshot: this.view.snapshot,
          history: this.view.history,
          cursor: this.view.cursor,
          error: 'Workflow run was not found in this project.',
        })
        return
      }
      const manifestCursor = envelope.manifest?.cursor ?? envelope.cursor
      // WHY a remount can start durable replay from the cached projection: getSnapshot deliberately
      // returns a compact cursor-zero state, while this store outlives its React subscriber. Replaying
      // every historical event whenever a row scrolls back into view would turn virtualization into
      // repeated O(run history) work. The manifest cursor proves the cached state is not from the
      // future; readEvents remains the authority for everything after it.
      const bootstrapBase = this.view.cursor > envelope.cursor && this.view.cursor <= manifestCursor
        ? {
            ...envelope,
            cursor: this.view.cursor,
            state: this.view.snapshot,
          }
        : envelope
      const bootstrap = await this.replayEnvelope(this.scope, bootstrapBase, generation)
      if (generation !== this.generation) return
      // WHY the owned run becomes authoritative before optional ancestry is fetched: the current
      // snapshot is enough to render and to establish the durable cursor. A missing/corrupt parent
      // must not leave this store at cursor zero while live batches pile up behind `loading`; that
      // turns one lineage error into a full replay of the child and can recreate the renderer burst
      // this store is meant to absorb. Parent snapshots enrich the view, but they never gate it.
      // WHY a remount never moves backward: the store intentionally outlives its React rows. A
      // delayed bootstrap envelope can therefore be older than state already reduced before the
      // row unmounted. Retaining that newer projection is both cheaper than replaying from zero and
      // necessary because main keeps acknowledgements monotonic.
      if (bootstrap.cursor >= this.view.cursor) {
        this.setView({
          phase: 'ready',
          snapshot: bootstrap.state,
          history: this.view.history,
          cursor: bootstrap.cursor,
        })
      } else if (this.view.phase !== 'ready') {
        this.setView({ ...this.view, phase: 'ready', error: undefined })
      }
      this.bootstrapping = false
      this.client.acknowledge({ ...this.scope, cursor: this.view.cursor })
      const pending = this.pendingBeforeSnapshot
      this.pendingBeforeSnapshot = []
      for (const batch of pending) this.enqueueBatch(batch, generation)

      let history = this.view.history
      try {
        history = await this.loadHistory(envelope.manifest?.resumedFromRunId, generation)
      } catch (error) {
        // WHY ancestry failure is deliberately nonfatal: the child snapshot and event cursor came
        // from the authoritative store and remain usable. Surfacing the parent problem in developer
        // diagnostics preserves evidence without replacing a working run UI with an error card.
        console.warn('[workflows] Unable to load optional resume ancestry', error)
      }
      if (generation !== this.generation) return
      this.setView({ ...this.view, history })
    } catch (error) {
      if (generation !== this.generation) return
      this.bootstrapping = false
      // WHY a failed bootstrap relinquishes its main-process interest immediately: cursor hints
      // carry a one-in-flight lease. Leaving the subscription alive after an IPC/storage error
      // strands that lease and lets later durable events advance behind a view which can no longer
      // consume them. Retry establishes a fresh interest and bootstrap; until then, an error card
      // should be inert rather than a hidden event sink.
      this.stopPush?.()
      this.stopPush = null
      this.setView({
        phase: 'error',
        snapshot: this.view.snapshot,
        history: this.view.history,
        cursor: this.view.cursor,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private enqueueBatch(batch: WorkflowEventBatch, generation: number): void {
    // Serializing all cursor work is important even in a single-threaded renderer: two async gap
    // repairs can otherwise read the same `after` cursor and both reduce the same events. The tail
    // is kept alive after a failure so a transient IPC error does not permanently poison the run.
    this.syncTail = this.syncTail
      .then(() => this.applyBatchOrRepair(batch, generation))
      .catch((error) => {
        if (generation !== this.generation) return
        // WHY failure closes the subscription instead of repeatedly acknowledging the old cursor:
        // an oversized durable event is deterministic. NACK/re-hint would create a tight error
        // loop, while retaining the interest would permanently hold main's delivery lease. The
        // explicit Retry action is the safe boundary for a new attempt after storage/code changes.
        this.stopPush?.()
        this.stopPush = null
        this.setView({
          phase: 'error',
          snapshot: this.view.snapshot,
          history: this.view.history,
          cursor: this.view.cursor,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private reduceContiguous(events: StoredWorkflowEvent[]): boolean {
    let snapshot = this.view.snapshot
    let cursor = this.view.cursor
    let changed = false
    const ordered = [...events].sort((a, b) => storedCursor(a) - storedCursor(b))
    for (const stored of ordered) {
      if (stored.runId !== this.scope.runId || stored.cursor <= cursor) continue
      if (stored.cursor !== cursor + 1) return false
      snapshot = reduceWorkflowState(snapshot, stored.event)
      cursor = stored.cursor
      changed = true
    }
    if (changed) this.setView({
      phase: 'ready',
      snapshot,
      history: this.view.history,
      cursor,
    })
    return true
  }

  private async loadHistory(
    firstParentRunId: string | undefined,
    generation: number,
  ): Promise<WorkflowState[]> {
    const newestFirst: WorkflowState[] = []
    const seen = new Set([this.scope.runId])
    let parentRunId = firstParentRunId

    // WHY ancestry is read as reduced snapshots rather than copying old events into the new run:
    // a resume is intentionally a new immutable execution with its own cursor and terminal state.
    // Re-appending a parent's run.cancelled event would make the child terminal before it starts,
    // while duplicating a large event log on every resume would grow quadratically. Snapshots retain
    // the complete agent attempt/activity tree, so the renderer can compose history without
    // weakening either run's durability or cursor invariants.
    while (parentRunId !== undefined) {
      if (generation !== this.generation) return []
      // Claude-native imports can seed Agent Code's first resume with an external `wf_...` parent.
      // That identifier is useful lineage metadata but is not addressable by WorkflowService,
      // whose owned IDs are `run_...`. Stop at the ownership boundary instead of generating an
      // invalid snapshot request and a noisy performance error every time the view is opened.
      if (!parentRunId.startsWith('run_')) break
      if (seen.has(parentRunId)) {
        throw new Error(`Workflow resume lineage contains a cycle at ${parentRunId}.`)
      }
      seen.add(parentRunId)

      const parentScope = { cwd: this.scope.cwd, runId: parentRunId }
      const parent = await this.client.getSnapshot(parentScope)
      // Claude-native imports name an external run at the root of the lineage. Agent Code cannot
      // snapshot that foreign store, but every Agent Code-owned ancestor above it is still useful.
      if (!parent) break
      newestFirst.push((await this.replayEnvelope(parentScope, parent, generation)).state)
      parentRunId = parent.manifest?.resumedFromRunId
    }

    return newestFirst.reverse()
  }

  private async replayEnvelope(
    scope: WorkflowRunScope,
    envelope: NonNullable<Awaited<ReturnType<WorkflowClient['getSnapshot']>>>,
    generation: number,
  ): Promise<{ state: WorkflowState; cursor: number }> {
    let state = envelope.state
    let cursor = envelope.cursor
    // Older/fake transports may still return an already-reduced envelope without a manifest.
    // WHY the fallback is the envelope cursor rather than an invented "latest" request: only the
    // manifest can prove that durable events exist beyond the reduced state. Reading speculatively
    // would turn optional ancestry into an unbounded poll and make tests/remote clients implement
    // a desktop-only bootstrap detail merely to render an otherwise complete parent.
    const target = envelope.manifest?.cursor ?? envelope.cursor
    while (cursor < target) {
      const before = cursor
      const page = await this.client.readEvents({ ...scope, after: cursor, limit: 500, waitMs: 0 })
      if (generation !== this.generation) return { state, cursor }
      for (const stored of [...page.events].sort((a, b) => a.cursor - b.cursor)) {
        if (stored.runId !== scope.runId || stored.cursor <= cursor) continue
        if (stored.cursor !== cursor + 1) {
          throw new Error(`Workflow ancestry gap after cursor ${cursor}.`)
        }
        state = reduceWorkflowState(state, stored.event)
        cursor = stored.cursor
      }
      if (cursor === before) throw new Error(`Workflow ancestry replay made no progress after ${before}.`)
      if (!page.hasMore && cursor >= target) break
      await yieldToRenderer()
    }
    return { state, cursor }
  }

  private async applyBatchOrRepair(
    batch: WorkflowEventBatch,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return
    if (batch.toCursor <= this.view.cursor) {
      this.client.acknowledge({ ...this.scope, cursor: this.view.cursor })
      return
    }
    if (this.reduceContiguous(batch.events) && this.view.cursor >= batch.toCursor) {
      this.client.acknowledge({ ...this.scope, cursor: this.view.cursor })
      return
    }

    // A push is a latency optimization, never the source of truth. If it exposes a cursor gap,
    // fill from the persisted event log rather than guessing that a missing activity update was
    // disposable. Guessing is how an inspector ends up plausible-but-wrong after IPC coalescing.
    let target = batch.toCursor
    while (this.view.cursor < target) {
      const before = this.view.cursor
      const page = await this.client.readEvents({
        ...this.scope,
        after: before,
        limit: 500,
        waitMs: 0,
      })
      if (generation !== this.generation) return
      target = Math.max(target, page.toCursor)
      if (!this.reduceContiguous(page.events)) {
        throw new Error(
          `Workflow event gap after cursor ${before}; durable replay began at a later sequence.`,
        )
      }
      if (this.view.cursor === before) {
        throw new Error(
          `Workflow event gap after cursor ${before}; durable replay returned no progress.`,
        )
      }
      // WHY every durable page ends with a macrotask boundary: awaiting IPC is
      // not a reliable yield once responses are already queued. A resumed fat
      // run can make dozens of readEvents promises resolve back-to-back, and
      // reducing them in one microtask chain starves input, paint, and the
      // heartbeat even though each individual page is byte-bounded.
      if (!page.hasMore && this.view.cursor >= target) break
      await yieldToRenderer()
      if (generation !== this.generation) return
    }
    this.client.acknowledge({ ...this.scope, cursor: this.view.cursor })
  }
}

const storesByClient = new WeakMap<WorkflowClient, Map<string, WorkflowRunStore>>()
const MAX_CACHED_WORKFLOW_STORES = 32

export function getWorkflowRunStore(
  client: WorkflowClient,
  scope: WorkflowRunScope,
): WorkflowRunStore {
  let stores = storesByClient.get(client)
  if (!stores) {
    stores = new Map()
    storesByClient.set(client, stores)
  }
  const key = `${scope.cwd}\u0000${scope.runId}`
  let store = stores.get(key)
  if (!store) {
    store = new WorkflowRunStore(client, scope)
    stores.set(key, store)
    if (stores.size > MAX_CACHED_WORKFLOW_STORES) {
      // WHY cache eviction targets only idle stores: active cards may still hold the object even if
      // its map entry disappears. Removing an active entry would let a second card create another
      // reducer/subscription for the same run and duplicate every durable read. Insertion order is a
      // sufficient LRU approximation because lookups below refresh the entry.
      for (const [candidateKey, candidate] of stores) {
        if (candidateKey === key || !candidate.canEvict()) continue
        stores.delete(candidateKey)
        if (stores.size <= MAX_CACHED_WORKFLOW_STORES) break
      }
    }
  } else {
    stores.delete(key)
    stores.set(key, store)
  }
  return store
}

export function useWorkflowRun(
  client: WorkflowClient,
  scope: WorkflowRunScope,
): { view: WorkflowRunView; store: WorkflowRunStore } {
  const store = useMemo(
    () => getWorkflowRunStore(client, scope),
    [client, scope.cwd, scope.runId],
  )
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { view, store }
}
