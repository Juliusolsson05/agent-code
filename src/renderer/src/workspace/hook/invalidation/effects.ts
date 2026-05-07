import { useEffect } from 'react'

import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'
import type { SessionId, Tab, TabId, WorkspaceState } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  buildDispatchGroups,
  flattenDispatchRows,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  assistantUuidsWithText,
} from '@renderer/lib/copyAssistant'
import { ratiosEqual, sanitizeTileTabsState } from '@renderer/workspace/layout/helpers'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'

// Invalidation effects — these fire when state changes and adjust
// orthogonal slices so they stay consistent with the tile tree.
//
// Without these, stale slice values linger and produce subtle bugs:
//   - Spotlight mode pointing at a tab that was closed.
//   - Reader mode pointing at a session whose tree slot was burned
//     down.
//   - Copy-assistant picker holding a uuid that was cleared from
//     entries (conversation reset, etc.).
//   - Tile-tabs pointing at tabIds that no longer exist.

export function useSpotlightSanity(
  spotlight: SpotlightState | null,
  state: WorkspaceState,
  setSpotlight: WorkspaceSetSpotlight,
): void {
  useEffect(() => {
    if (!spotlight) return
    const validSessionIds = validFocusSessionIdsForMode(state, spotlight.tabId)
    if (!validSessionIds) {
      setSpotlight(null)
      return
    }
    if (validSessionIds.length === 0) {
      setSpotlight(null)
      return
    }
    if (!validSessionIds.includes(spotlight.focusedSessionId)) {
      setSpotlight(prev => (prev ? { ...prev, focusedSessionId: validSessionIds[0] } : prev))
    }
  }, [setSpotlight, spotlight, state])
}

// Same invalidation rule for ReaderMode — if the tab disappears or
// its leaves change so the focused session no longer exists, drop
// out of Reader cleanly. Without this, closing the last pane in the
// tab while Reader is open would leave a dangling focused sessionId
// and a blank screen.
export function useReaderModeSanity(
  readerMode: ReaderModeState | null,
  state: WorkspaceState,
  setReaderMode: WorkspaceSetReaderMode,
): void {
  useEffect(() => {
    if (!readerMode) return
    const validSessionIds = validFocusSessionIdsForMode(state, readerMode.tabId)
    if (!validSessionIds) {
      setReaderMode(null)
      return
    }
    if (validSessionIds.length === 0) {
      setReaderMode(null)
      return
    }
    if (!validSessionIds.includes(readerMode.focusedSessionId)) {
      setReaderMode(prev => (prev ? { ...prev, focusedSessionId: validSessionIds[0] } : prev))
    }
  }, [readerMode, setReaderMode, state])
}

function validFocusSessionIdsForMode(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] | null {
  const tab = state.tabs.find(t => t.id === tabId)
  if (!tab) return null

  // Reader/Spotlight sanity used to validate only tile-tree leaves. That is
  // correct in the normal grid, but wrong in Dispatch: detached agents are
  // intentionally outside `tab.root` and still must be legal reader/spotlight
  // targets. Reusing the Dispatch row builder keeps this invariant tied to the
  // same scoped, terminal-filtered list the user can actually see and select.
  if (state.dispatchMode) {
    return flattenDispatchRows(buildDispatchGroups(state))
      .filter(row => row.tabId === tabId)
      .map(row => row.sessionId)
  }

  return collectLeaves(tab.root)
}

// Picker invalidation. If the selected uuid is no longer present in
// a session's entries (entries cleared, conversation reset, etc.),
// cancel the picker. Without this the outline silently disappears
// (matching DOM node is gone) but the picker state lingers and keeps
// capturing keystrokes.
export function usePickerSanity(
  runtimes: Record<SessionId, SessionRuntime>,
  pickerCancel: (sessionId: SessionId) => void,
): void {
  useEffect(() => {
    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      if (!runtime.assistantPicker) continue
      const uuids = assistantUuidsWithText(runtime.entries)
      if (!uuids.includes(runtime.assistantPicker.selectedUuid)) {
        pickerCancel(sessionId)
      }
    }
  }, [pickerCancel, runtimes])
}

export function useTileTabsSanity(
  tileTabs: TileTabsState | null,
  tabs: Tab[],
  setTileTabs: WorkspaceSetTileTabs,
): void {
  useEffect(() => {
    if (!tileTabs) return
    const nextTileTabs = sanitizeTileTabsState(tileTabs)
    if (!nextTileTabs) {
      setTileTabs(null)
      return
    }
    const validTabIds = nextTileTabs.tabIds.filter(id => tabs.some(t => t.id === id))
    const sanitized = sanitizeTileTabsState({
      ...nextTileTabs,
      tabIds: validTabIds,
    })
    if (!sanitized) {
      setTileTabs(null)
      return
    }
    if (
      sanitized.tabIds.length !== tileTabs.tabIds.length ||
      sanitized.focusedTabId !== tileTabs.focusedTabId ||
      sanitized.direction !== tileTabs.direction ||
      !ratiosEqual(sanitized.ratios, tileTabs.ratios)
    ) {
      setTileTabs(sanitized)
    }
  }, [setTileTabs, tabs, tileTabs])
}
