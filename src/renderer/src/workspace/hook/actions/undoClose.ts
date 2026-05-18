import { useCallback, useState } from 'react'

import type {
  DetachedSessionRecord,
  SessionId,
  SessionKind,
  SessionMeta,
  Tab,
  TabId,
  TileNode,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { missingClosedTabLeafMetaIds, reinsertPane } from '@renderer/lib/undoClose'
import type { ClosedPane, ClosedTab } from '@renderer/lib/undoClose'

import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

type RestoreResult = 'restored' | 'stale' | 'retryable-failure'

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
          kind: meta.kind ?? 'claude',
          resumeSessionId: meta.providerSessionId,
          recoverTmuxName: meta.kind === 'terminal' ? meta.tmuxName : undefined,
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
        return { ...prev, tabs }
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
      const freshSessions: Record<SessionId, SessionMeta> = {}
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
          const kind: SessionKind = meta.kind ?? 'claude'
          // Same per-kind recover hint as the pane-undo branch
          // above: tmuxName for terminals, providerSessionId for
          // agents.
          const newId = await sessionActions.spawn(meta.cwd, {
            kind,
            resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
          })
          idMap.set(oldId, newId)
          freshSessions[newId] = meta
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

      const remapNode = (n: TileNode): TileNode => {
        if (n.type === 'leaf') {
          const mapped = idMap.get(n.sessionId)
          // requiredLeafIds are spawned all-or-nothing above, so an unmapped
          // leaf here means a corrupt undo entry rather than a recoverable
          // partial restore. Keep the branch explicit to preserve that
          // invariant for future edits.
          return { type: 'leaf', sessionId: mapped ?? n.sessionId }
        }
        return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
      }

      const restoredRoot = remapNode(entry.tab.root)
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
      // state.sessions itself, so we only need to track DetachedSessionRecord
      // entries here; the metas land in state.sessions through the spawn
      // call's own setState, before our setState below runs.
      const restoredDetached: Record<SessionId, DetachedSessionRecord> = {}
      for (const detached of entry.detachedEntries ?? []) {
        try {
          const kind: SessionKind = detached.meta.kind ?? 'claude'
          // Detached agents are never terminals in the current model
          // (createDetachedDispatchAgent rejects 'terminal'), but we
          // still gate the recover hint on kind for symmetry with the
          // tile-tree loop above and so a future surface that allows
          // detached terminals doesn't silently drop tmuxName.
          const newId = await sessionActions.spawn(detached.meta.cwd, {
            kind,
            resumeSessionId: kind !== 'terminal' ? detached.meta.providerSessionId : undefined,
            recoverTmuxName: kind === 'terminal' ? detached.meta.tmuxName : undefined,
          })
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
        return {
          ...prev,
          tabs,
          activeTabId: restoredTab.id,
          detachedSessions: { ...prev.detachedSessions, ...restoredDetached },
        }
      })
      return 'restored'
    },
    [sessionActions, setState],
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
  }, [bumpUndoCloseVersion, refs.undoStackRef, restorePaneEntry, restoreTabEntry])

  // Peek at the undo stack length — used by the command palette to
  // show/hide the "Undo Close" command.
  const undoCloseCount = refs.undoStackRef.current.length

  return { undoClose, undoCloseCount }
}
