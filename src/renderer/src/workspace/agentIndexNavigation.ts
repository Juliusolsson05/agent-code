import { withLaneSession } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'

// The navigation kinds that survived the unified layout (#992).
//
// Four tree kinds lived here first: 'focus-grid-pane', 'focus-tiled-tab-pane',
// 'replace-focused-tiled-tab' and 'swap-detached-into-focused-grid-pane'.
// Each of them moved focus inside — or swapped a session into — a tile tree
// or a Tile Tabs slot. Nothing renders a tree or Tile Tabs any more, so those
// branches could only mutate state the user cannot see; they were deleted
// rather than left as silent successes.
//
// 'focus-classic-dispatch' went next, when the stage became a required field:
// it was the fallback for a Dispatch with no lanes, which can no longer be
// represented. Two kinds remain, and they are the whole question a label
// asks — "is it already on a lane, or does the focused lane take it?"
export type AgentIndexNavigationKind =
  | 'focus-existing-tiled-dispatch-lane'
  | 'replace-focused-tiled-dispatch-lane'

export type AgentIndexNavigationIntent =
  | 'reuse-existing-view'
  | 'open-in-focused-tiled-dispatch-lane'

export type AgentIndexNavigationResult = {
  kind: AgentIndexNavigationKind
  state: WorkspaceState
  // `requiresWake` was a field here until #992, computed as "the target has a
  // detachedSessions record". That was a STRUCTURAL guess at a runtime fact —
  // wrong both ways: a parked agent already woken from a lane was re-woken,
  // and a tree leaf whose respawn had failed was not. Whether a backend exists
  // is a question for the runtime, which a pure state reducer does not have,
  // so the caller decides (hook/actions/agentIndexNavigation.ts).
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

  const tiled = state.stage
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
  // Defensive only: the stage invariant is "at least one lane", but this
  // reducer is handed arbitrary state by tests and by the control plane, and
  // writing a selection into a lane that does not exist would silently grow
  // `lanes` past what `rows` accounts for.
  if (!tiled.lanes[focusedLane]) return null

  const lanes = existingLane >= 0
    ? tiled.lanes
    : tiled.lanes.map((lane, index) => (
        index === focusedLane
          ? withLaneSession(lane, target.sessionId)
          : lane
      ))
  return {
    kind: existingLane >= 0
      ? 'focus-existing-tiled-dispatch-lane'
      : 'replace-focused-tiled-dispatch-lane',
    state: {
      ...state,
      // The active project follows the target. It is a LABEL now (U4): it
      // decides which project a new agent defaults into and which header is
      // highlighted, not which sessions a lane may resolve.
      //
      // This write used to carry a second one beside it. Project-scoped rows
      // derived from activeTabId, so a cross-project label had to promote the
      // layout-wide scope to 'global' or every untouched lane stopped
      // resolving and rendered "Not in this scope". The scope is gone — every
      // index lists every project and a lane resolves any live session — so
      // moving the label can no longer blank a lane.
      activeTabId: target.tabId,
      stage: { ...tiled, lanes, focusedLane },
    },
  }
}
