import type {
  DispatchLane,
  DispatchModeState,
  SessionId,
  TiledDispatchState,
  WorkspaceState,
} from '@renderer/workspace/types'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  MAX_DISPATCH_TILES,
  MIN_DISPATCH_TILES,
  normalizeGridShape,
} from '@renderer/workspace/dispatch/gridShape'

// ============================================================================
// Tiled-lane coherence helpers
//
// Tiled Dispatch keeps a per-lane session selection in
// dispatchMode.tiled.lanes[].selectedSessionId, plus the focused lane in
// dispatchMode.tiled.focusedLane. Two whole bug classes came from code that
// mutated *which session a pane shows* (id remap, session removal) or
// *resolved the focused session* while only maintaining the grid tree,
// detachedSessions, and the single dispatchMode.focusedSessionId — leaving the
// tiled lanes stale. A stale lane points at a dead/missing id, laneResolutions
// can't resolve it, and the layout's auto-fill effect silently re-homes it to
// the first agent (the "everything jumps to tile 1 / resume doesn't resume"
// symptoms). These helpers are the single, reusable way to keep lanes
// coherent; apply them at EVERY id-remap, removal, and focus-read site.
// ============================================================================

/**
 * Remap every tiled lane's selectedSessionId through an old->new id map.
 * Lanes whose id isn't in the map (e.g. hibernated/detached sessions kept
 * under their original id on rehydrate) are left untouched. Returns the same
 * reference when nothing changed. Apply wherever a live session's id is
 * swapped (replaceSession, reloadAgentSessions, rehydrate, undo-close).
 */
export function remapTiledLanes(
  dispatchMode: DispatchModeState | null,
  idMap: ReadonlyMap<SessionId, SessionId>,
): DispatchModeState | null {
  if (!dispatchMode?.tiled) return dispatchMode
  let changed = false
  const lanes = dispatchMode.tiled.lanes.map(lane => {
    const id = lane.selectedSessionId
    if (!id) return lane
    const next = idMap.get(id)
    if (!next || next === id) return lane
    changed = true
    return { ...lane, selectedSessionId: next }
  })
  if (!changed) return dispatchMode
  return { ...dispatchMode, tiled: { ...dispatchMode.tiled, lanes } }
}

/**
 * Put a session into a lane.
 *
 * WHY a helper for a one-field write: lane construction stays in one place, so
 * a future field with a maintenance rule has exactly one filling site to add it
 * to. This helper used to carry such a rule — it stripped `userEmptied`, which
 * had to be dropped at every writer and was missed at two of them (the spawn
 * focus path and the A2! index path), turning a filled lane into a permanent
 * hole that survived restarts. That flag is gone with the healer it existed to
 * hide from (#681), and the rule went with it.
 */
export function withLaneSession(lane: DispatchLane, sessionId: SessionId): DispatchLane {
  return { ...lane, selectedSessionId: sessionId }
}

/** Blank a lane's selection. Nothing refills it; that is the point (#681). */
function withLaneCleared(lane: DispatchLane): DispatchLane {
  return { ...lane, selectedSessionId: undefined }
}

/**
 * Clear any tiled lane pointing at a removed session (selectedSessionId ->
 * undefined). The lane then renders empty and STAYS empty — before #681 the
 * layout re-homed another agent into the hole, which is what made closing one
 * agent silently move an unrelated one into the slot you were watching.
 * Apply wherever a session is destroyed/hidden (killSession, close, bury).
 */
export function clearTiledLaneSessions(
  dispatchMode: DispatchModeState | null,
  removed: ReadonlySet<SessionId> | SessionId,
): DispatchModeState | null {
  if (!dispatchMode?.tiled) return dispatchMode
  const isRemoved = (id: SessionId): boolean =>
    typeof removed === 'string' ? removed === id : removed.has(id)
  let changed = false
  const lanes = dispatchMode.tiled.lanes.map(lane => {
    if (lane.selectedSessionId && isRemoved(lane.selectedSessionId)) {
      changed = true
      return withLaneCleared(lane)
    }
    return lane
  })
  if (!changed) return dispatchMode
  return { ...dispatchMode, tiled: { ...dispatchMode.tiled, lanes } }
}

/**
 * Keep only lane selections present in a known-live set.
 *
 * WHY this is a keep-set helper instead of reusing clearTiledLaneSessions:
 * the autosave ownership prune computes the ids that survived, not the ids
 * that were removed. Building a removed set from stale/corrupt input would
 * make the durability boundary depend on metadata that has already been
 * judged untrusted. This helper answers the prune question directly: every
 * durable session pointer must close over the same surviving session set.
 */
