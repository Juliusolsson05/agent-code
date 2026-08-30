import type {
  DispatchGridRow,
  DispatchLane,
  TiledDispatchState,
} from '@renderer/workspace/types'

// ============================================================================
// Grid shape — the row descriptor over the flat lane array
//
// Grid Dispatch stacks up to MAX_DISPATCH_ROWS rows of lanes. `lanes` stays a
// FLAT, row-major array and `focusedLane` stays a flat scalar (see the WHY on
// TiledDispatchState); this module owns the `rows` descriptor that slices them
// and every mutation of that shape.
//
// The reason shape lives here rather than inside the reducers: the invariant
//
//     sum(rows[].length) === lanes.length
//
// is the one thing in the grid that can desynchronize, and a reducer that
// updates `lanes` without updating `rows` in the same expression is how it
// would. Every exported mutation returns a COMPLETE, coherent shape or `null`
// — never a partial update a caller has to finish correctly.
//
// Row lengths are deliberately independent. There is no global column count in
// this file, and adding one would be a bug: four lanes on top and two below is
// the expected shape, and coupling row lengths would make New Lane in one row
// silently add a lane to every other row.
// ============================================================================

/**
 * Rows cap at 4 because each row is a complete dispatch view (its own index
 * list, its own header controls), so rows cost real vertical space rather than
 * being cheap dividers. Four 200px-tall rows is already a demanding display.
 */
export const MAX_DISPATCH_ROWS = 4

/**
 * Total lanes across every row. 4 x 10 = 40 is reachable from the per-row cap
 * alone, and 40 live agent views is not a layout — every lane mounts a real
 * renderWorkspaceLeaf with its own runtime subscriptions and per-session screen
 * snapshotting. 16 is four full rows of four, or two rows of eight.
 *
 * This is a judgment call rather than a measurement; it is one constant if it
 * turns out to be wrong in either direction.
 */
export const MAX_DISPATCH_LANES = 16

// Per-ROW column bounds. These moved here from tiledDispatchSelectors (which
// re-exports them for its existing importers) because every shape rule now
// lives in one module: a cap enforced in one file and consulted in another is
// how the two drift. `MAX_DISPATCH_TILES` keeps its name despite now meaning
// "per row" — renaming it would churn every call site to say the same thing.
export const MAX_DISPATCH_TILES = 10
export const MIN_DISPATCH_TILES = 1

// Index-list width bounds, as a fraction of one row's width. The index must
// stay readable (it carries titles, project chips, and activity) but must never
// eat the row, so the lanes always keep at least 60%. These live here rather
// than in the layout because the reducer clamps on write and the layout clamps
// on read; two copies of a bound is how the two disagree.
export const INDEX_FRACTION_MIN = 0.1
export const INDEX_FRACTION_MAX = 0.4
export const DEFAULT_INDEX_FRACTION = 0.18

/** Smallest share of a row a single lane may be dragged to. */
export const LANE_MIN_FRACTION = 0.08

/** Smallest share of the grid a single row may be dragged to. */
export const ROW_MIN_FRACTION = 0.12

export function clampIndexFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INDEX_FRACTION
  return Math.max(INDEX_FRACTION_MIN, Math.min(INDEX_FRACTION_MAX, value))
}

/** Row shape guaranteed coherent with the lanes it describes. */
export type NormalizedGrid = {
  lanes: DispatchLane[]
  rows: DispatchGridRow[]
  laneWeights?: number[]
  focusedLane: number
}

/**
 * Read row shape out of persisted or in-memory tiled state, repairing anything
 * incoherent.
 *
 * WHY this repairs instead of validating: it runs on rehydrate, against a file
 * a user can hand-edit and that a crash can leave half-written. A throw here
 * takes the renderer down at launch and disables the autosave that would fix
 * the file — the same self-reference that made the tile-tree prune belong at
 * the autosave boundary. Degrading into a usable layout is the only safe
 * behavior, so every branch below produces a coherent grid rather than
 * rejecting one.
 */
