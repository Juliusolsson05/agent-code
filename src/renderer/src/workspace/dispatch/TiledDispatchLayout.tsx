import { Fragment, useCallback, useMemo, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { AgentViewMode } from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import {
  buildDispatchGroups,
  buildPinnedDispatchRows,
  buildVisibleDispatchRows,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  clampIndexFraction,
  DEFAULT_INDEX_FRACTION,
  LANE_MIN_FRACTION,
  normalizeGridShape,
  ROW_MIN_FRACTION,
  rowStartIndex,
} from '@renderer/workspace/dispatch/gridShape'
import {
  DispatchAgentList,
  DispatchEmpty,
} from '@renderer/workspace/dispatch/DispatchAgentList'
import { DispatchMiniList } from '@renderer/workspace/dispatch/DispatchMiniList'
import type { DispatchGridRow, SessionId, TabId } from '@renderer/workspace/types'

type Props = {
  workspace: Workspace
  agentViewMode: AgentViewMode
  showStatusMode: boolean
  showWorktreeBadges: boolean
}

// Grid Dispatch: up to MAX_DISPATCH_ROWS stacked rows, each a COMPLETE dispatch
// view with its own index list, project binding, list density, and lanes.
//
// WHY each row carries its own index rather than one full-height sidebar
// serving the grid: a shared sidebar cannot answer "whose agents am I listing?"
// once two rows are bound to different projects, it leaves the per-row controls
// (project, child cap) with no home, and it makes "which lane does clicking a
// row select?" unanswerable across four rows. A per-row index answers all three
// by construction.
//
// Sizing model:
//   rows[i].height        — relative row height; absent => equal share
//   rows[i].indexFraction — that row's index width, clamped 0.1..0.4
//   laneWeights[]         — row-major, one per lane, normalized WITHIN each row
//
// Row lengths are independent (`rows[i].length`). There is deliberately no
// global column count anywhere here: four lanes on top and two below is the
// expected shape, not a degenerate one.

type LaneResolution = {
  sessionId: SessionId
  tabId: TabId
  paneLabel: string
} | null

/** Normalize a weight slice to fractions summing to 1, falling back to even. */
function normalizedWeights(raw: number[] | undefined, count: number): number[] {
  if (count <= 0) return []
  if (!raw || raw.length !== count || raw.some(w => !Number.isFinite(w) || w <= 0)) {
    return Array.from({ length: count }, () => 1 / count)
  }
  const sum = raw.reduce((a, b) => a + b, 0)
  if (sum <= 0) return Array.from({ length: count }, () => 1 / count)
  return raw.map(w => w / sum)
}

export function TiledDispatchLayout({
  workspace,
  agentViewMode,
  showStatusMode,
  showWorktreeBadges,
}: Props) {
  const state = workspace.state
  const tiled = state.dispatchMode!.tiled!
  // Normalized once per state change, so every child renders against a shape
  // whose row lengths are guaranteed to sum to the lane count. Nothing below
  // this line may splice lanes — that belongs in gridShape, behind the reducers.
  const grid = useMemo(() => normalizeGridShape(tiled), [tiled])

  // The whole reason the "+" carries an explicit project intent: in this layout
  // the focused LANE decides the spawn target, and lane selection never touches
  // activeTabId. Resolving the project at commit time would spawn into whatever
  // lane 0 happens to show, not the header the user clicked.
  const openNewAgentForProject = useAppStore(state_ => state_.openNewAgentForProject)
  // Lives on the app store rather than the workspace: it is overlay visibility,
  // not workspace state, and the surface registry reads it at the app root.
  const openRowProjectPicker = useAppStore(state_ => state_.openDispatchRowProjectPicker)

  const groups = useMemo(() => buildDispatchGroups(state), [state])
  const pinnedRows = useMemo(() => buildPinnedDispatchRows(state), [state])
  const rows = useMemo(() => buildVisibleDispatchRows(state), [state])

  // sessionId -> row. A session is renderable in a lane ONLY if it appears
  // here: this is the scope-correct source of truth for both "is it alive?"
  // and "which tab owns it?". Using state.sessions for liveness instead would
  // let an out-of-scope session count as live, and then lane resolution would
  // have no row to read the tab from and would wrongly fall back to activeTabId.
  const rowBySession = useMemo(() => {
    const map = new Map<SessionId, DispatchAgentRow>()
    for (const row of rows) map.set(row.sessionId, row)
    return map
  }, [rows])

  // Resolve every lane from the canonical visible row. A lane resolves iff its
  // session is alive AND in scope. We deliberately do NOT de-dup: the same
  // session may resolve in multiple lanes and each renders it (the views
  // mirror). An unresolved lane renders empty and KEEPS its selection —
  // nothing re-homes it, which is the #681 contract.
  const laneResolutions = useMemo<LaneResolution[]>(
    () =>
      grid.lanes.map(lane => {
        const id = lane.selectedSessionId
        if (!id) return null
        const row = rowBySession.get(id)
        if (!row) return null // dead, or not in the current dispatch scope
        return { sessionId: id, tabId: row.tabId, paneLabel: row.label }
      }),
    [grid.lanes, rowBySession],
  )

  const gridRef = useRef<HTMLDivElement | null>(null)
  const rowHeights = normalizedWeights(
    grid.rows.map(row => row.height ?? 1),
    grid.rows.length,
  )

  const setRowHeights = workspace.setDispatchRowHeights
  const onDragRowBoundary = useCallback(
    (rowIndex: number, clientY: number) => {
      const el = gridRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.height <= 0) return
      // Single-boundary semantics, matching the grid's SplitContainer divider
      // and the lane boundaries below: dragging re-weights only the two
      // adjacent rows and leaves every other row untouched.
      const above = rowIndex - 1
      let before = 0
      for (let i = 0; i < above; i++) before += rowHeights[i]!
      const pairTotal = rowHeights[above]! + rowHeights[rowIndex]!
      // Cap the minimum at half the pair: at high row counts pairTotal can be
      // below 2 * ROW_MIN_FRACTION, which would invert the clamp and give the
      // lower row a negative height.
      const min = Math.min(ROW_MIN_FRACTION, pairTotal / 2)
      const desired = (clientY - rect.top) / rect.height - before
      const clamped = Math.max(min, Math.min(pairTotal - min, desired))
      const next = rowHeights.slice()
      next[above] = clamped
      next[rowIndex] = pairTotal - clamped
      setRowHeights(next)
    },
    [rowHeights, setRowHeights],
  )

  return (
    <div ref={gridRef} className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden bg-canvas">
      {grid.rows.map((gridRow, rowIndex) => (
        <Fragment key={rowIndex}>
          {rowIndex > 0 && (
            <RowBoundary rowIndex={rowIndex} onDrag={onDragRowBoundary} />
          )}
          <GridRowView
            gridRow={gridRow}
            rowIndex={rowIndex}
            heightWeight={rowHeights[rowIndex] ?? 1}
            grid={grid}
            groups={groups}
            pinnedRows={pinnedRows}
            rows={rows}
            laneResolutions={laneResolutions}
            workspace={workspace}
            agentViewMode={agentViewMode}
            showStatusMode={showStatusMode}
            showWorktreeBadges={showWorktreeBadges}
            onCreateAgentInProject={openNewAgentForProject}
            onPickRowProject={openRowProjectPicker}
          />
        </Fragment>
      ))}
    </div>
  )
}