export function keepTiledLaneSessions(
  dispatchMode: DispatchModeState | null | undefined,
  keep: ReadonlySet<SessionId>,
): DispatchModeState | null | undefined {
  if (!dispatchMode?.tiled) return dispatchMode
  let changed = false
  const lanes = dispatchMode.tiled.lanes.map(lane => {
    if (lane.selectedSessionId && !keep.has(lane.selectedSessionId)) {
      changed = true
      return withLaneCleared(lane)
    }
    return lane
  })
  if (!changed) return dispatchMode
  return { ...dispatchMode, tiled: { ...dispatchMode.tiled, lanes } }
}

/**
 * Bring a persisted `tiled` block up to the current grid shape.
 *
 * WHY this belongs with the other dispatchMode helpers rather than inside
 * gridShape: this file's header says the lane helpers must be applied at every
 * id-remap, removal, and focus-read site, and rehydrate is one of them — the
 * normalization has to sit on the same DispatchModeState-shaped seam as
 * remapTiledLanes and keepTiledLaneSessions so it can be composed with them in
 * one expression instead of being a fourth thing a caller must remember.
 *
 * The migration itself (legacy `ratios` -> per-row indexFraction + laneWeights,
 * and repair of the row-length invariant) lives in gridShape, which owns every
 * shape rule.
 *
 * Returns the SAME reference when nothing needed changing, so consumers that
 * memoize on dispatchMode identity do not churn on every restore.
 */
export function normalizeDispatchModeGrid(
  dispatchMode: DispatchModeState | null | undefined,
): DispatchModeState | null | undefined {
  const tiled = dispatchMode?.tiled
  if (!dispatchMode || !tiled) return dispatchMode

  const grid = normalizeGridShape(tiled)
  const alreadyCurrent =
    tiled.ratios === undefined &&
    tiled.rows === grid.rows &&
    tiled.laneWeights === grid.laneWeights &&
    tiled.focusedLane === grid.focusedLane
  if (alreadyCurrent) return dispatchMode

  return {
    ...dispatchMode,
    tiled: {
      lanes: grid.lanes,
      rows: grid.rows,
      focusedLane: grid.focusedLane,
      // Dropped, never rewritten: keeping the legacy array beside the fields it
      // was split into would leave two sources of truth for width, and the next
      // reader would have to guess which one the user's last drag produced.
      ...(grid.laneWeights ? { laneWeights: grid.laneWeights } : {}),
    },
  }
}

/**
 * The session the user is currently focused on in Dispatch — the SINGLE
 * tiled-aware reader every "what am I commanding/focusing?" call site should
 * use. In Tiled Dispatch that's the focused lane's agent (falling back to the
 * classic focus when the lane is empty); in classic Dispatch it's
 * dispatchMode.focusedSessionId. Centralizing this is what stops new readers
 * from re-introducing the lane-0 divergence (#266/#267/#271/#272 were all the
 * same mistake made in different files).
 */
export function dispatchFocusedSessionId(
  dispatchMode: DispatchModeState | null,
): SessionId | null {
  if (!dispatchMode) return null
  if (dispatchMode.tiled) {
    const lane = dispatchMode.tiled.lanes[dispatchMode.tiled.focusedLane]
    return lane?.selectedSessionId ?? dispatchMode.focusedSessionId ?? null
  }
  return dispatchMode.focusedSessionId ?? null
}

/**
 * Step one row in `delta` direction, wrapping.
 *
 * WHY an empty lane resolves to row 0 in BOTH directions (#673): an empty lane
 * has no cursor to move, so the first press cannot mean "move from here" — it
 * has to mean "start here". The model is that an empty lane behaves as though
 * it were already sitting at the TOP of the index: the first press in either
 * direction COMMITS that position, and every press after it navigates normally,
 * so ⌥↓ ⌥↓ gives row 1 then row 2, and ⌥↓ ⌥↑ gives row 1 then a wrap to the
 * last row.
 *
 * "Top of the index" and not "a1": buildVisibleDispatchRows puts pinned rows
 * first (labelled ★1, ★2…), so with anything pinned row 0 is ★1. That was
 * already true of the downward press before this change; it is called out here
 * because the lane's placeholder copy now makes a promise about the key.
 *
 * This used to return `length - 1` for an upward press, which made the
 * direction of the very first keystroke decide whether you landed at the top or
 * the bottom of the index — defensible when an empty lane was a rare exhaustion
 * state, but wrong now that New Lane deliberately creates one every time. The
 * lane's placeholder promises ⌥↓ reaches the top row in one press; making ⌥↑
 * agree costs nothing and removes the only way to be surprised by a fresh lane.
 *
 * The rejected alternative was to treat the virtual cursor as ALREADY on the top
 * row so the first press steps off it to the second. That makes the top row
 * unreachable by arrow from a fresh lane and lets the first keystroke scroll
 * past the likeliest target. (Said as rows, not a1/a2, for the same reason as
 * above: with anything pinned the first two rows are ★1 and ★2.)
 */
