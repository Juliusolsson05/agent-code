import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import {
  buildDispatchGroups,
  buildPinnedDispatchRows,
  buildVisibleDispatchRows,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  DispatchAgentList,
  DispatchEmpty,
} from '@renderer/workspace/dispatch/DispatchAgentList'
import { DispatchMiniList } from '@renderer/workspace/dispatch/DispatchMiniList'
import type { SessionId, TabId } from '@renderer/workspace/types'

type Props = {
  workspace: Workspace
  showStatusMode: boolean
  showWorktreeBadges: boolean
}

// Column-width convention for tiled.ratios:
//   ratios[0]      = fraction of the whole row given to the pinned index
//                    lane (clamped 0.1..0.4 — the index must stay readable
//                    but can't eat the whole row).
//   ratios[1..N]   = relative weights for the N agent-view lane UNITS that
//                    share the remaining width. A "unit" is one lane's
//                    [mini-list?][agent view] pair. Weights are normalized
//                    on read, so their absolute scale is irrelevant.
// Absent / wrong-length => sensible defaults (even split). Reset to
// undefined on tile-count change (a weight array sized for the old lane
// count would mis-lay-out the new set).
const INDEX_MIN = 0.1
const INDEX_MAX = 0.4
const DEFAULT_INDEX_FRACTION = 0.18
// Minimum fraction (of the lane region) a single lane unit may shrink to
// while dragging, so a lane can never be dragged to zero width.
const LANE_MIN_FRACTION = 0.08

function clampIndexFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INDEX_FRACTION
  return Math.max(INDEX_MIN, Math.min(INDEX_MAX, value))
}

// Normalize the per-lane weight slice to fractions summing to 1. Falls
// back to an even split when absent or malformed.
function normalizedLaneWeights(ratios: number[] | undefined, laneCount: number): number[] {
  const raw = ratios?.slice(1)
  if (!raw || raw.length !== laneCount || raw.some(w => !Number.isFinite(w) || w <= 0)) {
    return Array.from({ length: laneCount }, () => 1 / laneCount)
  }
  const sum = raw.reduce((a, b) => a + b, 0)
  if (sum <= 0) return Array.from({ length: laneCount }, () => 1 / laneCount)
  return raw.map(w => w / sum)
}

type LaneResolution = { sessionId: SessionId; tabId: TabId } | null

