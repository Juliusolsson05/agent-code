import { useCallback } from 'react'

import type {
  SessionId,
  SessionKind,
  SessionMeta,
  Tab,
  TabId,
  TileNode,
} from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { reinsertPane } from '@renderer/lib/undoClose'

import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

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
  state: { tabs: Tab[] },
  setState: WorkspaceSetState,
  refs: WorkspaceRefs,
  sessionActions: SessionActions,
): {
  undoClose: () => Promise<void>
  undoCloseCount: number
} {
  const undoClose = useCallback(async () => {
    const entry = refs.undoStackRef.current.pop()
    if (!entry) return

    if (entry.type === 'pane') {
      // Find which tab the sibling leaf is in now.
      const targetTab = state.tabs.find(t =>
        collectLeaves(t.root).includes(entry.siblingLeafId),
      )
      if (!targetTab) return // sibling was also closed — stale undo

      // Respawn the session.
      //   - Claude/Codex with providerSessionId → pass --resume so
      //     the conversation history replays via JSONL.
      //   - Terminal with tmuxName → pass recoverTmuxName so the
      //     same tmux session is re-attached, preserving scrollback
      //     and any running process. Without this, "undo close" on
      //     a terminal would respawn an empty shell — defeating the
      //     point of having a tmux backing.
      const meta = entry.sessionMeta
      const newSessionId = await sessionActions.spawn(meta.cwd, {
        kind: meta.kind ?? 'claude',
        resumeSessionId: meta.providerSessionId,
        recoverTmuxName: meta.kind === 'terminal' ? meta.tmuxName : undefined,
      })

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
          return {
            ...t,
            root: newRoot,
            focusedSessionId: newSessionId,
          }
        })
        return { ...prev, tabs }
      })
    } else {
      // Tab undo: respawn every session and remap the tree.
      const idMap = new Map<SessionId, SessionId>()
      const freshSessions: Record<SessionId, SessionMeta> = {}

      for (const [oldId, meta] of Object.entries(entry.sessionMetas)) {
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
        } catch {
          // If one session fails to spawn, skip it — restore what
          // we can.
        }
      }

      if (idMap.size === 0) return // nothing survived

      const remapNode = (n: TileNode): TileNode => {
        if (n.type === 'leaf') {
          const mapped = idMap.get(n.sessionId)
          return mapped ? { type: 'leaf', sessionId: mapped } : n
        }
        return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
      }

      const restoredRoot = remapNode(entry.tab.root)
      const leaves = collectLeaves(restoredRoot)
      if (leaves.length === 0) return

      const restoredFocused =
        idMap.get(entry.tab.focusedSessionId) ?? leaves[0]
      const restoredTab: Tab = {
        id: crypto.randomUUID(),
        title: entry.tab.title,
        root: restoredRoot,
        focusedSessionId: restoredFocused,
      }

      setState(prev => {
        const insertIdx = Math.min(entry.tabIndex, prev.tabs.length)
        const tabs = [...prev.tabs]
        tabs.splice(insertIdx, 0, restoredTab)
        return {
          ...prev,
          tabs,
          activeTabId: restoredTab.id,
        }
      })
    }
  }, [refs.undoStackRef, sessionActions, setState, state.tabs])

  // Peek at the undo stack length — used by the command palette to
  // show/hide the "Undo Close" command.
  const undoCloseCount = refs.undoStackRef.current.length

  // Silence TabId unused import.
  void (null as unknown as TabId)

  return { undoClose, undoCloseCount }
}
