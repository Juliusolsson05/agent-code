// The ONE owner of history-boundary decisions for desktop, phone and replay.
//
// Grok rewrites its transcript file in place (rewind, compaction, resume,
// first-prompt rewrite; grok catalog history.replacement) and the runtime
// reports each rewrite as a `history-boundary` event: `reset` (a generation's
// snapshot starts re-delivering) then `caught-up` (the snapshot is complete).
// A boundary is NEVER turn completion or idle, and rows re-delivered inside a
// snapshot are marked `inRewriteSnapshot` upstream — but the feed consumers
// only see entries and boundaries, so SOMETHING must decide what a boundary
// does to a transcript window.
//
// WHY this module and not the phone's resetTranscript: before it existed, the
// phone detected transcript rolls heuristically from a changed file name
// (reactive — the roll is only noticed when the first new-file entry arrives,
// and same-file rewrites are invisible) and reset locally; the desktop had no
// roll concept at all. Two UIs making their own authority decisions under the
// same input is exactly the divergence Stage 5 exists to prevent, so the
// DECISIONS live here as pure functions over primitives and each client only
// applies them to its own container. The phone's proven ideas — the
// preserve-list (a reset must not look like the process died) and the
// awaiting-turn-start semantic gate (stale semantic suffixes must not repaint
// a wiped window) — moved here unchanged in meaning.
//
// The module is deliberately tiny and dependency-free: it must be importable
// by the renderer, the remote-client, and the replay harness alike.

import type { ProviderHistoryBoundaryEvent } from '@shared/types/session.js'

/** What a feed history boundary is: the session event payload plus its file. */
export type HistoryBoundary = ProviderHistoryBoundaryEvent & { file: string }

/**
 * The per-session window identity a boundary decision is made against. Null
 * before the first boundary is seen — the pre-boundary world (all other
 * providers) behaves exactly as before by construction: `decide` never fires
 * without an explicit boundary event.
 */
export type HistoryWindow = {
  /** The generation the window currently holds; null until a boundary arrives. */
  generation: number | null
  /** The file the window was last reset against. */
  file: string | null
  /** True while a reset was applied and its snapshot re-delivery has not finished. */
  awaitingCaughtUp: boolean
}

export function emptyHistoryWindow(): HistoryWindow {
  return { generation: null, file: null, awaitingCaughtUp: false }
}

export type HistoryBoundaryDecision =
  | {
      /** A rewrite of a NEWER generation (or the first ever seen): the window's
       * entries, dedup sets and semantic turn state were superseded and must be
       * cleared now; semantic suffixes are dropped until a fresh turn starts. */
      kind: 'apply-reset'
      generation: number
      file: string
    }
  | {
      /** The snapshot re-delivery finished: the window is complete again. No
       * clearing — rows arrived as normal entries after the reset. */
      kind: 'observe-caught-up'
      generation: number
      file: string
    }
  | {
      /** An older or equal generation than the window holds (or a caught-up for
       * a generation never reset): stale, ignore. Native can re-deliver a
       * boundary during reconnect; replaying one must not wipe a live window. */
      kind: 'stale'
      reason: string
    }

/**
 * Decide what a boundary means for a window. Pure; callers apply the decision.
 *
 * WHY `caught-up` does not clear anything: a boundary is never completion or
 * idle (catalog history.durable), and the snapshot's rows already arrived as
 * ordinary entries — a second clear would drop the conversation it just
 * re-delivered.
 *
 * WHY `reset` requires a STRICTLY newer generation: the same generation's
 * reset can be re-delivered after a transport reconnect; wiping a healthy
 * window because a duplicate boundary arrived late is the exact replay hazard
 * the reconnect recordings must pin.
 */
export function decideHistoryBoundary(window: HistoryWindow, boundary: HistoryBoundary): HistoryBoundaryDecision {
  if (boundary.type === 'reset') {
    if (window.generation !== null && boundary.generation <= window.generation) {
      return { kind: 'stale', reason: `reset for generation ${boundary.generation} at or behind window generation ${window.generation}` }
    }
    return { kind: 'apply-reset', generation: boundary.generation, file: boundary.file }
  }
  if (boundary.type === 'caught-up') {
    // A caught-up for a generation the window never reset against is a
    // re-delivery artifact (or a race with a first snapshot); it describes a
    // snapshot the window did not open, so observing it is at most a marker.
    if (window.generation === null || boundary.generation !== window.generation) {
      return { kind: 'stale', reason: `caught-up for generation ${boundary.generation} does not match window generation ${window.generation}` }
    }
    return { kind: 'observe-caught-up', generation: boundary.generation, file: boundary.file }
  }
  return { kind: 'stale', reason: 'unknown boundary type' }
}

/** Advance the window identity after applying a decision (pure). */
export function applyDecisionToWindow(window: HistoryWindow, decision: HistoryBoundaryDecision): HistoryWindow {
  switch (decision.kind) {
    case 'apply-reset':
      return { generation: decision.generation, file: decision.file, awaitingCaughtUp: true }
    case 'observe-caught-up':
      return { ...window, awaitingCaughtUp: false }
    case 'stale':
      return window
  }
}

/**
 * Whether a history chunk (initial or older-history load) belongs to the
 * window's current identity. Generalizes the phone's file-conflict rejection:
 * a chunk naming a DIFFERENT file than the live window is a stale cache reply
 * from before a roll (the phone already rejected these), and once a boundary
 * generation is known the chunk must not be OLDER than it either.
 */
export function isStaleHistoryChunk(window: HistoryWindow, chunk: { file: string; generation?: number }): boolean {
  if (window.file !== null && chunk.file !== window.file) return true
  if (window.generation !== null && chunk.generation !== undefined && chunk.generation < window.generation) return true
  return false
}

/**
 * The preserve list, stated once so both clients and replay agree on what a
 * reset does NOT touch. A transcript rewrite is not a process death:
 * conditions, busy state, screen text and exit state all describe the LIVE
 * session, which the rewrite does not change (the phone's resetTranscript
 * proved this list; it moves here unchanged in meaning).
 */
export const HISTORY_RESET_PRESERVES = [
  'conditions',
  'workingStatus',
  'screenText',
  'exited',
] as const