export function normalizeGridShape(tiled: TiledDispatchState): NormalizedGrid {
  const lanes = tiled.lanes ?? []
  const rows = withMigratedIndexFraction(
    repairRowLengths(tiled.rows, lanes.length),
    tiled,
  )

  return {
    lanes,
    rows,
    laneWeights: usableLaneWeights(tiled, lanes.length),
    // A focused lane past the end, negative, or fractional cannot address a
    // lane. Falling back to 0 rather than dropping focus keeps every
    // focus-reading command targeting something visible.
    focusedLane:
      Number.isInteger(tiled.focusedLane) && tiled.focusedLane >= 0
        ? Math.min(tiled.focusedLane, Math.max(0, lanes.length - 1))
        : 0,
  }
}

/**
 * Force `rows` to describe exactly `laneCount` lanes.
 *
 * The repair absorbs any discrepancy into the LAST row, then drops rows the
 * lane count cannot support. Absorbing at the tail rather than redistributing
 * keeps every earlier row — and therefore every row the user has bound to a
 * project or resized — exactly where they were: a corrupt length should cost
 * the user the smallest possible amount of their layout.
 */
function repairRowLengths(
  rows: DispatchGridRow[] | undefined,
  laneCount: number,
): DispatchGridRow[] {
  // The backward-compatibility default, and the reason this change needs no
  // migration for ordinary state: no row shape MEANS one row of every lane.
  if (!rows || rows.length === 0) return [{ length: laneCount }]

  // Fast path: already coherent, so hand back the SAME array. Rebuilding an
  // identical shape on every read would defeat consumers that memoize on
  // dispatchMode identity — this runs on rehydrate and behind reducers, both of
  // which feed React. Reference stability here is a correctness property for
  // those consumers, not a micro-optimization.
  let sum = 0
  let wellFormed = true
  for (const row of rows) {
    if (!Number.isInteger(row.length) || row.length <= 0) {
      wellFormed = false
      break
    }
    sum += row.length
  }
  if (wellFormed && sum === laneCount) return rows

  const sanitized = rows.map(row => ({
    ...row,
    length:
      Number.isInteger(row.length) && row.length > 0 ? row.length : 0,
  }))

  // Walk forward handing each row what is left, so a row is only ever
  // shortened by lanes its predecessors legitimately consumed.
  const kept: DispatchGridRow[] = []
  let remaining = laneCount
  for (const row of sanitized) {
    if (remaining <= 0) break
    const length = Math.min(row.length, remaining)
    if (length <= 0) continue
    kept.push({ ...row, length })
    remaining -= length
  }

  if (kept.length === 0) {
    // Either every row was malformed or there are no lanes to hand out. One
    // row must always exist: the grid's floor is one row, and returning zero
    // rows would make the layout render nothing with no way back.
    return [{ ...(sanitized[0] ?? {}), length: laneCount > 0 ? laneCount : 0 }]
  }
  // Undercount: the rows described fewer lanes than exist. The surplus goes to
  // the last row rather than becoming an implicit extra row, because an
  // invented row would carry no project binding or density the user chose.
  if (remaining > 0) {
    const last = kept[kept.length - 1]!
    kept[kept.length - 1] = { ...last, length: last.length + remaining }
  }
  return kept
}

/**
 * Carry a legacy `ratios[0]` onto the first row as its index fraction.
 *
 * The single pre-grid sidebar belonged to the single pre-grid row, so on a
 * one-row grid this preserves a width the user deliberately dragged. Only the
 * FIRST row inherits it: a later row is one the user created after the grid
 * existed and never sized under the old model, so giving it the legacy width
 * would be inventing an intent from a value that predates it.
 *
 * Never overwrites an explicit `indexFraction` — if the row already carries one
 * it was written in the new format, and `ratios` is the stale half.
 */
