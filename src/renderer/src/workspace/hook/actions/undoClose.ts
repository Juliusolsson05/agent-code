import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useCallback, useState } from 'react'

import type {
  DetachedSessionRecord,
  SessionId,
  SessionKind,
  SessionMeta,
  Tab,
  TabId,
} from '@renderer/workspace/types'
import { collectLeaves, remapTileTreeSessionIds } from '@renderer/workspace/tile-tree/treeOps'
import { remapTiledLanes } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { missingClosedTabLeafMetaIds, reinsertPane } from '@renderer/lib/undoClose'
import type { ClosedDetached, ClosedPane, ClosedTab } from '@renderer/lib/undoClose'

import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'

type RestoreResult = 'restored' | 'stale' | 'retryable-failure'

/**
 * The durable metadata a respawn cannot rebuild, carried onto the new session ID.
 *
 * WHY all three restore paths must share one answer: `sessionActions.spawn`
 * builds SessionMeta from {cwd, kind, providerRuntime, tmuxName,
 * providerSessionId, builtInMcpDomains} only (session.ts:339-345). Everything
 * else a session owned — its user-authored
 * title, its linked/orchestration parentage, its view-mode override, its
 * bootstrap-delivered flag and its `agentNameId` — exists nowhere but the meta
 * captured on the undo entry. Each path used to answer this differently:
 * `restoreDetachedEntry` had a hand-written allowlist, `restoreTabEntry` built
 * a `freshSessions` map that was populated and then never read (dead from the
 * day it was written), and `restorePaneEntry` patched no session metadata at
 * all. Three answers meant a field could survive one kind of undo and be lost
 * by another, which is not a difference any user could predict.
 *
 * WHY that is more than cosmetic for `agentNameId`: every one of these paths
 * RESUMES the same provider conversation, so the agent the user gets back is
 * the same agent. Dropping the identity makes the reconciler claim a fresh one
 * and the registry allocate a second name, so Cmd-Shift-T renames a live agent
 * and the old name is spent forever — allocation is monotonic and never
 * recycles. That is exactly the silent re-addressing #816 forbids.
 *
 * WHY each field is spread conditionally on top of the spawn's own meta rather
 * than the closed meta being copied wholesale: the respawn's values are the
 * current truth for the volatile fields. `providerSessionId`, `tmuxName` and
 * the freshly minted credentials all belong to the NEW backend, and copying
 * the closed meta over them would reinstate a dead provider session ID and a
 * stale tmux name on top of the live ones the respawn just established.
 *
 * The `spawned` fallback covers the case where the respawn's own registration
 * has not landed in this snapshot; production `spawn` writes SessionMeta into
 * workspace state itself, so in the app it is normally present.
 */
function carryDurableMeta(spawned: SessionMeta | undefined, closed: SessionMeta): SessionMeta {
  return {
    ...(spawned ?? { cwd: closed.cwd, kind: closed.kind ?? DEFAULT_PROVIDER }),
    ...(closed.title ? { title: closed.title } : {}),
    // The spoken address. Conditional like every other field here so an
    // unnamed agent (the setting off, or a name never allocated) is restored
    // without an empty identity that the reconciler would then have to heal.
    ...(closed.agentNameId ? { agentNameId: closed.agentNameId } : {}),
    ...(closed.linkedParentId ? { linkedParentId: closed.linkedParentId } : {}),
    ...(closed.orchestrationParentId ? { orchestrationParentId: closed.orchestrationParentId } : {}),
    ...(closed.orchestrationRootId ? { orchestrationRootId: closed.orchestrationRootId } : {}),
    ...(closed.orchestrationRunId ? { orchestrationRunId: closed.orchestrationRunId } : {}),
    ...(closed.orchestrationRole ? { orchestrationRole: closed.orchestrationRole } : {}),
    ...(closed.agentViewModeOverride ? { agentViewModeOverride: closed.agentViewModeOverride } : {}),
    // Its own doc comment says this "must survive with the child". spawn never
    // sets it, so without carrying it an undone orchestration child would
    // re-run its bootstrap handoff.
    ...(closed.orchestrationBootstrapPromptDelivered ? { orchestrationBootstrapPromptDelivered: true } : {}),
  }
}

