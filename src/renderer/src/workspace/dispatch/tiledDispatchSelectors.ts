import type {
  DispatchLane,
  LaneHistoryEntry,
  SessionId,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'
import {
  MAX_DISPATCH_TILES,
  MIN_DISPATCH_TILES,
  normalizeGridShape,
} from '@renderer/workspace/dispatch/gridShape'

// ============================================================================
// Tiled-lane coherence helpers
//
// The stage keeps a per-lane session selection in stage.lanes[].selectedSessionId,
// plus the focused lane in stage.focusedLane. (These helpers took the
// `dispatchMode` wrapper until #992 made the stage a required field; their
// rules are unchanged, only the wrapper is gone.) Two whole bug classes came from code that
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
  stage: TiledDispatchState,
  idMap: ReadonlyMap<SessionId, SessionId>,
): TiledDispatchState {
  let changed = false
  const lanes = stage.lanes.map(lane => {
    const id = lane.selectedSessionId
    const next = id ? idMap.get(id) : undefined
    const selectionMoved = Boolean(next && next !== id)
    // History is remapped with the selection for the same reason the
    // selection is: a reload or provider switch swaps the id of the SAME
    // agent, and an entry still naming the old id would be filtered out as
    // dead — the agent would silently fall out of this lane's history.
    const history = remapLaneHistory(lane.history, idMap)
    if (!selectionMoved && history === lane.history) return lane
    changed = true
    return {
      ...lane,
      ...(selectionMoved ? { selectedSessionId: next } : {}),
      ...(history ? { history } : {}),
    }
  })
  if (!changed) return stage
  return { ...stage, lanes }
}

function remapLaneHistory(
  history: LaneHistoryEntry[] | undefined,
  idMap: ReadonlyMap<SessionId, SessionId>,
): LaneHistoryEntry[] | undefined {
  if (!history) return history
  let changed = false
  const mapped = history.map(entry => {
    const next = idMap.get(entry.sessionId)
    if (!next || next === entry.sessionId) return entry
    changed = true
    return { ...entry, sessionId: next }
  })
  // Two ids can map onto one successor; keep the newest so the one-entry-
  // per-agent rule survives the remap.
  return changed ? dedupeLaneHistory(mapped) : history
}

/**
 * How many past agents one lane remembers.
 *
 * WHY a cap at all: this list rides autosave inside the workspace file, once
 * per lane, for the life of the workspace. Entries are already one per agent,
 * so the cap only bites for a lane that has cycled through 50 DIFFERENT live
 * agents — far past what anyone scrolls back through in a "which agent was
 * here" list — and dead agents are pruned at every autosave anyway.
 */
export const LANE_HISTORY_LIMIT = 50

function dedupeLaneHistory(history: LaneHistoryEntry[]): LaneHistoryEntry[] {
  const seen = new Set<SessionId>()
  return history.filter(entry => {
    if (seen.has(entry.sessionId)) return false
    seen.add(entry.sessionId)
    return true
  })
}

/**
 * Record that `departed` left this lane at `at`, newest first.
 *
 * An agent that comes back and leaves again moves to the top with the new time
 * rather than gaining a second row: the list answers "which agents were here
 * and when did I last see each one", and repeated rows for the same agent
 * would push the others out of view for no new information.
 */