function withMigratedIndexFraction(
  rows: DispatchGridRow[],
  tiled: TiledDispatchState,
): DispatchGridRow[] {
  const legacy = tiled.ratios?.[0]
  const first = rows[0]
  if (!first || first.indexFraction !== undefined) return rows
  if (legacy === undefined || !Number.isFinite(legacy) || legacy <= 0) return rows
  return [{ ...first, indexFraction: legacy }, ...rows.slice(1)]
}

/**
 * Resolve the lane weights to use, migrating a legacy `ratios` array.
 *
 * Legacy `ratios` packed two different things into one array — index 0 was the
 * single sidebar's fraction, 1..N were lane weights. Once each ROW owns its
 * index fraction those halves have to separate, so the migration happens here,
 * on read, exactly once. Reading the legacy array as uniform lane weights would
 * silently render the old sidebar fraction as lane 0's width.
 */
function usableLaneWeights(
  tiled: TiledDispatchState,
  laneCount: number,
): number[] | undefined {
  // New format wins over a stale legacy array: if both survive a partial write
  // or a downgrade/upgrade cycle, `laneWeights` is what the user's last drag
  // actually produced.
  const candidate = tiled.laneWeights ?? tiled.ratios?.slice(1)
  if (!candidate) return undefined
  // Partial or malformed weights cannot be normalized honestly — there is no
  // defensible width for the lanes they omit — so they degrade to the even
  // split the layout already falls back to.
  if (candidate.length !== laneCount) return undefined
  if (candidate.some(weight => !Number.isFinite(weight) || weight <= 0)) {
    return undefined
  }
  return candidate
}

/**
 * Insert one EMPTY lane immediately right of `laneIndex`, in that lane's row.
 *
 * Only the owning row lengthens. That is the ragged-shape contract: asking for
 * space beside one agent must not widen a row the user was not editing, which
 * is what a shared column count would do.
 *
 * The lane is empty because a new slot is a request for SPACE, not for a
 * particular agent (#673). Auto-filling claims the first unclaimed visible row,
 * which in the common case silently duplicates the top of the index into the
 * slot beside you.
 */
export function insertLaneRightIntoGrid(
  tiled: TiledDispatchState,
  laneIndex: number,
): TiledDispatchState | null {
  const grid = normalizeGridShape(tiled)
  const rowIndex = rowIndexForLane(grid.rows, laneIndex)
  if (rowIndex < 0) return null
  const row = grid.rows[rowIndex]!
  // Two independent caps. Per-row protects readability (a lane too narrow to
  // read a feed in is not a lane); total protects memory, because every lane
  // mounts a real agent view with its own runtime subscriptions.
  if (row.length >= MAX_DISPATCH_TILES) return null
  if (grid.lanes.length >= MAX_DISPATCH_LANES) return null

  const insertAt = laneIndex + 1
  return {
    lanes: [...grid.lanes.slice(0, insertAt), {}, ...grid.lanes.slice(insertAt)],
    rows: grid.rows.map((candidate, i) =>
      i === rowIndex ? { ...candidate, length: candidate.length + 1 } : candidate,
    ),
    // The command inserts after focus, so its normal path keeps this index. The
    // helper is deliberately more general: an insertion BEFORE the focused
    // coordinate shifts the focused session right, and leaving the ordinal
    // unchanged would silently retarget every keyboard command.
    focusedLane:
      insertAt <= grid.focusedLane ? grid.focusedLane + 1 : grid.focusedLane,
    laneWeights: insertLaneWeight(grid, rowIndex, insertAt),
  }
}

/**
 * Give a newcomer one equal share of its own row.
 *
 * Weights are scale-free, so the row average is exactly one equal share of the
 * enlarged row while every existing lane keeps its proportion relative to its
 * peers. The average must come from the TARGET row — borrowing a neighbouring
 * row's average would size the new lane against a row it is not in.
 */
function insertLaneWeight(
  grid: NormalizedGrid,
  rowIndex: number,
  insertAt: number,
): number[] | undefined {
  const weights = grid.laneWeights
  if (!weights) return undefined
  const start = rowStartIndex(grid.rows, rowIndex)
  const rowWeights = weights.slice(start, start + (grid.rows[rowIndex]?.length ?? 0))
  if (rowWeights.length === 0) return undefined
  const average = rowWeights.reduce((sum, w) => sum + w, 0) / rowWeights.length
  return [...weights.slice(0, insertAt), average, ...weights.slice(insertAt)]
}

