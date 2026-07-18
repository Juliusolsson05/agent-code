import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  RenderShapeAppendResult,
  RenderOutcome,
  RenderOutcomeRoute,
  RenderShapeLifecycle,
  RenderShapePlane,
  RenderShapeSighting,
} from '@shared/types/renderShapes'
import { renderShapeWriterKey } from '@shared/types/renderShapes'
import { fingerprintRenderShape } from '@renderer/rendering/evidence/shapeFingerprint'
import { hashPayload } from '@renderer/rendering/model/unknowns'
import { resolveRenderShapeDefinition } from '@providers/registry.renderShapes'

// ---------------------------------------------------------------------------
// Render-shape observer — Phase 2 of the evidence-first rendering plan
// (PR #554/#555). The bounded per-session sighting sink.
//
// ARCHITECTURE: plain module state, deliberately NOT React state and NOT a
// zustand store. Observation happens during paint (the painter is exactly
// where the shape is about to be interpreted); routing it through React
// state would schedule re-renders from inside render — the one thing the
// Phase 2 exit gate forbids ("capture-on does not alter the render tree").
// Module state mutated during render is safe here because nothing ever
// reads it back into the tree. The precedent is rawCapture.ts
// (setSemanticRawCaptureEnabled): process-wide diagnostic state behind a
// module setter.
//
// StrictMode/concurrent caveat, accepted by contract: React may run a
// render without committing it, so counters can over-count and an
// uncommitted render's NOVEL shape can leave a sighting for a route that
// never hit the DOM. The dedup key makes duplicates merge (never new sidecar
// lines), and sighting counts are documented as approximate — evidence of
// existence and rough volume, not an exact commit meter. Receipts name the
// exact painter decision React evaluated; they deliberately do not claim a
// browser-paint acknowledgement that this render-time observer cannot prove.
//
// BACKPRESSURE BY CONSTRUCTION (the renderer-freeze lesson — a diagnostic
// must never become the performance bug):
//   1. armed check is one Map.get — the cost when capture is off;
//   2. repeats of a known key bump a local counter, NO queue entry;
//   3. the outbound queue is hard-capped (drop + count, never grow);
//   4. flushes are timer-coalesced (one IPC batch / interval, max);
//   5. every failure is swallowed and counted — a diagnostic throw can
//      never reach the provider/feed path (exit gate).
// A thousand identical partial-JSON deltas therefore produce at most a
// handful of milestone sightings and zero extra IPC messages.
// ---------------------------------------------------------------------------

/** One coalesced IPC send per interval at most. 2 s is deliberately lazy:
 *  sightings are forensic, not interactive — nothing reads them live. */
const FLUSH_INTERVAL_MS = 2000
/** Hard cap on queued-but-unflushed sightings per session. 256 distinct NEW
 *  keys inside one flush window means something pathological is emitting
 *  novel structures per tick; shed and count rather than buffer. */
const MAX_QUEUE = 256
/** Hard cap on distinct dedup keys tracked per session. Beyond it new keys
 *  are dropped+counted — an unbounded key set is the same heap leak the
 *  queue cap exists to prevent, just slower. */
const MAX_KEYS = 4096
/** Leave headroom below main's 1 MiB trust-boundary cap. JSON string length
 * is the boundary's current metric, so using the same metric here makes the
 * split deterministic without allocating a second byte buffer. */
const MAX_BATCH_JSON_CHARS = 900 * 1024

export type ObserveRenderShapeInput = {
  sessionId: string
  provider: AgentProviderKind | 'unknown'
  plane: RenderShapePlane
  lifecycle: RenderShapeLifecycle
  eventType: string
  payload: unknown
  outcome: RenderOutcomeRoute
}

type TrackedSighting = {
  sighting: RenderShapeSighting
  count: number
  /** Count already persisted to the sidecar. 1 after a successful first
   *  enqueue, 0 when that enqueue was shed by a full queue (review
   *  finding: the optimistic 1 made a shed-once key unrecoverable — the
   *  final flush only re-emits keys with count > flushedCount). */
  flushedCount: number
}

type SessionObserverState = {
  generation: string
  keys: Map<string, TrackedSighting>
  /** Dedup keys, not snapshot objects. Counts continue changing while an IPC
   * is in flight; materializing only at send time prevents stale-count queue
   * entries from winning over newer local evidence. */
  queue: string[]
  queuedKeys: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void> | null
  stopping: boolean
  droppedQueue: number
  droppedKeys: number
  failures: number
}

