import type { DispatchLane, SessionId, WorkspaceState } from '@renderer/workspace/types'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'

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

// NOTE: there is deliberately no `sanitizeLanes` reducer-side helper. Stale
// or duplicate lane state (dead session, hand-edited workspace.json,
// corrupt rehydrate) is handled at RENDER time in TiledDispatchLayout: the
// `laneResolutions` memo de-dups and drops dead/out-of-scope ids every
// frame (so renderWorkspaceLeaf can never double-mount a session, even on
// the first frame after rehydrate before effects run), and the heal effect
// re-homes the affected lanes. A separate pure sanitizer was tried first but
// (a) couldn't prevent the first-frame double-mount and (b) became dead
// code the moment the render-time guard existed.