/**
 * Remove ONE lane. Removing a row's last lane removes the row, because a row
 * with no lanes would render an index list beside nothing.
 *
 * Returns null when refused so the caller leaves state untouched rather than
 * writing back an identical object.
 */
export function removeLaneFromGrid(
  tiled: TiledDispatchState,
  laneIndex: number,
): TiledDispatchState | null {
  const grid = normalizeGridShape(tiled)
  const rowIndex = rowIndexForLane(grid.rows, laneIndex)
  if (rowIndex < 0) return null
  const row = grid.rows[rowIndex]!
  // Refuse at the floor. Emptying the layout is Dispatch Mode's job; a lane
  // removal that silently became a mode exit would be two different actions
  // sharing one name.
  if (grid.rows.length === 1 && row.length <= MIN_DISPATCH_TILES) return null

  const lanes = grid.lanes.filter((_, i) => i !== laneIndex)
  return {
    lanes,
    rows:
      row.length === 1
        ? grid.rows.filter((_, i) => i !== rowIndex)
        : grid.rows.map((candidate, i) =>
            i === rowIndex ? { ...candidate, length: candidate.length - 1 } : candidate,
          ),
    // A lane removed BEFORE the focused one shifts it down by one, which a
    // clamp alone does not do — so adjust explicitly, then clamp for the case
    // where focus was the removed tail.
    focusedLane: Math.min(
      laneIndex < grid.focusedLane ? grid.focusedLane - 1 : grid.focusedLane,
      Math.max(0, lanes.length - 1),
    ),
    laneWeights: grid.laneWeights?.filter((_, i) => i !== laneIndex),
  }
}

/**
 * Insert an EMPTY row below `rowIndex`, inheriting that row's column count.
 *
 * Inheriting the source row's length rather than any global width is P3 in one
 * line: New Row below a 4-lane row makes a 4-lane row, below a 2-lane row makes
 * a 2-lane row. Reading a shared column count here would be the first place a
 * rectangle could sneak back into the model.
 *
 * Focus stays on the source row — New Row mirrors New Lane's contract, asking
 * for space without moving the user away from the agent they were commanding.
 */
export function insertRowBelowInGrid(
  tiled: TiledDispatchState,
  rowIndex: number,
): TiledDispatchState | null {
  const grid = normalizeGridShape(tiled)
  if (!Number.isInteger(rowIndex)) return null
  if (rowIndex < 0 || rowIndex >= grid.rows.length) return null
  if (grid.rows.length >= MAX_DISPATCH_ROWS) return null

  // Prefer a SHORTER row over a refusal: the user asked for a row, and giving
  // them a narrower one is closer to their intent than giving them nothing.
  const remaining = MAX_DISPATCH_LANES - grid.lanes.length
  const length = Math.min(grid.rows[rowIndex]?.length ?? 0, remaining)
  if (length < MIN_DISPATCH_TILES) return null

  const insertAt = rowStartIndex(grid.rows, rowIndex + 1)
  const blanks: DispatchLane[] = Array.from({ length }, () => ({}))
  return {
    lanes: [...grid.lanes.slice(0, insertAt), ...blanks, ...grid.lanes.slice(insertAt)],
    rows: [
      ...grid.rows.slice(0, rowIndex + 1),
      { length, height: averageRowHeight(grid.rows) },
      ...grid.rows.slice(rowIndex + 1),
    ],
    focusedLane:
      insertAt <= grid.focusedLane ? grid.focusedLane + length : grid.focusedLane,
    laneWeights: insertRowWeights(grid, rowIndex, insertAt, length),
  }
}