/**
 * A recorder generation, not a session id, owns buffered evidence.
 *
 * WHY two indexes: stopping generation A may still be awaiting its final IPC
 * acknowledgement after generation B has started for the same session. Keying
 * state only by session id lets A's eventual cleanup delete B, while replacing
 * A immediately loses the only state from which its final counts can flush.
 * Keeping every live generation addressable and selecting one active generation
 * for paint gives both lifecycles an independent, deterministic owner.
 */
const sessionsByGeneration = new Map<string, SessionObserverState>()
const activeGenerations = new Map<string, string>()
const retiredStats = { droppedQueue: 0, droppedKeys: 0, failures: 0 }

function sessionGenerationKey(sessionId: string, generation: string): string {
  return `${sessionId}\u0000${generation}`
}

function stateForGeneration(sessionId: string, generation: string): SessionObserverState | undefined {
  return sessionsByGeneration.get(sessionGenerationKey(sessionId, generation))
}

function activeState(sessionId: string): SessionObserverState | undefined {
  const generation = activeGenerations.get(sessionId)
  return generation === undefined ? undefined : stateForGeneration(sessionId, generation)
}

/** Debug-panel visibility for swallowed problems (exit gate: failures are
 *  "swallowed, counted, surfaced"). Read-only aggregate snapshot. */
export function renderShapeObserverStats(): {
  armedSessions: number
  droppedQueue: number
  droppedKeys: number
  failures: number
} {
  let droppedQueue = retiredStats.droppedQueue
  let droppedKeys = retiredStats.droppedKeys
  let failures = retiredStats.failures
  for (const s of sessionsByGeneration.values()) {
    droppedQueue += s.droppedQueue
    droppedKeys += s.droppedKeys
    failures += s.failures
  }
  return { armedSessions: activeGenerations.size, droppedQueue, droppedKeys, failures }
}

export function isRenderShapeCaptureArmed(sessionId: string, generation?: string): boolean {
  return generation === undefined
    ? activeState(sessionId) !== undefined
    : stateForGeneration(sessionId, generation) !== undefined
}

/** Arm capture for one session. Idempotent. Called by the recording toggle
 *  command (capture rides session recording — plan §Step 1) and by the
 *  capture context's mount sync (which ARMS ONLY — see that file's WHY). */
export function armRenderShapeCapture(sessionId: string, generation: string): void {
  if (!sessionId || !generation) return
  const key = sessionGenerationKey(sessionId, generation)
  if (!sessionsByGeneration.has(key)) sessionsByGeneration.set(key, {
    generation,
    keys: new Map(),
    queue: [],
    queuedKeys: new Set(),
    timer: null,
    inFlight: null,
    stopping: false,
    droppedQueue: 0,
    droppedKeys: 0,
    failures: 0,
  })
  // A duplicate push/query for the same generation is intentionally
  // idempotent. A different generation is a real recorder replacement and
  // becomes paint's owner without destroying its predecessor's final flush.
  activeGenerations.set(sessionId, generation)
}

/**
 * Disarm + final flush. Re-emits every key whose local count grew past what
 * the sidecar has seen, carrying `seenCount` — the "final count flush" arm
 * of the plan's coalescing contract. ASYNC and awaited by the stop command
 * so the last batches land before the recorder finalizes (review finding:
 * fire-and-forget lost final counts when the recorder closed first).
 *
 * The final batches BYPASS the live queue cap (review finding: draining
 * through the 256-slot queue silently shed everything past 256 grown keys)
 * — they go straight out in bounded chunks instead; the cap exists to bound
 * steady-state memory, not to lose the shutdown accounting.
 */
export async function disarmRenderShapeCapture(sessionId: string, generation: string): Promise<void> {
  const state = stateForGeneration(sessionId, generation)
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
  state.stopping = true
  try {
    // An acknowledged queue cannot delete state optimistically. Wait for the
    // active IPC receipt first, then compute the final delta from the updated
    // counters. This closes the one-off-sighting loss window found in review.
    await state.inFlight
    const now = Date.now()
    const finals: PendingSnapshot[] = []
    for (const tracked of state.keys.values()) {
      if (tracked.count > tracked.flushedCount) {
        // Fresh observedAt: the final copy is the LATEST evidence for the
        // key; reusing first-sight time made lastSeenAt lie in reports.
        const sighting = { ...tracked.sighting, seenCount: tracked.count, observedAt: now }
        finals.push({
          key: renderShapeWriterKey(sighting),
          sighting,
          seenCount: tracked.count,
        })
      }
    }
    await transmitSnapshots(sessionId, state, finals)
  } catch {
    /* disarm must never throw into a command handler */
  } finally {
    // Keep the state addressable until every bounded final attempt finishes.
    // Deleting it before awaiting IPC was the original shutdown data-loss bug.
    retireSession(sessionId, generation, state)
  }
}