export function nextTiledRowIndex(
  currentIndex: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1
  if (currentIndex < 0) return 0
  return (((currentIndex + delta) % length) + length) % length
}

// The per-ROW column bounds now live in gridShape.ts, which owns every shape
// rule so a cap enforced in one file cannot drift from one consulted in
// another. Re-exported here because the commands, overlay, and reducers that
// already import them from this module are asking the same question.
export { MAX_DISPATCH_TILES, MIN_DISPATCH_TILES }
export const DEFAULT_DISPATCH_TILES = 2

/**
 * Clamp any user/programmatic tile count into the valid range. We floor
 * (not round) and treat non-finite input as the default so the numeric
 * prompt can hand us its raw value without pre-validating — invalid input
 * is clamped, never errors. This is the single source of truth for the
 * 1..10 bound; every caller (command, overlay, reducers) routes through it
 * so the cap can't drift between call sites.
 */
export function clampTileCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_DISPATCH_TILES
  return Math.max(MIN_DISPATCH_TILES, Math.min(MAX_DISPATCH_TILES, Math.floor(n)))
}

// REMOVED: `buildAutoLanes`, which claimed the next unclaimed visible agent for
// every lane on enter and for every appended lane on count growth (#681).
//
// Its docstring argued that asking for N tiles means wanting to SEE N agents,
// so landing on N empty pickers was busywork. That reasoning did not survive
// contact with the rest of the model: #673 had already established the opposite
// rule for New Lane (a new slot is a request for SPACE), and once rows landed,
// "add a row" would have yanked a whole row of agents out of the index unasked.
//
// Nothing fills a slot now except the user. If you find yourself wanting this
// helper back, the question to answer first is why THIS creation path is
// entitled to guess an occupant when none of the others are.

/**
 * Insert one EMPTY lane immediately to the right of `laneIndex`.
 *
 * WHY this is not `setTiledLaneCount(current + 1)`: count growth always appends
 * at the tail, while this command is spatial — the user is asking for a new
 * view beside the lane they are currently commanding.
 *
 * WHY the new lane is empty (#673): inserting a lane is a statement about
 * SPACE, and space does not imply an occupant.
 *
 * This once routed through a shared `buildAutoLanes` helper so insertion and
 * count growth would "stay in lockstep as future row kinds evolve". That
 * coupling was the bug — the helper claimed the first visible row not already
 * shown in a lane, which in the common case is the top of the index, so asking
 * for another view silently duplicated a1 into the slot beside you.
 *
 * The distinction the old comment drew here (count growth pre-fills, insertion
 * does not) is gone as of #681: NOTHING pre-fills any more, on any path. This
 * function is no longer the exception, it is the rule.
 *
 * Note there is no session lifecycle here and no `state` argument any more:
 * splicing a slot, shifting focus, and re-weighting ratios are all purely
 * structural, so the invariant is now true by signature rather than by comment.
 */
export function insertLaneRightIntoTiled(
  tiled: TiledDispatchState,
  laneIndex: number,
): TiledDispatchState | null {
  if (tiled.lanes.length >= MAX_DISPATCH_TILES) return null
  if (!Number.isInteger(laneIndex)) return null
  if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return null

  const insertAt = laneIndex + 1

  return {
    lanes: [
      ...tiled.lanes.slice(0, insertAt),
      // A bare `{}` is now sufficient. This used to need an explicit
      // `userEmptied: true` marker because the layout's heal effect refilled
      // any unresolved lane on the next render, making the whole feature a
      // no-op without it. With no healer (#681) every empty lane behaves
      // identically and the marker has no reader.
      //
      // The user picks the occupant; one press of ⌥↓ in the focused lane
      // selects the top row of the index (★1 if anything is pinned, else a1).
      {},
      ...tiled.lanes.slice(insertAt),
    ],
    // The command inserts after focus, so its normal path keeps this index.
    // The helper is deliberately more general, though: if a future caller
    // inserts before the focused coordinate, preserve the focused SESSION by
    // shifting its index just as removeLaneFromTiled does in reverse. Leaving
    // the ordinal unchanged would silently retarget keyboard commands.
    focusedLane: insertAt <= tiled.focusedLane
      ? tiled.focusedLane + 1
      : tiled.focusedLane,
    ratios: insertLaneWeight(tiled.ratios, tiled.lanes.length, insertAt),
  }
}

/**
 * Add one lane weight without discarding unrelated sizing decisions.
 *
 * Relative weights are scale-free. Giving the newcomer the old average makes
 * it exactly one equal share of the enlarged layout while preserving every
 * existing lane's proportions relative to its peers. A generic count change
 * has no spatial insertion contract and still resets ratios; New Lane does,
 * so snapping a deliberately sized cockpit back to even columns would be an
 * avoidable surprise.
 */
