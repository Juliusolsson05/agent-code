import { useCallback } from 'react'

import type { DetachedSessionRecord, SessionId, SessionKind, SessionMeta, Tab, TabId, WorkspaceState } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  expandTabCloseTargets,
  runCloseConfirmationGate,
} from '@renderer/workspace/closeConfirmation'
import { requestCloseConfirmation } from '@renderer/workspace/closeConfirmationBroker'
import { clearLiveEntryWindowSession } from '@renderer/session-runtime/liveEntryWindow'
import { titleFromCwd } from '@renderer/workspace/layout/helpers'
import { clearRemovedTabTakeovers, workspaceWithoutTab } from '@renderer/workspace/hook/actions/tabRemoval'
import { mergeProjectTabs, retargetTileTabsAfterMerge } from '@renderer/workspace/mergeProjectTabs'
import type { MergeProjectTabsResult } from '@renderer/workspace/mergeProjectTabs'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'

import type {
  WorkspaceSetReaderMode,
  WorkspaceSetRuntimes,
  WorkspaceSetSpotlight,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

// Tab actions — open/close + tab-navigation keybinds.

export function useTabActions(
  state: {
    activeTabId: string
    detachedSessions: Record<SessionId, DetachedSessionRecord>
    sessions: Record<SessionId, SessionMeta>
    tabs: Tab[]
  },
  tileTabs: { tabIds: TabId[]; focusedTabId: TabId } | null,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  setSpotlight: WorkspaceSetSpotlight,
  setReaderMode: WorkspaceSetReaderMode,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  sessionActions: SessionActions,
): {
  newTab: (cwd: string, resumeSessionId?: string, kind?: SessionKind) => Promise<{ tabId: TabId; sessionId: SessionId }>
  closeTab: (tabId: TabId) => Promise<void>
  activateTab: (tabId: TabId) => void
  activateTabByIndex: (index: number) => void
  reorderTabs: (tabIds: TabId[]) => void
  /** Fold `sourceTabIds` into `targetTabId` without touching any process (#913). */
  mergeTabs: (targetTabId: TabId, sourceTabIds: TabId[]) => MergeProjectTabsResult
  nextTab: () => void
  prevTab: () => void
} {
  // Spawns a new session in the given cwd, creates a tab with one
  // leaf, and makes it active. Pass `resumeSessionId` to resume an
  // existing CC session rather than starting a fresh one.
  const newTab = useCallback(
    async (cwd: string, resumeSessionId?: string, kind?: SessionKind) => {
      let sessionId: SessionId
      try {
        sessionId = await sessionActions.spawn(cwd, { resumeSessionId, kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create session',
        )
        throw err
      }
      const tabId = crypto.randomUUID()
      const title = titleFromCwd(cwd)
      setState(prev => {
        const tab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId },
          focusedSessionId: sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, tab],
          activeTabId: tabId,
        }
      })
      return { tabId, sessionId }
    },
    [sessionActions, setState, showToast],
  )

  // Enumerate everything closing `tabId` will end, from a given snapshot.
  //
  // Both the gate and the kill list derive from this ONE function, so they
  // cannot drift: the detached records that feed the undo entry are the same
  // records the dialog counted. Detached sessions are the ones people forget —
  // they have no tile in the tab on screen, so closing what looks like a
  // two-pane tab can end eight agents.
  const enumerateTabClose = useCallback((snapshot: WorkspaceState, tabId: TabId) => {
    const tab = snapshot.tabs.find(t => t.id === tabId)
    if (!tab) return null
    const detachedRecords = Object.values(snapshot.detachedSessions)
      .filter(entry => entry.projectTabId === tabId)
    return {
      tab,
      tabIdx: snapshot.tabs.findIndex(t => t.id === tabId),
      ids: collectLeaves(tab.root),
      detachedRecords,
      detachedIds: detachedRecords.map(entry => entry.sessionId),
    }
  }, [])

  const closeTab = useCallback(
    async (tabId: TabId) => {
      // CONFIRMATION GATE, before any kill.
      //
      // Reads through `stateRef`, not the `state` prop. The prop is the value
      // from the render that built this callback: already one render behind
      // when a burst of closes queues up, and definitively stale once the gate
      // has awaited a dialog. Every derivation below — the undo entry, the kill
      // list, the detached metas — came from that captured value, so a
      // confirmed tab close could resurrect sessions the intervening state had
      // already removed.
      const gate = await runCloseConfirmationGate({
        enumerate: () => {
          const snapshot = refs.stateRef.current
          const plan = enumerateTabClose(snapshot, tabId)
          if (!plan) return []
          return expandTabCloseTargets(
            snapshot,
            refs.latestRuntimesRef.current,
            plan.ids,
            plan.detachedIds,
          )
        },
        ask: requestCloseConfirmation,
      })
      if (!gate.ok) {
        if (gate.reason === 'changed') {
          showToast('Close cancelled — this tab changed while the dialog was open. Try again.')
        }
        return
      }

      // Re-read for the mutation itself. When nothing was prompted this is the
      // same snapshot the gate just enumerated from.
      const state = refs.stateRef.current
      const plan = enumerateTabClose(state, tabId)
      if (!plan) return
      const { tab, tabIdx, ids, detachedRecords, detachedIds } = plan

      const idsToKill = [...ids, ...detachedIds]
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const id of ids) {
        if (state.sessions[id]) allMetas[id] = state.sessions[id]
      }
      // Capture detached agents associated with this tab so undoClose
      // can re-spawn them. They DO get killed below as part of
      // idsToKill — without capturing their metas here, undo would
      // restore the tile-tree panes but silently drop every detached
      // dispatch agent the user had parked in this project. Skip
      // records whose SessionMeta is missing (defensive — an undo
      // entry that referenced a non-existent meta would throw at
      // restore time).
      const detachedEntries = detachedRecords
        .flatMap(entry => {
          const meta = state.sessions[entry.sessionId]
          if (!meta) return []
          // sessionId is the lineage anchor undo publishes when it restores
          // this row, so older entries naming it (and linked children restored
          // alongside) follow the respawned id — see UndoLineage.
          return [{ sessionId: entry.sessionId, meta, detachedAt: entry.detachedAt }]
        })
      refs.undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
        detachedEntries: detachedEntries.length > 0 ? detachedEntries : undefined,
      })
      // Surface a brief undo hint. The label uses the tab title so
      // the user can confirm at a glance which thing they killed.
      showToast(`Closed “${tab.title}” — ⌘⇧T Undo Close; repeat for earlier closes`)

      // Kill every session in this tab.
      await Promise.all(idsToKill.map(id => sessionActions.killSession(id)))
      setRuntimes(prev => {
        const next = { ...prev }
        for (const id of idsToKill) delete next[id]
        return next
      })
      for (const id of idsToKill) {
        delete refs.seenUuidsRef.current[id]
        // Live-window bookkeeping follows the seen-uuid lifecycle
        // (liveEntryWindow.ts).
        clearLiveEntryWindowSession(id)
        delete refs.latestScreenRef.current[id]
      }
      // The removal tail is shared with closeSession's emptied-tab branch, which
      // is what the root dialog's "Close Tab" button ends in. Same next-active
      // tab (previous neighbour), same Dispatch lane/focus cleanup, same
      // takeover cleanup — see tabRemoval.ts for why these had to converge.
      // `detachedIds` need no separate pass: the helper deletes both the
      // SessionMeta and any detached record for every removed id.
      setState(prev => workspaceWithoutTab(prev, tabId, idsToKill))
      clearRemovedTabTakeovers({ setTileTabs, setSpotlight, setReaderMode }, tabId)
    },
    // No `state.*` deps any more: this callback reads through refs, which is
    // the point. Depending on the state slices used to churn a new closure on
    // every workspace mutation while STILL capturing a stale value inside it —
    // the worst of both.
    [
      enumerateTabClose,
      refs.latestRuntimesRef,
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.stateRef,
      refs.undoStackRef,
      sessionActions,
      setReaderMode,
      setRuntimes,
      setSpotlight,
      setState,
      setTileTabs,
      showToast,
    ],
  )

  const activateTab = useCallback(
    (tabId: TabId) => {
      setState(prev => ({ ...prev, activeTabId: tabId }))
      setSpotlight(null)
      // Preserve tile-tabs mode when the activated tab is part of
      // the tiled set — just shift the focused tile. If it's NOT
      // part of the set, leave tile-tabs ALONE rather than nuking
      // the mode. The previous behavior (setting null) caused the
      // tile layout to silently collapse whenever the user clicked
      // any other tab in the bar, which read as a phantom
      // "auto-deselect."
      setTileTabs(prev => {
        if (!prev) return prev
        if (prev.tabIds.includes(tabId)) {
          return { ...prev, focusedTabId: tabId }
        }
        return prev
      })
    },
    [setSpotlight, setState, setTileTabs],
  )

  const activateTabByIndex = useCallback(
    (index: number) => {
      setState(prev => {
        const t = prev.tabs[index]
        return t ? { ...prev, activeTabId: t.id } : prev
      })
      setSpotlight(null)
      // Same preservation rule as activateTab — see comment there.
      setTileTabs(prev => {
        const target = refs.stateRef.current.tabs[index]
        if (!prev) return prev
        if (!target) return prev
        if (prev.tabIds.includes(target.id)) {
          return { ...prev, focusedTabId: target.id }
        }
        return prev
      })
    },
    [refs.stateRef, setSpotlight, setState, setTileTabs],
  )

  const mergeTabs = useCallback(
    (targetTabId: TabId, sourceTabIds: TabId[]): MergeProjectTabsResult => {
      // The plan is made INSIDE the updater against `prev`, never against
      // `refs.stateRef`, which is refreshed on render and can lag a workspace
      // mutation that landed between the modal's last paint and this click.
      // Reading the result back out of the updater is only sound because
      // `setState` is the zustand store setter, which applies the updater
      // synchronously (pane.ts relies on the same property). Every side
      // effect below is gated on that result: a refused merge must leave
      // tiled tabs, Spotlight, Reader and the toast exactly as they were,
      // otherwise the user is told "merged" while the tabs are still there.
      // No kill, no spawn, no runtime change: every session keeps its
      // process and its runtime; only tab affinity moves.
      const now = Date.now()
      // A holder object rather than a `let`: TypeScript keeps a `let`
      // narrowed to its initial value across the updater call (it cannot see
      // the closure assign), which would type the merged branch as `never`.
      const applied: { result: MergeProjectTabsResult | null } = { result: null }
      setState(prev => {
        const planned = mergeProjectTabs(prev, { targetTabId, sourceTabIds, now })
        applied.result = planned
        return planned.ok ? planned.state : prev
      })
      const result = applied.result ?? { ok: false as const, reason: 'nothing_to_merge' as const }
      if (!result.ok) {
        showToast(
          result.reason === 'target_is_source'
            ? 'Merge cancelled — the target tab cannot be one of the merged tabs.'
            : result.reason === 'unknown_tab'
              ? 'Merge cancelled — a tab changed while the dialog was open. Try again.'
              : 'Nothing to merge.',
        )
        return result
      }
      setTileTabs(prev => retargetTileTabsAfterMerge(prev, sourceTabIds, targetTabId))
      // Spotlight and Reader zoom a GRID pane of a tab; the pane they named
      // is now a Dispatch agent of another tab, so the takeover has nothing
      // to frame.
      const removed = new Set(sourceTabIds)
      setSpotlight(prev => (prev && removed.has(prev.tabId) ? null : prev))
      setReaderMode(prev => (prev && removed.has(prev.tabId) ? null : prev))
      const { summary } = result
      const moved = summary.detachedFromGrid.length + summary.repointedDetached.length
      showToast(
        `Merged ${summary.removedTabIds.length} tab${summary.removedTabIds.length === 1 ? '' : 's'} into `
        + `${tabIndexLabel(summary.targetIndex)} · ${summary.targetTitle} — `
        + `${moved} agent${moved === 1 ? '' : 's'} now in its Dispatch list`,
      )
      return result
    },
    [setReaderMode, setSpotlight, setState, setTileTabs, showToast],
  )

  const reorderTabs = useCallback(
    (tabIds: TabId[]) => {
      setState(prev => {
        // Reordering tabs is intentionally the smallest possible
        // workspace mutation: the user is changing the top chrome
        // order, not moving sessions, changing pane focus, or
        // touching any runtime. Validate that the modal gave us a
        // strict permutation before mutating so a stale modal opened
        // across tab-close/new-tab events cannot drop or duplicate a
        // project tab in WorkspaceState.
        if (tabIds.length !== prev.tabs.length) return prev
        const byId = new Map(prev.tabs.map(tab => [tab.id, tab]))
        const seen = new Set<TabId>()
        const tabs: Tab[] = []
        for (const id of tabIds) {
          const tab = byId.get(id)
          if (!tab || seen.has(id)) return prev
          seen.add(id)
          tabs.push(tab)
        }
        return { ...prev, tabs }
      })
    },
    [setState],
  )

  const nextTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId = tiled.tabIds[(idx + 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx + 1) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [setSpotlight, setState, setTileTabs, tileTabs])

  const prevTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId =
        tiled.tabIds[(idx - 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx - 1 + prev.tabs.length) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [setSpotlight, setState, setTileTabs, tileTabs])

  return {
    newTab,
    closeTab,
    activateTab,
    activateTabByIndex,
    reorderTabs,
    mergeTabs,
    nextTab,
    prevTab,
  }
}