/**
 * The single observation entry point, called from paint code. MUST be safe
 * to call from anywhere: every failure mode is caught, counted, and
 * swallowed here so no call site needs its own guard.
 */
export function observeRenderShape(input: ObserveRenderShapeInput): void {
  const state = activeState(input.sessionId)
  if (!state) return
  try {
    const { fingerprint, shapePaths, discriminatorValues } = fingerprintRenderShape({
      provider: input.provider,
      plane: input.plane,
      eventType: input.eventType,
      payload: input.payload,
    })
    const definition = resolveRenderShapeDefinition({
      provider: input.provider,
      fingerprint,
      plane: input.plane,
      eventType: input.eventType,
      lifecycle: input.lifecycle,
    })
    const outcome: RenderOutcome = input.outcome.kind === 'unknown'
      ? input.outcome
      : { ...input.outcome, shapeId: definition?.id ?? null }
    // Outcome kind AND the route identity (rendererId/owner/surface) are
    // part of the key: the same structure legitimately routes differently
    // by CONTENT (git Bash → widget, plain Bash → generic), and merging
    // those under one key hid the second route entirely — the exact
    // misrouting evidence the receipts exist to provide (review finding #4).
    // These id vocabularies are small and closed, so no cardinality risk.
    const key = renderShapeWriterKey({
      provider: input.provider,
      sourcePlane: input.plane,
      lifecycle: input.lifecycle,
      eventType: input.eventType,
      structuralFingerprint: fingerprint,
      outcome,
    })
    const existing = state.keys.get(key)
    if (existing) {
      existing.count += 1
      enqueue(state, key)
      scheduleFlush(input.sessionId, state)
      return
    }
    if (state.keys.size >= MAX_KEYS) {
      state.droppedKeys += 1
      return
    }
    const sighting: RenderShapeSighting = {
      schemaVersion: 2,
      sessionId: input.sessionId,
      provider: input.provider,
      // Provenance audit is plan open-decision #2; until it lands these are
      // honest unknowns, never inferred from content.
      providerVersion: null,
      model: null,
      sourcePlane: input.plane,
      lifecycle: input.lifecycle,
      eventType: input.eventType,
      structuralFingerprint: fingerprint,
      shapePaths,
      discriminatorValues,
      payloadHash: hashPayload(input.payload),
      // The sidecar line is appended into the SAME events.jsonl the real
      // channels stream into, so its position IS the cursor; a renderer-side
      // index would only drift from the writer's truth.
      sourceRecordingCursor: null,
      observedAt: Date.now(),
      outcome,
      // Every writer in this PR emits an explicit cumulative count. Keeping
      // the field required avoids inventing a compatibility path for a wire
      // shape that never shipped outside this branch.
      seenCount: 1,
    }
    state.keys.set(key, { sighting, count: 1, flushedCount: 0 })
    enqueue(state, key)
    scheduleFlush(input.sessionId, state)
  } catch {
    state.failures += 1
  }
}

function enqueue(state: SessionObserverState, key: string): boolean {
  if (state.queuedKeys.has(key)) return true
  if (state.queue.length >= MAX_QUEUE) {
    state.droppedQueue += 1
    return false
  }
  state.queue.push(key)
  state.queuedKeys.add(key)
  return true
}

function scheduleFlush(sessionId: string, state: SessionObserverState): void {
  if (
    state.timer ||
    state.stopping ||
    state.queue.length === 0 ||
    stateForGeneration(sessionId, state.generation) !== state
  ) return
  state.timer = setTimeout(() => {
    state.timer = null
    void flushNow(sessionId, state)
  }, FLUSH_INTERVAL_MS)
}

async function flushNow(sessionId: string, state: SessionObserverState): Promise<void> {
  if (state.inFlight) {
    await state.inFlight
    return
  }
  if (state.queue.length === 0) return
  const run = flushQueued(sessionId, state)
  state.inFlight = run
  try {
    await run
  } finally {
    if (state.inFlight === run) state.inFlight = null
    if (state.queue.length > 0) scheduleFlush(sessionId, state)
  }
}

type PendingSnapshot = {
  key: string
  sighting: RenderShapeSighting
  seenCount: number
}

async function flushQueued(sessionId: string, state: SessionObserverState): Promise<void> {
  const now = Date.now()
  const snapshots: PendingSnapshot[] = []
  for (const key of state.queue.slice(0, MAX_QUEUE)) {
    const tracked = state.keys.get(key)
    if (!tracked || tracked.count <= tracked.flushedCount) {
      removeQueued(state, [key])
      continue
    }
    snapshots.push({
      key,
      seenCount: tracked.count,
      sighting: { ...tracked.sighting, seenCount: tracked.count, observedAt: now },
    })
  }
  await transmitSnapshots(sessionId, state, snapshots)
}