/**
 * One equal share of the enlarged grid, in whatever scale the siblings use.
 *
 * Heights are scale-free and normalized on read, but they are NOT written on a
 * common scale: the drag handler persists fractions summing to 1, while an
 * un-sized row defaults to 1. Defaulting a new row to 1 beside dragged siblings
 * of 0.7/0.3 therefore rendered the brand-new EMPTY row as the tallest thing on
 * screen and halved its neighbour. Taking the average is the same fix
 * insertLaneWeight applies on the lane axis.
 */
function averageRowHeight(rows: DispatchGridRow[]): number | undefined {
  const heights = rows.map(row => row.height)
  if (heights.some(height => height === undefined)) return undefined
  const known = heights as number[]
  if (known.length === 0) return undefined
  return known.reduce((sum, height) => sum + height, 0) / known.length
}

/** Size a new row's lanes against the row it was cloned from. */
function insertRowWeights(
  grid: NormalizedGrid,
  sourceRowIndex: number,
  insertAt: number,
  length: number,
): number[] | undefined {
  const weights = grid.laneWeights
  if (!weights) return undefined
  const start = rowStartIndex(grid.rows, sourceRowIndex)
  const source = weights.slice(start, start + (grid.rows[sourceRowIndex]?.length ?? 0))
  if (source.length === 0) return undefined
  const average = source.reduce((sum, w) => sum + w, 0) / source.length
  return [
    ...weights.slice(0, insertAt),
    ...Array.from({ length }, () => average),
    ...weights.slice(insertAt),
  ]
}

/**
 * Remove one row and every lane it owns. Agents keep running; this is a layout
 * operation, not a lifecycle one.
 */
export function removeRowFromGrid(
  tiled: TiledDispatchState,
  rowIndex: number,
): TiledDispatchState | null {
  const grid = normalizeGridShape(tiled)
  if (!Number.isInteger(rowIndex)) return null
  if (rowIndex < 0 || rowIndex >= grid.rows.length) return null
  // Same floor as lane removal: one row must survive.
  if (grid.rows.length <= 1) return null

  const start = rowStartIndex(grid.rows, rowIndex)
  const length = grid.rows[rowIndex]?.length ?? 0
  const lanes = [...grid.lanes.slice(0, start), ...grid.lanes.slice(start + length)]
  const rows = grid.rows.filter((_, i) => i !== rowIndex)

  return {
    lanes,
    rows,
    focusedLane: focusAfterRowRemoval(grid, rows, rowIndex, start, length),
    laneWeights: grid.laneWeights
      ? [...grid.laneWeights.slice(0, start), ...grid.laneWeights.slice(start + length)]
      : undefined,
  }
}

/**
 * Where focus lands when a row disappears.
 *
 * Focus must end up on something visible. A row entirely before the focused one
 * shifts it down; a row entirely after leaves it alone. When the focused row
 * ITSELF goes there is no session to follow, so focus goes to the start of
 * whichever row now occupies that ordinal — or the last row, when the removed
 * one was the last. Landing at a row start rather than a clamped flat index
 * keeps the user at the left edge of a row instead of somewhere arbitrary in
 * the middle of an unrelated one.
 */
function focusAfterRowRemoval(
  grid: NormalizedGrid,
  rows: DispatchGridRow[],
  rowIndex: number,
  start: number,
  length: number,
): number {
  if (grid.focusedLane >= start + length) return grid.focusedLane - length
  if (grid.focusedLane < start) return grid.focusedLane
  return rowStartIndex(rows, Math.min(rowIndex, rows.length - 1))
}

/**
 * One requested output row: how long, and which existing row it came from.
 *
 * `sourceRow: null` means a genuinely NEW row (empty lanes, no inherited
 * metadata). An index means "this output row IS that existing row", carrying
 * its lanes, project binding, density, and sizing forward.
 *
 * WHY the source is explicit rather than positional: the shape editor used to
 * hand over a bare `number[]`, which cannot express WHICH row was removed.
 * Deleting the middle of three rows shifted every later row up a slot, so a
 * positional apply re-pointed row 1's metadata at row 2's contents — it deleted
 * the LAST row and resized the survivors, evicting agents from rows the user
 * never touched. Row identity has to survive the trip.
 */
