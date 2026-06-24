import type { DispatchLane, DispatchModeState, SessionId, WorkspaceState } from '@renderer/workspace/types'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'

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
 * Clear any tiled lane pointing at a removed session (selectedSessionId ->
 * undefined). The layout's auto-fill effect then re-homes the emptied lane.
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
      return { ...lane, selectedSessionId: undefined }
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
      return { ...lane, selectedSessionId: undefined }
    }
    return lane
  })
  if (!changed) return dispatchMode
  return { ...dispatchMode, tiled: { ...dispatchMode.tiled, lanes } }
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

export function nextTiledRowIndex(
  currentIndex: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1
  if (currentIndex < 0) return delta < 0 ? length - 1 : 0
  return (((currentIndex + delta) % length) + length) % length
}

// The issue caps Tiled Dispatch at 10 lanes. The floor is 1 (a single
// tiled lane is still a valid — if degenerate — tiled view; returning to
// the classic single-agent layout is done by toggling Dispatch Mode, not
// by asking for 0 tiles).
export const MAX_DISPATCH_TILES = 10
export const MIN_DISPATCH_TILES = 1
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

/**
 * Build a lane array of `count` lanes, auto-assigning each lane the next
 * visible agent not already used by an earlier lane in THIS fill. Used on
 * enter (preserve=[]) and on grow (preserve=existing lanes, so surviving
 * lanes keep their agents and only the appended lanes get auto-filled).
 *
 * WHY auto-fill rather than start blank: the user asked for N tiles
 * because they want to SEE N agents. Landing them on N empty lanes that
 * each need a manual pick is busywork; pre-filling from the visible row
 * order (the same order the index lane shows) gets them a useful cockpit
 * in one keystroke. Lanes beyond the number of available agents stay
 * empty (render the lane-local picker prompt).
 *
 * NOTE the local `claimed` set only spreads DISTINCT agents across lanes as
 * a sensible default — it is NOT an invariant. The user can still manually
 * put the same agent in two lanes afterwards (duplicates are allowed and the
 * views mirror; see DispatchLane).
 */
export function buildAutoLanes(
  state: WorkspaceState,
  count: number,
  preserve: DispatchLane[] = [],
): DispatchLane[] {
  const rows = buildVisibleDispatchRows(state)
  const claimed = new Set<SessionId>(
    preserve
      .map(lane => lane.selectedSessionId)
      .filter((id): id is SessionId => Boolean(id)),
  )
  const lanes: DispatchLane[] = []
  for (let i = 0; i < count; i++) {
    if (preserve[i]) {
      lanes.push(preserve[i])
      continue
    }
    const next = rows.find(row => !claimed.has(row.sessionId))
    if (next) {
      claimed.add(next.sessionId)
      lanes.push({ selectedSessionId: next.sessionId })
    } else {
      lanes.push({})
    }
  }
  return lanes
}

// NOTE: render still performs scope validation before mounting a lane, but the
// durability boundary must not rely on a later React effect. Autosave routes
// through keepTiledLaneSessions so stale lane ids do not survive to the next
// launch; render-time healing remains the user-facing repair for scope changes
// and temporarily empty lanes.