/**
 * Send count snapshots only after main acknowledges them. A failed/no-recorder
 * call leaves every key queued, while an accepted subset advances exactly its
 * own persisted count. Oversized aggregate batches split recursively; an
 * irreducibly oversized single sighting is dropped and counted so a malformed
 * dynamic key cannot create an infinite two-second retry loop.
 */
async function transmitSnapshots(
  sessionId: string,
  state: SessionObserverState,
  snapshots: PendingSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return

  const chunks: PendingSnapshot[][] = []
  let chunk: PendingSnapshot[] = []
  let chars = 2
  for (const snapshot of snapshots) {
    let nextChars: number
    try {
      nextChars = JSON.stringify(snapshot.sighting).length + (chunk.length > 0 ? 1 : 0)
    } catch {
      dropSnapshots(state, [snapshot])
      continue
    }
    if (chunk.length > 0 && (chunk.length >= MAX_QUEUE || chars + nextChars > MAX_BATCH_JSON_CHARS)) {
      chunks.push(chunk)
      chunk = []
      chars = 2
    }
    chunk.push(snapshot)
    chars += nextChars
  }
  if (chunk.length > 0) chunks.push(chunk)

  for (const candidate of chunks) await transmitOne(sessionId, state, candidate)
}

async function transmitOne(
  sessionId: string,
  state: SessionObserverState,
  snapshots: PendingSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return
  try {
    const result: RenderShapeAppendResult = await window.api.appendRenderShapeSightings(
      sessionId,
      state.generation,
      snapshots.map(snapshot => snapshot.sighting),
    )
    if (result.status === 'accepted') {
      acknowledgeSnapshots(state, snapshots)
      return
    }
    state.failures += 1
    if (result.status === 'no-recorder') {
      // The recorder-start push is the arming authority. Once main explicitly
      // says this session has no recorder, polling the same negative answer is
      // stale compatibility machinery, not recovery. Retire immediately; a
      // later real start push can arm a fresh observer with a fresh writer.
      if (stateForGeneration(sessionId, state.generation) === state) {
        retireSession(sessionId, state.generation, state)
      }
      return
    }
    if ((result.reason === 'too-many' || result.reason === 'too-large') && snapshots.length > 1) {
      const middle = Math.ceil(snapshots.length / 2)
      await transmitOne(sessionId, state, snapshots.slice(0, middle))
      await transmitOne(sessionId, state, snapshots.slice(middle))
      return
    }
    dropSnapshots(state, snapshots)
  } catch {
    // window.api absent (tests without preload) or IPC failure — swallowed
    // by contract. Keep the snapshots for the final stop handshake, but do
    // not manufacture a polling protocol on top of an event-driven recorder.
    state.failures += 1
    removeQueued(state, snapshots.map(snapshot => snapshot.key))
  }
}

function acknowledgeSnapshots(state: SessionObserverState, snapshots: PendingSnapshot[]): void {
  const completed: string[] = []
  for (const snapshot of snapshots) {
    const tracked = state.keys.get(snapshot.key)
    if (!tracked) continue
    tracked.flushedCount = Math.max(tracked.flushedCount, snapshot.seenCount)
    if (tracked.count <= snapshot.seenCount) completed.push(snapshot.key)
  }
  removeQueued(state, completed)
}

function dropSnapshots(state: SessionObserverState, snapshots: PendingSnapshot[]): void {
  state.droppedQueue += snapshots.length
  // An invalid/irreducibly-large snapshot cannot become valid by retrying.
  // Advance its local watermark so final shutdown does not resend it forever.
  acknowledgeSnapshots(state, snapshots)
}

function removeQueued(state: SessionObserverState, keys: readonly string[]): void {
  if (keys.length === 0) return
  const removed = new Set(keys)
  state.queue = state.queue.filter(key => !removed.has(key))
  for (const key of removed) state.queuedKeys.delete(key)
}

function retireSession(sessionId: string, generation: string, state: SessionObserverState): void {
  const key = sessionGenerationKey(sessionId, generation)
  if (sessionsByGeneration.get(key) !== state) return
  sessionsByGeneration.delete(key)
  // Generation A's delayed stop must never disarm replacement B. Only the
  // active generation is allowed to clear the session's paint-time selector.
  if (activeGenerations.get(sessionId) === generation) activeGenerations.delete(sessionId)
  retiredStats.droppedQueue += state.droppedQueue
  retiredStats.droppedKeys += state.droppedKeys
  retiredStats.failures += state.failures
}