export type GridShapeRow = {
  length: number
  sourceRow: number | null
}

/**
 * Apply a complete row shape at once — the shape editor's commit path.
 *
 * Rows keep their identity through `sourceRow`, so their project binding,
 * density, and height survive: resizing is a statement about space and must
 * not silently unbind a row.
 *
 * Lane weights are dropped wholesale rather than remapped. A bulk reshape has
 * no positional intent to map old weights onto — the same reasoning that made
 * the old tile-count change reset `ratios` while the exact insert/remove
 * operations preserve them.
 */
export function setGridShape(
  tiled: TiledDispatchState,
  requested: GridShapeRow[],
): TiledDispatchState | null {
  if (!Array.isArray(requested)) return null
  if (requested.length < 1 || requested.length > MAX_DISPATCH_ROWS) return null
  if (
    requested.some(
      row =>
        !Number.isInteger(row.length) ||
        row.length < MIN_DISPATCH_TILES ||
        row.length > MAX_DISPATCH_TILES,
    )
  ) {
    return null
  }
  if (requested.reduce((sum, row) => sum + row.length, 0) > MAX_DISPATCH_LANES) {
    return null
  }

  const grid = normalizeGridShape(tiled)
  const focusedRow = rowIndexForLane(grid.rows, grid.focusedLane)
  const focusedColumn = focusedRow >= 0
    ? grid.focusedLane - rowStartIndex(grid.rows, focusedRow)
    : 0

  const lanes: DispatchLane[] = []
  const rows: DispatchGridRow[] = []
  let nextFocus: number | null = null

  for (const request of requested) {
    const source = request.sourceRow !== null ? grid.rows[request.sourceRow] : undefined
    const existing = source
      ? grid.lanes.slice(
        rowStartIndex(grid.rows, request.sourceRow!),
        rowStartIndex(grid.rows, request.sourceRow!) + source.length,
      )
      : []
    // Follow the focused lane to wherever its row ended up. Clamping a stale
    // flat index instead would silently move focus into a different row: in a
    // [2,2] grid focused on the bottom row, growing the TOP row to four lanes
    // makes flat index 3 a brand-new top-row lane, and the next session command
    // would target a row the user was not working in.
    if (source && request.sourceRow === focusedRow) {
      nextFocus = lanes.length + Math.min(focusedColumn, request.length - 1)
    }
    for (let column = 0; column < request.length; column++) {
      // Growth appends EMPTY lanes; shrinking drops from the row's tail.
      lanes.push(existing[column] ?? {})
    }
    rows.push({ ...(source ?? {}), length: request.length })
  }

  return {
    lanes,
    rows,
    focusedLane: Math.min(nextFocus ?? 0, Math.max(0, lanes.length - 1)),
    laneWeights: undefined,
  }
}

/** Flat index of a row's first lane. `rowIndex === rows.length` is the append position. */
export function rowStartIndex(rows: DispatchGridRow[], rowIndex: number): number {
  let start = 0
  for (let i = 0; i < rowIndex && i < rows.length; i++) {
    start += rows[i]?.length ?? 0
  }
  return start
}

/**
 * The row that owns a flat lane index, or -1.
 *
 * The inverse every command needs: New Lane, Remove Lane, and the row-scoped
 * project filter all start from `focusedLane` and must find its row. Zero-length
 * rows are skipped rather than claiming their neighbour's first lane —
 * normalizeGridShape removes those, but this helper is public and its contract
 * should not depend on having been called on normalized input.
 */
export function rowIndexForLane(rows: DispatchGridRow[], laneIndex: number): number {
  if (!Number.isInteger(laneIndex) || laneIndex < 0) return -1
  let start = 0
  for (let i = 0; i < rows.length; i++) {
    const length = rows[i]?.length ?? 0
    if (length > 0 && laneIndex < start + length) return i
    start += length
  }
  return -1
}