function insertLaneWeight(
  ratios: number[] | undefined,
  laneCount: number,
  insertAt: number,
): number[] | undefined {
  if (!ratios || ratios.length === 0) return undefined
  const [indexFraction, ...laneWeights] = ratios

  // Malformed persisted weights already render as an even split. Materialize
  // that same fallback at the new length so the index-sidebar fraction can
  // survive instead of being lost along with the unusable lane slice.
  if (
    laneWeights.length !== laneCount ||
    laneWeights.some(weight => !Number.isFinite(weight) || weight <= 0)
  ) {
    return [indexFraction, ...Array.from({ length: laneCount + 1 }, () => 1)]
  }

  const average = laneWeights.reduce((sum, weight) => sum + weight, 0) / laneCount
  return [
    indexFraction,
    ...laneWeights.slice(0, insertAt),
    average,
    ...laneWeights.slice(insertAt),
  ]
}

// NOTE: render still performs scope validation before mounting a lane, but the
// durability boundary must not rely on a later React effect. Autosave routes
// through keepTiledLaneSessions so stale lane ids do not survive to the next
// launch; render-time healing remains the user-facing repair for scope changes
// and temporarily empty lanes.

/**
 * Remove ONE lane by index. Returns null when the removal is refused, so the
 * caller can leave state untouched rather than writing back an identical object.
 *
 * WHY this exists at all, given `setTiledLaneCount` already resizes the grid:
 * that action takes only a COUNT, and shrinking by count always drops the tail
 * (`lanes.slice(0, next)`). With seven lanes open and the finished agent in
 * lane three, 7 -> 6 removes lane SEVEN and leaves the user re-selecting the
 * rest by hand.
 *
 * Closing the agent instead does not shrink anything either: the lane simply
 * empties and stays empty (before #681 it was re-homed by the healer, which was
 * worse — the slot silently acquired an unrelated agent). Either way the count
 * stays put, so without this there was no way to shrink the grid at a position
 * of the user's choosing.
 *
 * WHY it is a pure function rather than living inside the reducer: the
 * splice/clamp/ratio rules are the whole behaviour, and they are worth testing
 * without standing up a hook.
 */
export function removeLaneFromTiled(
  tiled: TiledDispatchState,
  laneIndex: number,
): TiledDispatchState | null {
  // Refuse at the floor. Emptying the layout is Dispatch Mode's job; a
  // lane-removal that silently became a mode-exit would be two different
  // actions sharing one name.
  if (tiled.lanes.length <= MIN_DISPATCH_TILES) return null
  if (!Number.isInteger(laneIndex)) return null
  if (laneIndex < 0 || laneIndex >= tiled.lanes.length) return null

  const lanes = tiled.lanes.filter((_, i) => i !== laneIndex)
  return {
    lanes,
    // Same clamp `setTiledLaneCount` applies: removing the last lane would
    // otherwise leave focusedLane pointing past the end. Note a lane removed
    // BEFORE the focused one shifts it down by one, which Math.min does not
    // do — so adjust explicitly rather than only clamping.
    focusedLane: Math.min(
      laneIndex < tiled.focusedLane ? tiled.focusedLane - 1 : tiled.focusedLane,
      lanes.length - 1,
    ),
    // `ratios` is NOT a uniform array of lane boundaries: index 0 is the
    // INDEX-SIDEBAR fraction (TiledDispatchLayout reads `ratios?.[0]`), and
    // only `ratios.slice(1)` are lane weights. Dropping the whole array — what
    // setTiledLaneCount does — therefore also snaps the sidebar back to its
    // default, undoing a width the user deliberately dragged and never asked
    // to change.
    //
    // A generic count *increase* has no insertion position or adjacent-lane
    // intent, which is why setTiledLaneCount resets wholesale. New Lane has an
    // explicit insertion position and can assign an average share; a removal
    // has an equally honest answer: keep the sidebar fraction, drop the removed
    // lane's weight, and let normalizedLaneWeights re-normalize what is left.
    ratios: removeLaneWeight(tiled.ratios, laneIndex),
  }
}

/**
 * Drop one lane's weight from a `ratios` array while preserving index 0, the
 * index-sidebar fraction. Returns undefined when there is nothing stored, so
 * the layout falls back to even distribution exactly as before.
 */
function removeLaneWeight(
  ratios: number[] | undefined,
  laneIndex: number,
): number[] | undefined {
  if (!ratios || ratios.length === 0) return undefined
  const [indexFraction, ...laneWeights] = ratios
  // A ratios array written before this lane existed simply has no weight to
  // drop; keeping the sidebar fraction is still the right call.
  if (laneIndex >= laneWeights.length) return [indexFraction]
  return [indexFraction, ...laneWeights.filter((_, i) => i !== laneIndex)]
}
