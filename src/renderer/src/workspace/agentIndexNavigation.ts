import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

import { selectedGridRelatedSessionId } from '@renderer/workspace/gridRelatedAgents'
import {
  collectLeaves,
  remapTileTreeSessionIds,
} from '@renderer/workspace/tile-tree/treeOps'
import type {
  SessionId,
  TabId,
  TileTabsState,
  WorkspaceState,
} from '@renderer/workspace/types'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'

export type AgentIndexNavigationKind =
  | 'focus-grid-pane'
  | 'focus-tiled-tab-pane'
  | 'replace-focused-tiled-tab'
  | 'focus-classic-dispatch'
  | 'focus-existing-tiled-dispatch-lane'
  | 'replace-focused-tiled-dispatch-lane'
  | 'swap-detached-into-focused-grid-pane'

export type AgentIndexNavigationResult = {
  kind: AgentIndexNavigationKind
  state: WorkspaceState
  tileTabs: TileTabsState | null
  /** Detached sessions may be hibernated after app restart. The caller must
   *  wake the target under the same SessionId before committing this result. */
  requiresWake: boolean
}

type GridViewSlot = {
  tabId: TabId
  ownerSessionId: SessionId
}

/**
 * Compute the one navigation mutation behind command-palette agent labels.
 *
 * WHY this is a pure workspace reducer instead of a branch pile in
 * CommandPalette: "A2 is already open" means a different thing in each
 * top-level surface. Keeping the precedence here lets tests prove the key
 * invariant globally: an existing rendered slot wins, and the focused slot is
 * replaced only when no existing slot can display the target.
 */