// Undo-close action. Pops the most recent entry from the undo stack
// and restores it.
//
// For panes: finds the surviving sibling in the current tree by its
// anchor leaf, re-wraps it in a split with the restored session on
// the correct side, and respawns the session (with --resume for
// Claude sessions so the conversation comes back).
//
// For tabs: respawns every session in the tab, remaps the session
// ids in the tree (since the new spawn produces new ids), and
// re-inserts the tab at its original index (clamped to bounds).
//
// For detached Dispatch rows: respawns the session and re-files its
// `detachedSessions` record. There is no tree work to do — the record IS the
// placement — so the only anchor that has to still exist is the project tab.

export function useUndoCloseAction(
  _state: { tabs: Tab[] },
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
  sessionActions: SessionActions,
): {
  undoClose: () => Promise<void>
  undoCloseCount: number
} {
  const [, bumpUndoCloseVersion] = useState(0)

  const restorePaneEntry = useCallback(
    async (entry: ClosedPane): Promise<RestoreResult> => {
      // Find which tab the sibling leaf is in now.
      const targetTab = refs.stateRef.current.tabs.find(t =>
        collectLeaves(t.root).includes(entry.siblingLeafId),
      )
      if (!targetTab) return 'stale' // sibling was also closed — stale undo

      // Probe before spawning because a pane entry's only trustworthy
      // placement is its sibling anchor. If that anchor cannot produce
      // a new tree, spawning first would create a replacement session
      // with nowhere visible to attach it. We still re-run reinsert in
      // the state updater below because the tree can change between
      // this event handler and React applying the update; the probe is
      // the cheap guard that handles the normal stale-entry case.
      const probeRoot = reinsertPane(
        targetTab.root,
        entry.siblingLeafId,
        '__undo_close_probe__' as SessionId,
        entry.direction,
        entry.ratio,
        entry.side,
      )
      if (!probeRoot) return 'stale'

      // Respawn the session.
      //   - Claude/Codex with providerSessionId → pass --resume so
      //     the conversation history replays via JSONL.
      //   - Terminal with tmuxName → pass recoverTmuxName so the
      //     same tmux session is re-attached, preserving scrollback
      //     and any running process. Without this, "undo close" on
      //     a terminal would respawn an empty shell — defeating the
      //     point of having a tmux backing.
      const meta = entry.sessionMeta
      let newSessionId: SessionId
      try {
        newSessionId = await sessionActions.spawn(meta.cwd, {
          kind: meta.kind ?? DEFAULT_PROVIDER,
          ...(meta.providerRuntime ? { providerRuntime: meta.providerRuntime } : {}),
          resumeSessionId: resumableProviderSessionId(meta),
          recoverTmuxName: meta.kind === 'terminal' ? meta.tmuxName : undefined,
          // WHY capability intent is restored but credentials are not: closing a pane revokes its
          // session token. Undo must ask main to mint a fresh token from these durable domain names;
          // dropping them makes an undo-restored transcript silently lose tools after restart.
          tldrIdentity: meta.tldrIdentity,
          builtInMcpDomains: meta.builtInMcpDomains,
        })
      } catch {
        return 'retryable-failure'
      }

      let inserted = false
      setState(prev => {
        const tabs = prev.tabs.map(t => {
          if (t.id !== targetTab.id) return t
          const newRoot = reinsertPane(
            t.root,
            entry.siblingLeafId,
            newSessionId,
            entry.direction,
            entry.ratio,
            entry.side,
          )
          if (!newRoot) return t // anchor not found — bail
          inserted = true
          return {
            ...t,
            root: newRoot,
            focusedSessionId: newSessionId,
          }
        })
        // Only patch metadata for a placement that actually happened: the
        // `!inserted` branch below kills the session, and writing durable
        // fields for an id we are about to remove would leave the workspace
        // describing an agent nothing points at.
        if (!inserted) return { ...prev, tabs }
        return {
          ...prev,
          tabs,
          // This path used to touch `tabs` and nothing else, so a restored
          // pane came back with only what `spawn` could rebuild — losing its
          // title and, once names existed, its spoken identity. See
          // carryDurableMeta for why that re-addresses a live agent.
          sessions: {
            ...prev.sessions,
            [newSessionId]: carryDurableMeta(prev.sessions[newSessionId], meta),
          },
        }
      })

      if (!inserted) {
        // WHY we kill the just-spawned session here:
        //
        // The preflight probe above catches the normal stale-anchor case, but
        // React/Zustand state can still change between the probe and the
        // updater. If the anchor vanishes in that window, the session was
        // successfully created but has no visible tile-tree owner. Leaving it
        // alive would produce a hidden process that cannot be focused or
        // closed from the UI, so failed insertion must undo the spawn before
        // the undo loop walks to older entries.
        await sessionActions.killSession(newSessionId).catch(() => undefined)
        return 'stale'
      }

      return 'restored'
    },
    [refs.stateRef, sessionActions, setState],
  )

  const restoreTabEntry = useCallback(
    async (entry: ClosedTab): Promise<RestoreResult> => {
      // Tab undo: respawn every session and remap the tree.
      const idMap = new Map<SessionId, SessionId>()
      // New session ID → the meta the closed session actually had, for both
      // the tile-tree loop and the detached loop below. Applied through
      // carryDurableMeta in the commit at the end.
      //
      // This REPLACES a `freshSessions: Record<SessionId, SessionMeta>` that
      // was populated here and never read by anything — so a tab undo lost the
      // same durable fields the pane undo did, and the map that looked like it
      // was preventing that was dead code.
      const carried = new Map<SessionId, SessionMeta>()
      const spawnedIds: SessionId[] = []
      const requiredLeafIds = collectLeaves(entry.tab.root)
      if (missingClosedTabLeafMetaIds(entry).length > 0) {
        return 'stale'
      }

      for (const oldId of requiredLeafIds) {
        const meta = entry.sessionMetas[oldId]
        if (!meta) {
          return 'stale'
        }
        try {
          const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER
          // Same per-kind recover hint as the pane-undo branch
          // above: tmuxName for terminals, providerSessionId for
          // agents.
          const newId = await sessionActions.spawn(meta.cwd, {
            kind,
            ...(meta.providerRuntime ? { providerRuntime: meta.providerRuntime } : {}),
            resumeSessionId: kind !== 'terminal' ? resumableProviderSessionId(meta) : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
            tldrIdentity: meta.tldrIdentity,
            builtInMcpDomains: meta.builtInMcpDomains,
          })
          idMap.set(oldId, newId)
          carried.set(newId, meta)
          spawnedIds.push(newId)
        } catch {
          // WHY grid leaves are all-or-nothing while detached entries below
          // remain best-effort:
          //
          // A tab's tile tree cannot contain missing leaves. Leaving an old
          // session id in the restored tree creates a phantom pane with no
          // runtime, which is worse than not restoring. Detached dispatch
          // sessions are outside the tree, so they can still be restored
          // opportunistically after the tab itself is valid.
          for (const spawnedId of spawnedIds) {
            await sessionActions.killSession(spawnedId).catch(() => undefined)
          }
          return 'retryable-failure'
        }
      }

      if (idMap.size === 0) return 'retryable-failure' // nothing survived

      const restoredRoot = remapTileTreeSessionIds(entry.tab.root, idMap)
      const leaves = collectLeaves(restoredRoot)
      if (leaves.length === 0) return 'retryable-failure'

      const restoredFocused =
        idMap.get(entry.tab.focusedSessionId) ?? leaves[0]
      const restoredTab: Tab = {
        id: crypto.randomUUID(),
        title: entry.tab.title,
        root: restoredRoot,
        focusedSessionId: restoredFocused,
      }

      // Re-spawn any detached dispatch agents that were associated
      // with this tab at close time. Done AFTER the tile-tree spawn
      // loop so the restored tab id is already known — DetachedSessionRecord
      // carries projectTabId, which has to point at the NEW tab id
      // (the old one is gone). Failed spawns are skipped for the same
      // reason as the tile-tree loop above: restore what we can.
      //
      // Note: sessionActions.spawn registers SessionMeta into
      // state.sessions itself, so the metas land there through the spawn
      // call's own setState, before our setState below runs. What it CANNOT
      // rebuild is tracked in `carried` and re-applied over the top — see
      // carryDurableMeta.
      const restoredDetached: Record<SessionId, DetachedSessionRecord> = {}
      for (const detached of entry.detachedEntries ?? []) {
        try {
          const kind: SessionKind = detached.meta.kind ?? DEFAULT_PROVIDER
          // Detached dispatch sessions CAN be terminals: Dispatch terminal
          // creation files a detached row like any other kind (#671), and
          // `detachFocusedToDispatch` has always allowed a grid terminal to be
          // parked in Dispatch. Gating the recover hint on kind is what lets a
          // restored terminal re-attach its tmux session instead of coming back
          // as a fresh shell with the user's scrollback gone.
          const newId = await sessionActions.spawn(detached.meta.cwd, {
            kind,
            ...(detached.meta.providerRuntime
              ? { providerRuntime: detached.meta.providerRuntime }
              : {}),
            resumeSessionId: kind !== 'terminal'
              ? resumableProviderSessionId(detached.meta)
              : undefined,
            recoverTmuxName: kind === 'terminal' ? detached.meta.tmuxName : undefined,
            tldrIdentity: detached.meta.tldrIdentity,
            builtInMcpDomains: detached.meta.builtInMcpDomains,
          })
          // A detached child restored with its tab is the same population
          // restoreDetachedEntry covers on its own, so it gets the same
          // durable metadata; the two routes back to one row must not
          // disagree about whether the agent keeps its name.
          carried.set(newId, detached.meta)
          restoredDetached[newId] = {
            sessionId: newId,
            surface: 'dispatch',
            projectTabId: restoredTab.id,
            projectTabTitle: restoredTab.title,
            // projectTabIndex is a display ordinal recomputed at render
            // time by buildDispatchGroups (state.tabs.findIndex(...)),
            // so any value here gets overwritten on next render. Use
            // entry.tabIndex as the seed; it's correct as long as no
            // other tabs were inserted before our splice index.
            projectTabIndex: entry.tabIndex,
            // Preserve the original detachedAt so the dispatch row's age
            // display (e.g. "4h" since detached) doesn't snap back to
            // "just now" on undo.
            detachedAt: detached.detachedAt,
          }
        } catch {
          // Same restore-what-we-can policy as the tile-tree spawn loop above.
        }
      }

      setState(prev => {
        const insertIdx = Math.min(entry.tabIndex, prev.tabs.length)
        const tabs = [...prev.tabs]
        tabs.splice(insertIdx, 0, restoredTab)
        const sessions = { ...prev.sessions }
        for (const [newId, closed] of carried) {
          sessions[newId] = carryDurableMeta(sessions[newId], closed)
        }
        return {
          ...prev,
          tabs,
          sessions,
          activeTabId: restoredTab.id,
          detachedSessions: { ...prev.detachedSessions, ...restoredDetached },
          // Restored sessions get fresh ids (idMap); remap any tiled lane that
          // pointed at the closed tab's sessions so the lane follows the
          // restored agent instead of dangling at a dead id.
          dispatchMode: remapTiledLanes(prev.dispatchMode, idMap),
        }
      })
      return 'restored'
    },
    [sessionActions, setState],
  )

  const restoreDetachedEntry = useCallback(
    async (entry: ClosedDetached): Promise<RestoreResult> => {
      // The project tab is a detached row's only anchor. `buildDispatchGroups`
      // walks `state.tabs` and files each detached record under its
      // `projectTabId`, so a record whose tab is gone renders in no group at
      // all — restoring it would spawn a live backend the user can never see
      // or close. Treat that as stale, the same judgement restorePaneEntry
      // makes when its sibling anchor is gone.
      //
      // We deliberately do NOT re-home the row into some surviving tab: the
      // tab-close undo path already restores detached children as part of
      // restoring their tab, so a missing tab here means the user closed the
      // project itself and undoing THAT is the correct recovery.
      const targetTab = refs.stateRef.current.tabs.find(
        tab => tab.id === entry.record.projectTabId,
      )
      if (!targetTab) return 'stale'

      const meta = entry.sessionMeta
      const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER
      let newSessionId: SessionId
      try {
        // Same respawn contract as restorePaneEntry: --resume for an agent with
        // a durable transcript, `recoverTmuxName` for a terminal so the still
        // alive tmux session is re-attached rather than replaced by an empty
        // shell. The latter is the whole reason this entry type exists.
        newSessionId = await sessionActions.spawn(meta.cwd, {
          kind,
          ...(meta.providerRuntime ? { providerRuntime: meta.providerRuntime } : {}),
          resumeSessionId: kind !== 'terminal'
            ? resumableProviderSessionId(meta)
            : undefined,
          recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
          tldrIdentity: meta.tldrIdentity,
          builtInMcpDomains: meta.builtInMcpDomains,
        })
      } catch {
        return 'retryable-failure'
      }

      // Set inside the updater and read after. Sound because setState is the
      // zustand store setter, which applies updaters synchronously — NOT a
      // React useState setter, whose updater would still be pending here.
      // Deliberately not a `refs.stateRef` read: that ref only refreshes on a
      // React render, so it can lag an awaited continuation and would report a
      // successful restore as a failure, killing the session we just revived.
      let refiled = false
      setState(prev => {
        // Re-check inside the updater: the tab can be closed between the
        // awaited spawn and here. Returning `prev` unchanged would strand the
        // session, so fall through to the kill below instead.
        const tabIndex = prev.tabs.findIndex(tab => tab.id === entry.record.projectTabId)
        if (tabIndex < 0) return prev
        refiled = true
        return {
          ...prev,
          // Every other path that files a detached row makes its tab active in
          // the same updater — splitFocused's Dispatch branch,
          // createDetachedDispatchAgent, and restoreTabEntry above — because
          // buildDispatchGroups filters `sourceTabs` to `activeTabId` outside
          // global scope. Without this, undoing a row that belongs to a
          // different project tab spawns a live backend that renders NOWHERE:
          // the row is filed correctly but filtered out of the list, and
          // ClassicDispatchLayout's focus effect immediately overwrites the
          // focus we set below with whatever row is actually visible. There is
          // no toast on this path, so the user sees undo do nothing while an
          // agent (or a re-attached tmux session) runs invisibly.
          activeTabId: entry.record.projectTabId,
          // The fields that make a session a LINKED or ORCHESTRATION child —
          // and any user-authored title, and its spoken identity — are durable
          // metadata `spawn` never sees. Those children are always detached, so
          // they are precisely the population this undo path covers: without
          // this patch an undone linked child returns un-nested
          // (buildDispatchGroups reads `linkedParentId` to indent it) and stops
          // cascading when its parent closes, and a titled row silently
          // relabels to its cwd basename. This used to be a hand-written
          // allowlist here; it is now the shared carryDurableMeta, so the pane
          // and tab undo paths cannot drift from it again.
          sessions: {
            ...prev.sessions,
            [newSessionId]: carryDurableMeta(prev.sessions[newSessionId], meta),
          },
          detachedSessions: {
            ...prev.detachedSessions,
            [newSessionId]: {
              ...entry.record,
              // The spawn minted a new local id; everything else about the
              // record — project affinity and, critically, `detachedAt` —
              // is restored verbatim so the row returns to its old position
              // in the Dispatch list rather than jumping to the bottom.
              sessionId: newSessionId,
              // projectTabIndex is a display ordinal recomputed on render;
              // refresh it so a record read before the next render is not
              // stale if tabs moved while the entry sat on the stack.
              projectTabIndex: tabIndex,
            },
          },
          // Focus the restored row when Dispatch is up. NOTE this is the
          // classic focus only: in Tiled Dispatch `dispatchFocusedSessionId`
          // reads the focused LANE first, and the close already cleared that
          // lane (dispatchModeAfterSessionRemoval) and the heal effect refilled
          // it with another agent. So the visible result there is the row
          // reappearing at its old position in the index, not a lane takeover.
          // Restoring the lane would need the lane index captured on the entry
          // at close time; deliberately not done, because a lane the user has
          // since re-aimed should not be yanked back by an undo.
          dispatchMode: prev.dispatchMode
            ? { ...prev.dispatchMode, focusedSessionId: newSessionId }
            : prev.dispatchMode,
        }
      })

      if (!refiled) {
        // Mirror restorePaneEntry's bail: the spawn already registered a live
        // backend, so a placement that did not happen must not leave it
        // running with no row pointing at it.
        //
        // Kill with the kind/cwd resolved above rather than leaving it to
        // killSession's ownership proof, which re-reads them from
        // `refs.stateRef`. That ref is a RENDER-BODY mirror, so immediately
        // after an awaited spawn it does not yet contain the new session and
        // the proof fails — meaning the kill would silently no-op and strand
        // exactly the backend this bail exists to reclaim. killSession still
        // runs for the renderer-side cleanup.
        await window.api
          .killOwnedSession({ sessionId: newSessionId, kind, cwd: meta.cwd })
          .catch(() => undefined)
        // `.catch` mirrors restorePaneEntry's guard. killSession reaches an IPC
        // invoke that can reject, and this bail runs with the entry already
        // POPPED — a throw here would lose the entry (the push-back only
        // happens for 'retryable-failure'), skip bumpUndoCloseVersion so the
        // palette's count stays stale, and escape into the keybinding handler.
        await sessionActions.killSession(newSessionId).catch(() => undefined)
        return 'stale'
      }
      return 'restored'
    },
    [refs.stateRef, sessionActions, setState],
  )

  const undoClose = useCallback(async () => {
    // Undo Close is a small LIFO recovery history, not a one-shot
    // toast action. Pane entries can go stale during normal cleanup
    // because their only safe placement anchor is the surviving sibling
    // leaf; if that sibling was also closed, the entry is no longer
    // restorable in-place. We deliberately skip such entries and keep
    // walking backward so one stale close does not block an older valid
    // tab/pane restore. We still pop stale entries because retaining
    // an entry we already know cannot restore would trap the user on
    // the same failure every time they press Cmd+Shift+T. Transient spawn
    // failures are different: those keep the entry by pushing it back so a
    // provider hiccup does not permanently consume the user's recovery slot.
    let staleEntryConsumed = false
    while (true) {
      const entry = refs.undoStackRef.current.pop()
      if (!entry) {
        if (staleEntryConsumed) {
          bumpUndoCloseVersion(version => version + 1)
        }
        return
      }
      const result = entry.type === 'pane'
        ? await restorePaneEntry(entry)
        : entry.type === 'detached'
          ? await restoreDetachedEntry(entry)
          : await restoreTabEntry(entry)
      if (result === 'restored') return
      if (result === 'retryable-failure') {
        refs.undoStackRef.current.push(entry)
        if (staleEntryConsumed) {
          bumpUndoCloseVersion(version => version + 1)
        }
        return
      }
      staleEntryConsumed = true
    }
  }, [bumpUndoCloseVersion, refs.undoStackRef, restoreDetachedEntry, restorePaneEntry, restoreTabEntry])

  // Peek at the undo stack length — used by the command palette to
  // show/hide the "Undo Close" command.
  const undoCloseCount = refs.undoStackRef.current.length

  return { undoClose, undoCloseCount }
}
