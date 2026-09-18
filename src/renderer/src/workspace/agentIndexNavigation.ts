import { withLaneSession } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'

// The navigation kinds that survived the unified layout (#992).
//
// Four more lived here: 'focus-grid-pane', 'focus-tiled-tab-pane',
// 'replace-focused-tiled-tab' and 'swap-detached-into-focused-grid-pane'.
// Each of them moved focus inside — or swapped a session into — a tile tree
// or a Tile Tabs slot. Nothing renders a tree or Tile Tabs any more, so those
// branches could only mutate state the user cannot see; they were deleted
// rather than left as silent successes.
export type AgentIndexNavigationKind =
  | 'focus-classic-dispatch'
  | 'focus-existing-tiled-dispatch-lane'
  | 'replace-focused-tiled-dispatch-lane'

export type AgentIndexNavigationIntent =
  | 'reuse-existing-view'
  | 'open-in-focused-tiled-dispatch-lane'

export type AgentIndexNavigationResult = {
  kind: AgentIndexNavigationKind
  state: WorkspaceState
  /** Parked sessions may be hibernated after app restart. The caller must
   *  wake the target under the same SessionId before committing this result. */
  requiresWake: boolean
}

/**
 * Compute the one navigation mutation behind command-palette agent labels.
 *
 * WHY this is a pure workspace reducer instead of a branch pile in
 * CommandPalette: "A2 is already open" has a precise meaning — a lane already
 * shows it. Keeping the precedence here lets tests prove the key invariant:
 * an existing lane wins, and the focused lane is replaced only when no lane
 * can display the target (or the user asked for the focused lane with `A2!`).
 */
export function navigateToAgentIndexTarget(
  state: WorkspaceState,
  target: AgentPaneLabelTarget,
  intent: AgentIndexNavigationIntent = 'reuse-existing-view',
): AgentIndexNavigationResult | null {
  // Any session kind is a valid navigation target (#865): this guard used to
  // also require an AgentProviderKind, but ⌘N and ⌥↑/↓ already moved focus
  // onto terminals, so the label/index path only needs to confirm the session
  // still exists — the same check every branch below already assumes.
  const meta = state.sessions[target.sessionId]
  if (!meta) return null

  const requiresWake = state.detachedSessions[target.sessionId] !== undefined
  const dispatchMode = state.dispatchMode
  // Only reachable before bootstrap has seeded the stage: there is no lane to
  // navigate into yet, so there is honestly nothing to do.
  if (!dispatchMode) return null

  if (dispatchMode.tiled) {
    const tiled = dispatchMode.tiled
    const forceFocusedLane = intent === 'open-in-focused-tiled-dispatch-lane'
    // Duplicated lanes are legal. If the currently focused lane already shows
    // the target, keep it rather than jumping left to the first duplicate;
    // otherwise the first rendered copy is the deterministic destination.
    //
    // WHY the bang intent deliberately reports no existing lane: `A2!` is the
    // user's request to curate the CURRENT lane, not to discover where A2 is
    // already visible. Mirrored lanes are explicitly permitted, so skipping
    // this lookup creates another view of the same live session without
    // cloning or restarting its provider process.
    const existingLane = forceFocusedLane
      ? -1
      : tiled.lanes[tiled.focusedLane]?.selectedSessionId === target.sessionId
        ? tiled.focusedLane
        : tiled.lanes.findIndex(lane => lane.selectedSessionId === target.sessionId)
    const focusedLane = existingLane >= 0
      ? existingLane
      : Math.max(0, Math.min(tiled.focusedLane, tiled.lanes.length - 1))
    if (focusedLane < 0 || !tiled.lanes[focusedLane]) return null

    const lanes = existingLane >= 0
      ? tiled.lanes
      : tiled.lanes.map((lane, index) => (
          index === focusedLane
            ? withLaneSession(lane, target.sessionId)
            : lane
        ))
    const crossesProjectScope =
      dispatchMode.scope !== 'global' && target.tabId !== state.activeTabId
    return {
      kind: existingLane >= 0
        ? 'focus-existing-tiled-dispatch-lane'
        : 'replace-focused-tiled-dispatch-lane',
      state: {
        ...state,
        // Project-scoped rows derive from activeTabId. A cross-project label
        // must move that scope before selecting the session, or the lane
        // cannot resolve and renders "Not in this scope" instead of the agent
        // the user just asked for. (Before #681 the consequence was worse —
        // the healer replaced the selection outright.)
        activeTabId: target.tabId,
        dispatchMode: {
          ...dispatchMode,
          // A project-scoped row set cannot retain lanes from project A after
          // activeTabId moves to project B: every untouched A lane would stop
          // resolving and render empty. Promoting the one cross-project
          // navigation to global keeps both the retained lanes and the
          // incoming target renderable, preserving the "replace only the
          // focused lane" invariant. Their selections would survive either
          // way now (#681), but a grid of blank lanes is not a useful place
          // to land.
          scope: crossesProjectScope ? 'global' : dispatchMode.scope,
          // Keep the remembered single focus coherent with the lane.
          focusedSessionId: target.sessionId,
          tiled: {
            ...tiled,
            lanes,
            focusedLane,
          },
        },
      },
      requiresWake,
    }
  }

  // A stage-less dispatchMode only exists between a state reset and the
  // bootstrap seed; keep the selection honest rather than dropping it.
  return {
    kind: 'focus-classic-dispatch',
    state: {
      ...state,
      activeTabId: target.tabId,
      dispatchMode: {
        ...dispatchMode,
        focusedSessionId: target.sessionId,
      },
    },
    requiresWake,
  }
}