// A horizontal divider between two rows. Its own component so each instance
// owns one unconditional useResizableSplitter call.
function RowBoundary({
  rowIndex,
  onDrag,
}: {
  rowIndex: number
  onDrag: (rowIndex: number, clientY: number) => void
}) {
  const splitter = useResizableSplitter({
    axis: 'y',
    onDrag: useCallback((clientY: number) => onDrag(rowIndex, clientY), [onDrag, rowIndex]),
  })
  return (
    <>
      <SplitHandle
        dragging={splitter.dragging}
        onMouseDown={splitter.onMouseDown}
        hitSizePx={10}
        barSizePx={4}
        orientation="horizontal"
      />
      {splitter.cursorLock}
    </>
  )
}

function GridRowView({
  gridRow,
  rowIndex,
  heightWeight,
  grid,
  groups,
  pinnedRows,
  rows,
  laneResolutions,
  workspace,
  agentViewMode,
  showStatusMode,
  showWorktreeBadges,
  onCreateAgentInProject,
  onPickRowProject,
}: {
  gridRow: DispatchGridRow
  rowIndex: number
  heightWeight: number
  grid: ReturnType<typeof normalizeGridShape>
  groups: ReturnType<typeof buildDispatchGroups>
  pinnedRows: DispatchAgentRow[]
  rows: DispatchAgentRow[]
  laneResolutions: LaneResolution[]
  workspace: Workspace
  agentViewMode: AgentViewMode
  showStatusMode: boolean
  showWorktreeBadges: boolean
  onCreateAgentInProject: (tabId: TabId, anchorSessionId: SessionId) => void
  onPickRowProject: (rowIndex: number) => void
}) {
  const start = rowStartIndex(grid.rows, rowIndex)
  const end = start + gridRow.length
  const laneWeights = normalizedWeights(
    grid.laneWeights?.slice(start, end),
    gridRow.length,
  )
  const indexFraction = clampIndexFraction(gridRow.indexFraction ?? DEFAULT_INDEX_FRACTION)
  const focusedLaneInRow =
    grid.focusedLane >= start && grid.focusedLane < end ? grid.focusedLane : null

  const rowRef = useRef<HTMLDivElement | null>(null)
  const laneRegionRef = useRef<HTMLDivElement | null>(null)

  const setIndexFraction = workspace.setDispatchRowIndexFraction
  const indexSplitter = useResizableSplitter({
    onDrag: useCallback(
      (clientX: number) => {
        const el = rowRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        setIndexFraction(rowIndex, (clientX - rect.left) / rect.width)
      },
      [rowIndex, setIndexFraction],
    ),
  })

  // The row's index selects into the FOCUSED lane when focus is already in this
  // row; otherwise it moves focus to this row's first lane and selects there.
  //
  // WHY not remember a per-row column: that would be a SECOND source of focus
  // truth beside the flat `focusedLane`, which is the exact shape of
  // #266/#267/#271/#272. One scalar, one rule. Clicking a row's index also
  // means "I am working in this row now", so moving focus there is what the
  // user meant.
  const selectIntoRow = useCallback(
    (sessionId: SessionId) => {
      const target = focusedLaneInRow ?? start
      workspace.setTiledLaneSession(target, sessionId)
      workspace.setTiledFocusedLane(target)
    },
    [focusedLaneInRow, start, workspace],
  )

  return (
    <div
      ref={rowRef}
      className="min-h-0 min-w-0 flex overflow-hidden"
      style={{ flexGrow: heightWeight, flexBasis: 0 }}
    >
      <div
        className="flex-shrink-0 min-h-0 border-r border-border"
        style={{ width: `${(indexFraction * 100).toFixed(2)}%` }}
      >
        <DispatchAgentList
          groups={groups}
          pinnedRows={pinnedRows}
          activeSessionId={
            focusedLaneInRow !== null
              ? grid.lanes[focusedLaneInRow]?.selectedSessionId ?? null
              : null
          }
          dispatchScope={workspace.state.dispatchMode?.scope === 'global' ? 'global' : 'project'}
          focusSessionInTab={(_tabId, sessionId) => selectIntoRow(sessionId)}
          showWorktreeBadges={showWorktreeBadges}
          onCreateAgentInProject={onCreateAgentInProject}
          gridRow={gridRow}
          onToggleExpandedParent={sessionId =>
            workspace.toggleDispatchRowExpandedParent(rowIndex, sessionId)
          }
          onToggleCapChildren={() =>
            workspace.setDispatchRowCapChildren(rowIndex, gridRow.capChildren === false)
          }
          onPickRowProject={() => onPickRowProject(rowIndex)}
        />
      </div>

      <SplitHandle
        dragging={indexSplitter.dragging}
        onMouseDown={indexSplitter.onMouseDown}
        hitSizePx={10}
        barSizePx={4}
      />
      {indexSplitter.cursorLock}

      <div ref={laneRegionRef} className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
        {Array.from({ length: gridRow.length }, (_, column) => {
          const laneIndex = start + column
          const lane = grid.lanes[laneIndex]
          const resolved = laneResolutions[laneIndex]
          const focused = grid.focusedLane === laneIndex
          return (
            <div
              key={laneIndex}
              className="flex min-w-0 min-h-0 overflow-hidden"
              style={{ flexGrow: laneWeights[column], flexBasis: 0 }}
            >
              {column > 0 && (
                <LaneBoundary
                  column={column}
                  rowStart={start}
                  rowLength={gridRow.length}
                  laneWeights={laneWeights}
                  allWeights={grid.laneWeights}
                  laneCount={grid.lanes.length}
                  regionRef={laneRegionRef}
                  workspace={workspace}
                />
              )}
              {/* EVERY lane gets a strip, including each row's first. The old
                  layout gave lane 0 no strip because the sidebar WAS its
                  selector; with a per-row index that special case is
                  meaningless — the index belongs to the row, not to its first
                  lane. */}
              <div className="flex-shrink-0 min-h-0">
                <DispatchMiniList
                  rows={rows}
                  gridRow={gridRow}
                  selectedSessionId={lane?.selectedSessionId}
                  focused={focused}
                  onSelect={row => {
                    workspace.setTiledLaneSession(laneIndex, row.sessionId)
                    workspace.setTiledFocusedLane(laneIndex)
                  }}
                  // Without this the strip's "+N more" renders as a button and
                  // does nothing — an affordance that promises an action it
                  // cannot perform, in the exact case the cap exists for.
                  onToggleExpandedParent={sessionId =>
                    workspace.toggleDispatchRowExpandedParent(rowIndex, sessionId)
                  }
                />
              </div>
              <div
                className="relative flex-1 min-w-0 min-h-0"
                onMouseDownCapture={() => {
                  if (!focused) workspace.setTiledFocusedLane(laneIndex)
                }}
              >
                {resolved ? (
                  renderWorkspaceLeaf(
                    resolved.sessionId,
                    focused ? resolved.sessionId : null,
                    workspace,
                    resolved.tabId,
                    agentViewMode,
                    showStatusMode,
                    showWorktreeBadges,
                    () => workspace.setTiledFocusedLane(laneIndex),
                    false,
                    resolved.paneLabel,
                  )
                ) : (
                  <DispatchEmpty
                    message={lane?.selectedSessionId ? 'Not in this scope' : 'Empty lane'}
                    // The hint names a key that acts on `focusedLane`, so it
                    // must only appear in the lane that keystroke would move.
                    // Advertising it in an unfocused lane would tell the user
                    // to press something that yanks the agent they are working
                    // with and leaves this lane untouched.
                    hint={
                      focused && !lane?.selectedSessionId
                        ? gridRow.projectTabId
                          ? 'Pick an agent from the strip, or press ⌥↓'
                          : 'Pick an agent from the strip, or press ⌥↓ for the top of the index'
                        : undefined
                    }
                  />
                )}
                {!focused && (
                  <div className="absolute inset-0 pointer-events-none bg-canvas/34 ring-1 ring-inset ring-border" />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// A draggable boundary between two lanes IN THE SAME ROW. Re-weights only the
// two neighbours and writes back into the row-major weight array, leaving every
// other row's slice byte-for-byte intact.
function LaneBoundary({
  column,
  rowStart,
  rowLength,
  laneWeights,
  allWeights,
  laneCount,
  regionRef,
  workspace,
}: {
  column: number
  rowStart: number
  rowLength: number
  laneWeights: number[]
  allWeights: number[] | undefined
  laneCount: number
  regionRef: React.RefObject<HTMLDivElement | null>
  workspace: Workspace
}) {
  const setLaneWeights = workspace.setDispatchLaneWeights
  const splitter = useResizableSplitter({
    onDrag: useCallback(
      (clientX: number) => {
        const el = regionRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        const left = column - 1
        let before = 0
        for (let i = 0; i < left; i++) before += laneWeights[i]!
        const pairTotal = laneWeights[left]! + laneWeights[column]!
        const min = Math.min(LANE_MIN_FRACTION, pairTotal / 2)
        const desired = (clientX - rect.left) / rect.width - before
        const clamped = Math.max(min, Math.min(pairTotal - min, desired))

        // Materialize the full row-major array. An absent `laneWeights` means
        // "even everywhere", so the untouched rows have to be written out
        // explicitly rather than left undefined — a partial array is dropped
        // wholesale on read, which would silently discard this drag.
        const next = allWeights && allWeights.length === laneCount
          ? allWeights.slice()
          : Array.from({ length: laneCount }, () => 1)
        for (let i = 0; i < rowLength; i++) next[rowStart + i] = laneWeights[i]!
        next[rowStart + left] = clamped
        next[rowStart + column] = pairTotal - clamped
        setLaneWeights(next)
      },
      [column, rowStart, rowLength, laneWeights, allWeights, laneCount, regionRef, setLaneWeights],
    ),
  })
  return (
    <>
      <SplitHandle
        dragging={splitter.dragging}
        onMouseDown={splitter.onMouseDown}
        hitSizePx={10}
        barSizePx={4}
      />
      {splitter.cursorLock}
    </>
  )
}
