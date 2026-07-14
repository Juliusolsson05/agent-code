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
  private pendingBeforeSnapshot: WorkflowEventBatch[] = []
  private syncTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly client: WorkflowClient,
    readonly scope: WorkflowRunScope,
  ) {
    this.view = {
      phase: client.available ? 'loading' : 'unavailable',
      snapshot: createWorkflowState(scope.runId),
      cursor: 0,
    }
  }

  getSnapshot = (): WorkflowRunView => this.view

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
    this.setView({ phase: 'loading', snapshot: this.view.snapshot, cursor: this.view.cursor })
    if (this.listeners.size > 0) void this.start()
  }

  private setView(next: WorkflowRunView): void {
    if (
      next.phase === this.view.phase &&
      next.snapshot === this.view.snapshot &&
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
    this.pendingBeforeSnapshot = []
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const generation = ++this.generation

    if (!this.client.available) {
      this.setView({ phase: 'unavailable', snapshot: this.view.snapshot, cursor: this.view.cursor })
      return
    }

    // Subscribe BEFORE reading the snapshot. Otherwise an event persisted between the snapshot
    // response and listener registration is invisible until another event happens to reveal the
    // sequence gap. Batches received during bootstrap are buffered, then compared against the
    // authoritative snapshot cursor.
    try {
      this.stopPush = this.client.subscribe((batch) => {
        if (!validBatchForScope(batch, this.scope) || generation !== this.generation) return
        if (this.view.phase === 'loading') {
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
          cursor: this.view.cursor,
          error: 'Workflow run was not found in this project.',
        })
        return
      }
      this.setView({ phase: 'ready', snapshot: envelope.state, cursor: envelope.cursor })
      const pending = this.pendingBeforeSnapshot
      this.pendingBeforeSnapshot = []
      for (const batch of pending) this.enqueueBatch(batch, generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.setView({
        phase: 'error',
        snapshot: this.view.snapshot,
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
        this.setView({
          phase: 'error',
          snapshot: this.view.snapshot,
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
    if (changed) this.setView({ phase: 'ready', snapshot, cursor })
    return true
  }

  private async applyBatchOrRepair(
    batch: WorkflowEventBatch,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return
    if (batch.toCursor <= this.view.cursor) return
    if (this.reduceContiguous(batch.events) && this.view.cursor >= batch.toCursor) return

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
      if (!page.hasMore && this.view.cursor >= target) break
    }
  }
}

const storesByClient = new WeakMap<WorkflowClient, Map<string, WorkflowRunStore>>()

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
