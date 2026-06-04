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
import { claimedSessionIds } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { SessionId } from '@renderer/workspace/types'

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

  // sessionId -> row, so a lane can resolve its tabId (renderWorkspaceLeaf
  // needs it) and so we can tell a live session from a dead one.
  const rowBySession = useMemo(() => {
    const map = new Map<SessionId, DispatchAgentRow>()
    for (const row of rows) map.set(row.sessionId, row)
    return map
  }, [rows])

  // Sanitize + auto-fill effect. Two jobs, both convergent:
  //   1. A lane whose session died while the tiled view was dormant points
  //      at a now-missing id. We can't render it, so overwrite it with a
  //      live unclaimed agent (setTiledLaneSession overwrites the dead id).
  //   2. An empty lane (no selection, or just emptied above) gets the next
  //      available unclaimed agent so the user lands on a populated cockpit.
  // Convergence: once every fillable lane holds a live, unique agent there
  // is nothing to assign and the effect is a no-op. If there are more lanes
  // than agents, the surplus lanes stay empty (render the picker prompt) and
  // the effect still settles because no available agent remains.
  useEffect(() => {
    // Ids currently held by lanes that still point at a LIVE session — these
    // are off-limits for filling other lanes (one-session-per-lane).
    const liveClaimed = new Set<SessionId>()
    for (const lane of lanes) {
      const id = lane.selectedSessionId
      if (id && state.sessions[id] !== undefined) liveClaimed.add(id)
    }
    const available = rows
      .map(row => row.sessionId)
      .filter(id => !liveClaimed.has(id))
    let cursor = 0
    for (let i = 0; i < lanes.length; i++) {
      const id = lanes[i].selectedSessionId
      const isLive = id !== undefined && state.sessions[id] !== undefined
      if (isLive) continue
      // Lane needs a live agent; take the next available one.
      while (cursor < available.length && liveClaimed.has(available[cursor])) cursor++
      const next = available[cursor]
      if (next === undefined) break // no more agents to hand out
      cursor++
      liveClaimed.add(next)
      workspace.setTiledLaneSession(i, next)
    }
    // Depend on the session set and lane selections; both change via setState
    // so identities are fresh when something relevant moves.
  }, [state.sessions, lanes, rows, workspace.setTiledLaneSession])

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

  // Resolve the (sessionId, tabId) a lane should render, or null if the lane
  // is empty / its session is gone (the auto-fill effect will replace it).
  const resolveLane = useCallback(
    (laneIndex: number): { sessionId: SessionId; tabId: string } | null => {
      const id = lanes[laneIndex]?.selectedSessionId
      if (!id || state.sessions[id] === undefined) return null
      const tabId = rowBySession.get(id)?.tabId ?? state.activeTabId
      return { sessionId: id, tabId }
    },
    [lanes, rowBySession, state.activeTabId, state.sessions],
  )

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
          focusSessionInTab={(tabId, sessionId) => {
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
        {lanes.map((_, laneIndex) => {
          const resolved = resolveLane(laneIndex)
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
              {laneIndex > 0 && (
                <div className="flex-shrink-0 w-[150px] min-h-0">
                  <DispatchMiniList
                    rows={rows}
                    selectedSessionId={lanes[laneIndex].selectedSessionId}
                    claimed={claimedSessionIds(lanes, laneIndex)}
                    focused={focused}
                    onSelect={row => {
                      workspace.setTiledLaneSession(laneIndex, row.sessionId)
                      workspace.setTiledFocusedLane(laneIndex)
                    }}
                  />
                </div>
              )}
              {/* The agent view. A subtle ring marks the keyboard-focused
                  lane so the user knows which lane arrows / cmd+N target. */}
              <div
                className={`flex-1 min-w-0 min-h-0 ${focused ? 'ring-1 ring-inset ring-accent/50' : ''}`}
                onMouseDownCapture={() => {
                  if (!focused) workspace.setTiledFocusedLane(laneIndex)
                }}
              >
                {resolved ? (
                  renderWorkspaceLeaf(
                    resolved.sessionId,
                    resolved.sessionId,
                    workspace,
                    resolved.tabId,
                    showStatusMode,
                    showWorktreeBadges,
                    () => workspace.setTiledFocusedLane(laneIndex),
                  )
                ) : (
                  <DispatchEmpty message="select an agent" />
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
        const pointer = (clientX - rect.left) / rect.width
        // Desired width of the left lane within the pair, clamped so neither
        // neighbour drops below the minimum.
        const desiredLeft = pointer - before
        const clampedLeft = Math.max(
          LANE_MIN_FRACTION,
          Math.min(pairTotal - LANE_MIN_FRACTION, desiredLeft),
        )
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