//
// `arriving` is removed BEFORE the cap is applied: at a full list, trimming
// first and then dropping the arriving agent cost an unrelated oldest entry
// and left 49 rows (#1504 review).
function withDeparture(
  history: LaneHistoryEntry[] | undefined,
  departed: SessionId | undefined,
  at: number,
  arriving?: SessionId,
): LaneHistoryEntry[] | undefined {
  const rest = (history ?? []).filter(entry =>
    entry.sessionId !== departed && entry.sessionId !== arriving)
  if (!departed) return arriving && history ? rest : history
  return [{ sessionId: departed, at }, ...rest].slice(0, LANE_HISTORY_LIMIT)
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
//
// Lane History made this the field-with-a-rule it was kept free for: the agent
// being replaced is recorded as a departure HERE, so every selection path
// (index click, lane strip, ⌘N spawn focus, label navigation, control-plane
// show, extension views, new tab) feeds the history without each one having
// to remember. The incoming agent is dropped from the list because it is now
// the occupant, not the past.
//
// `now` is a parameter only so tests can pin the clock; callers use the
// default.
export function withLaneSession(
  lane: DispatchLane,
  sessionId: SessionId,
  now: number = Date.now(),
): DispatchLane {
  if (lane.selectedSessionId === sessionId) return { ...lane, selectedSessionId: sessionId }
  const history = withDeparture(lane.history, lane.selectedSessionId, now, sessionId)
  const { history: _previous, ...rest } = lane
  return {
    ...rest,
    selectedSessionId: sessionId,
    ...(history && history.length > 0 ? { history } : {}),
  }
}

/**
 * Empty a lane because the USER asked to (Clear Lane), recording the agent
 * that was in it.
 *
 * WHY separate from `withLaneCleared`: that one runs when a session is
 * destroyed (kill, close, bury) or failed the durability prune. Recording a
 * departure there would list an agent that no longer exists. Clear Lane is the
 * opposite case — the agent is alive and in the index, and finding it again is
 * precisely what Lane History is for.
 */
export function withLaneClearedByUser(lane: DispatchLane, now: number = Date.now()): DispatchLane {
  const history = withDeparture(lane.history, lane.selectedSessionId, now)
  // Omit the key rather than writing `selectedSessionId: undefined`, so an
  // empty lane has one shape whether it was never filled or was cleared.
  const { selectedSessionId: _cleared, history: _previous, ...rest } = lane
  return history ? { ...rest, history } : rest
}

/** Blank a lane's selection. Nothing refills it; that is the point (#681). */
function withLaneCleared(lane: DispatchLane): DispatchLane {
  return { ...lane, selectedSessionId: undefined }
}

/**
 * The lane's history restricted to sessions that still exist, or undefined
 * when nothing survives. Same reference when nothing was dropped, so callers
 * can detect "unchanged" by identity.
 */
export function liveLaneHistory(
  history: LaneHistoryEntry[] | undefined,
  isLive: (id: SessionId) => boolean,
): LaneHistoryEntry[] | undefined {
  if (!history) return history
  // A workspace file is untrusted input and this runs on it before the load
  // projection sanitizes lanes (keepTiledLaneSessions in the migration), so a
  // hand-edited or corrupt non-array must degrade to "no history" rather than
  // throw and lock bootstrap out of the whole workspace.
  if (!Array.isArray(history)) return undefined
  // Entries are checked for shape too, for the same reason: a null row in the
  // file reached `.sessionId` here and threw before sanitizeLaneHistory ever
  // saw it (caught by laneHistory.test.ts's corrupt-file case).
  const kept = history.filter(entry =>
    typeof entry === 'object' && entry !== null && isLive(entry.sessionId))
  if (kept.length === history.length) return history
  return kept.length > 0 ? kept : undefined
}

/**
 * Clear any tiled lane pointing at a removed session (selectedSessionId ->
 * undefined). The lane then renders empty and STAYS empty — before #681 the
 * layout re-homed another agent into the hole, which is what made closing one
 * agent silently move an unrelated one into the slot you were watching.
 * Apply wherever a session is destroyed/hidden (killSession, close, bury).
 */
export function clearTiledLaneSessions(
  stage: TiledDispatchState,
  removed: ReadonlySet<SessionId> | SessionId,
): TiledDispatchState {
  const isRemoved = (id: SessionId): boolean =>
    typeof removed === 'string' ? removed === id : removed.has(id)
  let changed = false
  const lanes = stage.lanes.map(lane => {
    if (lane.selectedSessionId && isRemoved(lane.selectedSessionId)) {
      changed = true
      return withLaneCleared(lane)
    }
    return lane
  })
  if (!changed) return stage
  return { ...stage, lanes }
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
  stage: TiledDispatchState,
  keep: ReadonlySet<SessionId>,
): TiledDispatchState {
  let changed = false
  const lanes = stage.lanes.map(lane => {
    // History entries are durable session pointers too, so they close over
    // the same surviving set. Without this a dead agent's id would ride every
    // autosave forever, invisible (the dialog filters it) but never freed.
    const history = liveLaneHistory(lane.history, id => keep.has(id))
    const dropSelection = Boolean(lane.selectedSessionId && !keep.has(lane.selectedSessionId))
    if (!dropSelection && history === lane.history) return lane
    changed = true
    const { history: _previous, ...rest } = dropSelection ? withLaneCleared(lane) : lane
    return history ? { ...rest, history } : rest
  })
  if (!changed) return stage
  return { ...stage, lanes }
}

/**
 * Bring a persisted stage up to the current grid shape.
 *
 * WHY this belongs with the other lane helpers rather than inside gridShape:
 * this file's header says the lane helpers must be applied at every id-remap,
 * removal, and focus-read site, and rehydrate is one of them — the
 * normalization has to take and return the same `TiledDispatchState` as
 * remapTiledLanes and keepTiledLaneSessions so it can be composed with them in
 * one expression instead of being a fourth thing a caller must remember.
 * (All of them took the `dispatchMode` envelope until #992 made the stage a
 * required field; this one was `normalizeDispatchModeGrid`.)
 *
 * The migration itself (legacy `ratios` -> per-row indexFraction + laneWeights,
 * and repair of the row-length invariant) lives in gridShape, which owns every
 * shape rule.
 *
 * Returns the SAME reference when nothing needed changing, so consumers that
 * memoize on stage identity do not churn on every restore.
 */
export function normalizeStage(stage: TiledDispatchState): TiledDispatchState {
  const grid = normalizeGridShape(stage)
  const alreadyCurrent =
    stage.ratios === undefined &&
    // Lanes too: a repaired lanes array (#1245) must not be discarded in
    // favour of the original, malformed one.
    stage.lanes === grid.lanes &&
    stage.rows === grid.rows &&
    stage.laneWeights === grid.laneWeights &&
    stage.focusedLane === grid.focusedLane
  if (alreadyCurrent) return stage

  return {
    lanes: grid.lanes,
    rows: grid.rows,
    focusedLane: grid.focusedLane,
    // Dropped, never rewritten: keeping the legacy array beside the fields it
    // was split into would leave two sources of truth for width, and the next
    // reader would have to guess which one the user's last drag produced.
    ...(grid.laneWeights ? { laneWeights: grid.laneWeights } : {}),
  }
}

/**
 * Drop row metadata pointing at a project or session that no longer exists.
 *
 * WHY this belongs at the autosave ownership prune rather than at the close/kill
 * paths: the prune is where the serialized model is made closed under restore,
 * and row metadata names two things that can vanish behind its back — a project
 * tab and a set of expanded parent sessions. A binding to a closed tab is the
 * dangerous one: it filters that row's index to NOTHING, permanently, and the
 * picker only offers tabs that exist, so there is no UI path back. Render-time
 * repair is not enough because the stale value would be rewritten on every save.
 *
 * Returns the same reference when nothing needed scrubbing, matching every
 * other helper in this family so a clean prune does not churn consumers.
 */
export function scrubGridRowMetadata(
  stage: TiledDispatchState,
  liveTabIds: ReadonlySet<TabId>,
  liveSessionIds: ReadonlySet<SessionId>,
): TiledDispatchState {
  const tiled = stage
  if (!tiled.rows) return stage

  let changed = false
  const rows = tiled.rows.map(row => {
    // Per-ROW, not per-call. Returning `{ ...row }` for rows this pass did not
    // touch was a real regression, and an invisible one: row object identity is
    // load-bearing, not a micro-optimisation (gridShape.ts's
    // `normalizeGridShape` says so, and gridPersistence.test.ts pins it). The
    // consumer is the lane-selection race check in dispatch.ts, which compares
    // `after.rows[rowIndex] !== before.rows[rowIndex]` across a WAKE to decide
    // whether the grid moved under the user — a window that a cold wake can
    // hold open for 30s. Re-allocating every row made an unrelated close in
    // that window read as "the grid changed", so the woken agent was started
    // and then never placed, with no toast. Before this file ran on closes
    // that only happened at the persistence boundary, whose output never
    // entered live state, so the whole-map copy was harmless there.
    let rowChanged = false
    const next = { ...row }
    if (next.projectTabId !== undefined) {
      // FOLD the legacy single binding rather than dropping it, matching the
      // only two other readers of the field (`normalizeRowProjects` in
      // gridShape.ts and mergeProjectTabs.ts). Deleting it outright would take
      // a live binding away from a row whose shape simply predates the array.
      //
      // Dead in practice today — rehydrate runs `normalizeStage` before it
      // publishes, so a live row never carries the legacy field — but this is
      // the third caller of this helper and nothing enforces that ordering.
      const legacy = next.projectTabId
      const merged = next.projectTabIds ?? []
      next.projectTabIds = merged.includes(legacy) ? merged : [...merged, legacy]
      delete next.projectTabId
      rowChanged = true
    }
    if (next.projectTabIds) {
      const surviving = next.projectTabIds.filter(id => liveTabIds.has(id))
      if (surviving.length !== next.projectTabIds.length) {
        rowChanged = true
        // A row whose every binding died becomes UNBOUND rather than keeping an
        // empty set: an empty set would filter its index to nothing with no UI
        // path back, since the picker only offers tabs that exist.
        if (surviving.length > 0) next.projectTabIds = surviving
        else delete next.projectTabIds
      }
    }
    if (next.expandedParents) {
      const kept = next.expandedParents.filter(id => liveSessionIds.has(id))
      if (kept.length !== next.expandedParents.length) {
        rowChanged = true
        // An empty array and an absent field read identically; persisting the
        // empty one is durable noise.
        if (kept.length > 0) next.expandedParents = kept
        else delete next.expandedParents
      }
    }
    if (!rowChanged) return row
    changed = true
    return next
  })
  if (!changed) return stage
  return { ...tiled, rows }
}

/**
 * The session the user is currently focused on — the SINGLE reader every
 * "what am I commanding/focusing?" call site should use: the focused lane's
 * occupant, or null when that lane is empty. Centralizing this is what stops
 * new readers from re-introducing the lane-0 divergence (#266/#267/#271/#272
 * were all the same mistake made in different files).
 *
 * Until #992 this fell back to a classic single-selection focus when the lane
 * was empty. That second focus truth is gone: an empty focused lane means no
 * session is focused, which is exactly what the screen shows.
 */
export function dispatchFocusedSessionId(stage: TiledDispatchState): SessionId | null {
  return stage.lanes[stage.focusedLane]?.selectedSessionId ?? null
}

// `dispatchEntrySeedSessionId` lived here until #992. It chose the one session
// to keep visible in lane 0 when a user ENTERED the lane grid (#977). Nothing
// is entered any more: the only surviving seed is the v2→v3 migration's
// (legacyWorkspaceV2.ts legacyEntrySeed), which runs once per old file.

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

// NOTE: render still performs scope validation before mounting a lane, but the
// durability boundary must not rely on a later React effect. Autosave routes
// through keepTiledLaneSessions so stale lane ids do not survive to the next
// launch.
//
// There is no render-time repair any more (#681). A lane that cannot resolve
// renders empty and KEEPS its selection, so a scope change is reversible by
// changing scope back rather than being silently overwritten.
//
// The lane splice/insert helpers that used to live below this line were deleted
// with it: they rewrote `lanes` and the legacy `ratios` without touching `rows`,
// which is exactly the "updates lanes without updating rows in the same
// expression" failure gridShape.ts exists to prevent. Every shape mutation now
// lives in gridShape and returns lanes and rows together.

/**
 * Read a lane's history from a persisted workspace file.
 *
 * WHY its own validator: the load projection rebuilds every lane field by
 * hand (it exists to drop legacy fields), so anything not copied there is lost
 * on restart. Each entry is checked individually so one malformed row costs
 * that row, not the lane's whole history; order is preserved (newest first is
 * how it was written) and the one-per-agent rule and cap are re-applied in
 * case the file was edited.
 */
const MAX_DATE_MS = 8.64e15

export function sanitizeLaneHistory(
  raw: unknown,
  isLive: (id: SessionId) => boolean,
): LaneHistoryEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const entries = raw.filter((entry): entry is LaneHistoryEntry =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as LaneHistoryEntry).sessionId === 'string' &&
    // Finite is not enough: `new Date(1e20)` is an Invalid Date, and the
    // dialog's toISOString() throws on one — a hand-edited file would crash
    // Lane History on open (#1504 review). ±8.64e15 ms is the Date range.
    Number.isFinite((entry as LaneHistoryEntry).at) &&
    Math.abs((entry as LaneHistoryEntry).at) <= MAX_DATE_MS &&
    isLive((entry as LaneHistoryEntry).sessionId),
  ).map(entry => ({ sessionId: entry.sessionId, at: entry.at }))
  const kept = dedupeLaneHistory(entries).slice(0, LANE_HISTORY_LIMIT)
  return kept.length > 0 ? kept : undefined
}