export function navigateToAgentIndexTarget(
  state: WorkspaceState,
  tileTabs: TileTabsState | null,
  target: AgentPaneLabelTarget,
): AgentIndexNavigationResult | null {
  const meta = state.sessions[target.sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  if (!meta || !isAgentProviderKind(kind)) return null

  const requiresWake = state.detachedSessions[target.sessionId] !== undefined
  const dispatchMode = state.dispatchMode
  // TileTabs is the visible MainSurface whenever both slices are restored.
  // Normal actions keep the modes mutually exclusive, but rehydrate accepts
  // both persisted fields independently. Never mutate hidden Dispatch state
  // while the user is looking at tiled tabs.
  if (!tileTabs && dispatchMode?.tiled) {
    const tiled = dispatchMode.tiled
    // Duplicated lanes are legal. If the currently focused lane already shows
    // the target, keep it rather than jumping left to the first duplicate;
    // otherwise the first rendered copy is the deterministic destination.
    const existingLane =
      tiled.lanes[tiled.focusedLane]?.selectedSessionId === target.sessionId
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
            ? { ...lane, selectedSessionId: target.sessionId }
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
        // Project-scoped Dispatch derives its visible rows from activeTabId.
        // A cross-project label must move that scope before selecting the
        // session or the layout's healing effect will reject the lane as
        // out-of-scope and immediately replace it with an unrelated row.
        activeTabId: target.tabId,
        dispatchMode: {
          ...dispatchMode,
          // A project-scoped row set cannot retain lanes from project A after
          // activeTabId moves to project B. TiledDispatchLayout would treat all
          // untouched A lanes as out-of-scope and heal them away. Promoting the
          // one cross-project navigation to global makes both the retained
          // lanes and incoming target renderable, preserving the issue's
          // "replace only the focused lane" invariant.
          scope: crossesProjectScope ? 'global' : dispatchMode.scope,
          // Keep classic focus coherent for a later exit from tiled mode.
          focusedSessionId: target.sessionId,
          tiled: {
            ...tiled,
            lanes,
            focusedLane,
          },
        },
      },
      tileTabs,
      requiresWake,
    }
  }

  if (!tileTabs && dispatchMode) {
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
      tileTabs,
      requiresWake,
    }
  }

  const existingGridSlot = findExistingGridViewSlot(state, target.sessionId)
  if (existingGridSlot) {
    const nextState = focusGridViewSlot(state, existingGridSlot, target.sessionId)
    if (!tileTabs) {
      return {
        kind: 'focus-grid-pane',
        state: nextState,
        tileTabs,
        requiresWake,
      }
    }

    if (tileTabs.tabIds.includes(existingGridSlot.tabId)) {
      return {
        kind: 'focus-tiled-tab-pane',
        state: nextState,
        tileTabs: { ...tileTabs, focusedTabId: existingGridSlot.tabId },
        requiresWake,
      }
    }

    const focusedSlotIndex = tileTabs.tabIds.indexOf(tileTabs.focusedTabId)
    if (focusedSlotIndex < 0) return null
    const tabIds = tileTabs.tabIds.map((tabId, index) => (
      index === focusedSlotIndex ? existingGridSlot.tabId : tabId
    ))
    return {
      kind: 'replace-focused-tiled-tab',
      state: nextState,
      // A non-tiled tab already owns the target pane. Replacing only the
      // focused meta-tab is the view-slot equivalent of switching the single
      // active tab: it reveals the existing pane without moving its session or
      // disturbing the other tiled tabs and their ratios.
      tileTabs: {
        ...tileTabs,
        tabIds,
        focusedTabId: existingGridSlot.tabId,
      },
      requiresWake,
    }
  }

  const detached = state.detachedSessions[target.sessionId]
  if (!detached) return null
  const destinationTabId = tileTabs?.focusedTabId ?? state.activeTabId
  const destinationTab = state.tabs.find(tab => tab.id === destinationTabId)
  if (!destinationTab) return null
  const destinationLeaves = collectLeaves(destinationTab.root)
  const displacedSessionId = destinationLeaves.includes(destinationTab.focusedSessionId)
    ? destinationTab.focusedSessionId
    : destinationLeaves[0]
  if (!displacedSessionId) return null

  const idMap = new Map<SessionId, SessionId>([
    [displacedSessionId, target.sessionId],
  ])
  const detachedSessions = { ...state.detachedSessions }
  delete detachedSessions[target.sessionId]
  // WHY the displaced session inherits the target's exact detached record:
  // this operation is a placement swap, not "attach target, then append the
  // old pane somewhere." Reusing detachedAt and project ownership preserves
  // the vacated visible coordinate, leaves every other detached row in place,
  // and gives a cross-project displaced agent the slot the target actually
  // vacated. Appending with Date.now() silently renumbered unrelated agents.
  detachedSessions[displacedSessionId] = {
    ...detached,
    sessionId: displacedSessionId,
  }

  const gridRelatedSelections = Object.fromEntries(
    Object.entries(state.gridRelatedSelections ?? {}).filter(
      ([ownerSessionId, selectedSessionId]) => (
        ownerSessionId !== displacedSessionId &&
        selectedSessionId !== target.sessionId
      ),
    ),
  )

  return {
    kind: 'swap-detached-into-focused-grid-pane',
    state: {
      ...state,
      activeTabId: destinationTabId,
      detachedSessions,
      gridRelatedSelections,
      tabs: state.tabs.map(tab => (
        tab.id === destinationTabId
          ? {
              ...tab,
              // Remapping the one leaf preserves every split node and ratio.
              // Closing + reinserting would reshape the user's grid and make
              // a navigation shortcut behave like a layout command.
              root: remapTileTreeSessionIds(tab.root, idMap),
              focusedSessionId: target.sessionId,
            }
          : tab
      )),
    },
    tileTabs,
    requiresWake: true,
  }
}

function findExistingGridViewSlot(
  state: WorkspaceState,
  targetSessionId: SessionId,
): GridViewSlot | null {
  for (const tab of state.tabs) {
    for (const ownerSessionId of collectLeaves(tab.root)) {
      // A physical owner still counts as the target's existing slot even when
      // its related-agent mini-tab currently shows a child. Focusing A2 should
      // select A2 in its own pane, not detach A2 and move it somewhere else.
      if (ownerSessionId === targetSessionId) {
        return { tabId: tab.id, ownerSessionId }
      }
      if (
        selectedGridRelatedSessionId(state, tab.id, ownerSessionId) ===
        targetSessionId
      ) {
        return { tabId: tab.id, ownerSessionId }
      }
    }
  }
  return null
}

function focusGridViewSlot(
  state: WorkspaceState,
  slot: GridViewSlot,
  targetSessionId: SessionId,
): WorkspaceState {
  const gridRelatedSelections = { ...(state.gridRelatedSelections ?? {}) }
  if (slot.ownerSessionId === targetSessionId) {
    delete gridRelatedSelections[slot.ownerSessionId]
  } else {
    gridRelatedSelections[slot.ownerSessionId] = targetSessionId
  }

  return {
    ...state,
    activeTabId: slot.tabId,
    gridRelatedSelections,
    tabs: state.tabs.map(tab => (
      tab.id === slot.tabId
        ? { ...tab, focusedSessionId: slot.ownerSessionId }
        : tab
    )),
  }
}