export function TiledDispatchLayout({
  workspace,
  showStatusMode,
  showWorktreeBadges,
}: Props) {
  const state = workspace.state
  const tiled = state.dispatchMode!.tiled!
  const lanes = tiled.lanes

  const groups = useMemo(() => buildDispatchGroups(state), [state])
  const pinnedRows = useMemo(() => buildPinnedDispatchRows(state), [state])
  const rows = useMemo(() => buildVisibleDispatchRows(state), [state])

  // sessionId -> row. A session is renderable in a lane ONLY if it appears
  // here: this is the scope-correct source of truth for both "is it alive?"
  // and "which tab owns it?". Using state.sessions for liveness instead
  // would let an out-of-scope (different project) session count as live,
  // and then resolveLane would have no row to read the tab from and would
  // wrongly fall back to activeTabId. Keying everything off the visible
  // rows keeps liveness and tab resolution on the same source.
  const rowBySession = useMemo(() => {
    const map = new Map<SessionId, DispatchAgentRow>()
    for (const row of rows) map.set(row.sessionId, row)
    return map
  }, [rows])

  // Resolve every lane to {sessionId, tabId} | null. A lane resolves iff its
  // session is alive AND in the current dispatch scope (present in
  // rowBySession) — the scope-correct liveness + tab source. We deliberately
  // do NOT de-dup: the same session may resolve in multiple lanes and each
  // renders it. Claude/Codex views mirror for free (shared per-session
  // runtime, input keyed by sessionId); terminals mirror once multi-attach
  // lands. An empty/dead/out-of-scope lane resolves to null and the heal
  // effect re-homes it.
  const laneResolutions = useMemo<LaneResolution[]>(() => {
    return lanes.map(lane => {
      const id = lane.selectedSessionId
      if (!id) return null
      const row = rowBySession.get(id)
      if (!row) return null // dead, or not in the current dispatch scope
      return { sessionId: id, tabId: row.tabId }
    })
  }, [lanes, rowBySession])

  // Auto-fill / heal effect. Any lane that did NOT resolve (empty, dead,
  // out-of-scope, or a de-duped duplicate) is handed the next visible agent
  // not already resolved by another lane. Convergent: once every fillable
  // lane holds a unique, in-scope, live agent there is nothing to assign.
  // If there are more lanes than agents the surplus stay empty (picker
  // prompt) and the effect settles. setTiledLaneSession overwrites the
  // lane's stale id, so this also repairs the live-duplicate case (the
  // second lane's old id is replaced rather than left double-mounted).
  useEffect(() => {
    const resolvedIds = new Set<SessionId>()
    for (const r of laneResolutions) if (r) resolvedIds.add(r.sessionId)
    const available = rows
      .map(row => row.sessionId)
      .filter(id => !resolvedIds.has(id))
    let cursor = 0
    for (let i = 0; i < laneResolutions.length; i++) {
      if (laneResolutions[i]) continue
      const next = available[cursor]
      if (next === undefined) break // no more agents to hand out
      cursor++
      resolvedIds.add(next)
      workspace.setTiledLaneSession(i, next)
    }
  }, [laneResolutions, rows, workspace.setTiledLaneSession])

  const indexFraction = clampIndexFraction(tiled.ratios?.[0] ?? DEFAULT_INDEX_FRACTION)
  const laneWeights = normalizedLaneWeights(tiled.ratios, lanes.length)

  const rowRef = useRef<HTMLDivElement | null>(null)
  const laneRegionRef = useRef<HTMLDivElement | null>(null)

  // Index/lane-region splitter — identical math to the classic layout's
  // list splitter, but writes ratios[0] on the tiled state instead of the
  // shared uiShell dispatchListRatio (tiled width is per-tiled-layout).
  const indexSplitter = useResizableSplitter({
    onDrag: useCallback(
      (clientX: number) => {
        const el = rowRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        const fraction = clampIndexFraction((clientX - rect.left) / rect.width)
        workspace.setTiledRatios([fraction, ...laneWeights])
      },
      [workspace.setTiledRatios, laneWeights],
    ),
  })

  return (
    <div
      ref={rowRef}
      className="h-full min-h-0 min-w-0 flex overflow-hidden bg-canvas"
    >
      {/* Lane 0's SELECTOR is the full pinned index. Fixed fraction width,
          never shrinks — at high tile counts the lane region to the right
          is what compresses, keeping the rich index legible. */}
      <div
        className="flex-shrink-0 min-h-0 border-r border-border"
        style={{ width: `${(indexFraction * 100).toFixed(2)}%` }}
      >
        <DispatchAgentList
          groups={groups}
          pinnedRows={pinnedRows}
          activeSessionId={lanes[0]?.selectedSessionId ?? null}
          dispatchScope={state.dispatchMode?.scope === 'global' ? 'global' : 'project'}
          focusSessionInTab={(_tabId, sessionId) => {
            workspace.setTiledLaneSession(0, sessionId)
            workspace.setTiledFocusedLane(0)
          }}
          showWorktreeBadges={showWorktreeBadges}
        />
      </div>

      <SplitHandle
        dragging={indexSplitter.dragging}
        onMouseDown={indexSplitter.onMouseDown}
        hitSizePx={10}
        barSizePx={4}
      />
      {indexSplitter.cursorLock}

      {/* Lane region: the N agent-view units share this space by weight. */}
      <div ref={laneRegionRef} className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
        {lanes.map((lane, laneIndex) => {
          const resolved = laneResolutions[laneIndex]
          const focused = tiled.focusedLane === laneIndex
          return (
            <div
              key={laneIndex}
              className="flex min-w-0 min-h-0 overflow-hidden"
              style={{ flexGrow: laneWeights[laneIndex], flexBasis: 0 }}
            >
              {/* Lanes after the first carry their own compact selector.
                  Lane 0 is selected from the full index above, so it has no
                  mini-list of its own. A boundary splitter precedes each
                  mini-list so dragging it re-weights the two adjacent lanes. */}
              {laneIndex > 0 && (
                <LaneBoundary
                  laneIndex={laneIndex}
                  laneWeights={laneWeights}
                  indexFraction={indexFraction}
                  regionRef={laneRegionRef}
                  workspace={workspace}
                />
              )}
              {/* Chips-only selector for this lane — a thin w-9 strip the
                  exact width of the index's chip cell. No title/dot/header. */}
              {laneIndex > 0 && (
                <div className="flex-shrink-0 w-9 min-h-0">
                  <DispatchMiniList
                    rows={rows}
                    selectedSessionId={lane.selectedSessionId}
                    focused={focused}
                    onSelect={row => {
                      workspace.setTiledLaneSession(laneIndex, row.sessionId)
                      workspace.setTiledFocusedLane(laneIndex)
                    }}
                  />
                </div>
              )}
              {/* Agent view. Focus affordance mirrors tiled-tabs: only the
                  focused lane passes a real focusedSessionId (so only IT gets
                  TileLeaf's accent border — fixes the old "border on every
                  lane" bug where the sessionId was passed as its own focus
                  id), and every NON-focused lane gets the same translucent
                  scrim tiled-tabs uses for unfocused tabs, so the one bright
                  agent is unmistakably where you are. The scrim is
                  pointer-events-none so clicking a dimmed lane still focuses
                  it. */}
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
                    showStatusMode,
                    showWorktreeBadges,
                    () => workspace.setTiledFocusedLane(laneIndex),
                  )
                ) : (
                  <DispatchEmpty message="select an agent" />
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

// A draggable boundary between agent-view lane (laneIndex-1) and laneIndex.
// Reuses useResizableSplitter; on drag it sets the cumulative boundary
// position from the pointer and re-weights the two neighbours, leaving all
// other lanes untouched — same single-boundary semantics as the grid's
// SplitContainer divider.
function LaneBoundary({
  laneIndex,
  laneWeights,
  indexFraction,
  regionRef,
  workspace,
}: {
  laneIndex: number
  laneWeights: number[]
  indexFraction: number
  regionRef: React.RefObject<HTMLDivElement | null>
  workspace: Workspace
}) {
  const splitter = useResizableSplitter({
    onDrag: useCallback(
      (clientX: number) => {
        const el = regionRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        const left = laneIndex - 1
        const right = laneIndex
        // Cumulative fraction up to (but not including) the left lane.
        let before = 0
        for (let i = 0; i < left; i++) before += laneWeights[i]
        const pairTotal = laneWeights[left] + laneWeights[right]
        // Per-pair minimum: at high lane counts pairTotal can be below
        // 2*LANE_MIN_FRACTION, in which case a fixed LANE_MIN_FRACTION would
        // invert the clamp (Math.min(pairTotal-min, …) goes negative and the
        // right lane ends up zero/negative width). Cap the min at half the
        // pair so both sides always get a non-negative share.
        const min = Math.min(LANE_MIN_FRACTION, pairTotal / 2)
        const pointer = (clientX - rect.left) / rect.width
        const desiredLeft = pointer - before
        const clampedLeft = Math.max(min, Math.min(pairTotal - min, desiredLeft))
        const next = laneWeights.slice()
        next[left] = clampedLeft
        next[right] = pairTotal - clampedLeft
        workspace.setTiledRatios([indexFraction, ...next])
      },
      [laneIndex, laneWeights, indexFraction, regionRef, workspace.setTiledRatios],
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
