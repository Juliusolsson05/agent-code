import type { SessionId, TiledDispatchState } from '@renderer/workspace/types'

// Test-only stage literals (#992).
//
// WHY this exists: before the unified layout, "the user is commanding session
// X" was expressed in fixtures by the tile tree alone — a tab whose
// `focusedSessionId` was X, with `dispatchMode: null`. Dozens of suites relied
// on it, because the command target fell back to that grid focus whenever
// Dispatch was off. There is no grid focus any more: the command target is the
// focused lane's occupant and nothing else (U3). The honest translation of
// those fixtures is a stage with one lane showing X, and writing that literal
// by hand in forty files is how two of them end up subtly different.
//
// Kept out of gridShape.ts on purpose. `freshStage()` lives there because the
// store's initial state needs it; "a stage that already shows an agent" is
// never something production code constructs — a lane gets an occupant through
// a reducer, with a wake first (#690) — so a helper for it in product code
// would be an invitation to skip both.

/**
 * One row of one lane, focused, showing `sessionId` (or empty when omitted).
 * The smallest stage in which `sessionId` is the command target.
 */
export function oneLaneStage(sessionId?: SessionId): TiledDispatchState {
  return {
    lanes: [sessionId ? { selectedSessionId: sessionId } : {}],
    rows: [{ length: 1 }],
    focusedLane: 0,
  }
}
