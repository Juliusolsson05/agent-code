import { useCallback, useRef } from 'react'

import type { DispatchModeState, SessionId, SessionMeta, TabId } from '@renderer/workspace/types'
import { collectLeaves, wrapRootWithLeaf } from '@renderer/workspace/tile-tree/treeOps'
import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'

export function useDispatchActions(
  state: { activeTabId: TabId; dispatchMode: DispatchModeState | null; sessions: Record<SessionId, SessionMeta> },
  setState: WorkspaceSetState,
  setTileTabs: WorkspaceSetTileTabs,
  refs: WorkspaceRefs,
  showToast: (message: string, durationMs?: number) => void,
  sessionActions: SessionActions,
): {
  enterDispatchMode: (scope?: DispatchModeState['scope']) => Promise<void>
  exitDispatchMode: () => void
  setDispatchScope: (scope: DispatchModeState['scope']) => Promise<void>
  toggleDispatchTerminal: () => Promise<void>
  ensureDispatchTerminal: (tabId?: TabId) => Promise<SessionId | null>
} {
  const pendingTerminalByTabRef = useRef(new Map<TabId, Promise<SessionId | null>>())

  const ensureDispatchTerminal = useCallback(
    async (tabId = refs.stateRef.current.activeTabId): Promise<SessionId | null> => {
      const snapshot = refs.stateRef.current
      const tab = snapshot.tabs.find(item => item.id === tabId)
      if (!tab) return null

      const leafIds = collectLeaves(tab.root)
      const existing = leafIds.find(id => snapshot.sessions[id]?.kind === 'terminal')
      if (existing) return existing

      const anchorId = tab.focusedSessionId
      const cwd = snapshot.sessions[anchorId]?.cwd
        ?? leafIds.map(id => snapshot.sessions[id]?.cwd).find(Boolean)
      if (!cwd) {
        showToast('Could not create dispatch terminal: no project directory found')
        return null
      }

      const pending = pendingTerminalByTabRef.current.get(tabId)
      if (pending) return pending

      const created = (async () => {
        const latest = refs.stateRef.current
        const latestTab = latest.tabs.find(item => item.id === tabId)
        const latestTerminal = latestTab
          ? collectLeaves(latestTab.root).find(id => latest.sessions[id]?.kind === 'terminal')
          : null
        if (latestTerminal) return latestTerminal

        let terminalId: SessionId
        try {
          terminalId = await sessionActions.spawn(cwd, { kind: 'terminal' })
        } catch (err) {
          showToast(
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Failed to create dispatch terminal',
          )
          return null
        }

        let inserted = false
        setState(prev => {
          const tabs = prev.tabs.map(currentTab => {
            if (currentTab.id !== tabId) return currentTab
            if (collectLeaves(currentTab.root).some(id => prev.sessions[id]?.kind === 'terminal')) {
              return currentTab
            }
            inserted = true
            // Dispatch renders the terminal outside the grid, but the
            // session still needs to be a normal leaf so existing lifetime,
            // tmux recovery, persistence, and IPC routing keep working.
            // Preserving focusedSessionId keeps terminal creation invisible
            // to the agent the user was actively commanding.
            return {
              ...currentTab,
              root: wrapRootWithLeaf(currentTab.root, 'vertical', 'b', terminalId),
              focusedSessionId: currentTab.focusedSessionId,
            }
          })
          return { ...prev, tabs }
        })
        if (!inserted) {
          // A terminal can appear after spawn but before the leaf insert
          // (for example from another caller using the normal split path).
          // `spawn()` already registered this terminal in state.sessions, so
          // leaving it unattached would leak both renderer state and a PTY.
          await sessionActions.killSession(terminalId)
          return findTerminalInLatestTab(refs, tabId)
        }
        return terminalId
      })().finally(() => {
        pendingTerminalByTabRef.current.delete(tabId)
      })
      pendingTerminalByTabRef.current.set(tabId, created)
      return created
    },
    [refs.stateRef, sessionActions, setState, showToast],
  )

  const enterDispatchMode = useCallback(
    async (scope: DispatchModeState['scope'] = state.dispatchMode?.scope ?? 'project') => {
      setState(prev => ({
        ...prev,
        dispatchMode: {
          scope,
          terminalVisible: prev.dispatchMode?.terminalVisible ?? true,
        },
      }))
      setTileTabs(null)
      await ensureDispatchTerminal()
    },
    [ensureDispatchTerminal, setState, setTileTabs, state.dispatchMode?.scope],
  )

  const exitDispatchMode = useCallback(() => {
    setState(prev => ({
      ...prev,
      dispatchMode: null,
    }))
  }, [setState])

  const setDispatchScope = useCallback(
    async (scope: DispatchModeState['scope']) => {
      setState(prev => ({
        ...prev,
        dispatchMode: {
          scope,
          terminalVisible: prev.dispatchMode?.terminalVisible ?? true,
        },
      }))
      await ensureDispatchTerminal()
    },
    [ensureDispatchTerminal, setState],
  )

  const toggleDispatchTerminal = useCallback(async () => {
    let nextVisible = true
    setState(prev => {
      const current = prev.dispatchMode ?? { scope: 'project' as const, terminalVisible: true }
      nextVisible = !current.terminalVisible
      return {
        ...prev,
        dispatchMode: {
          ...current,
          terminalVisible: nextVisible,
        },
      }
    })
    if (nextVisible) await ensureDispatchTerminal()
  }, [ensureDispatchTerminal, setState])

  return {
    enterDispatchMode,
    exitDispatchMode,
    setDispatchScope,
    toggleDispatchTerminal,
    ensureDispatchTerminal,
  }
}

function findTerminalInLatestTab(
  refs: WorkspaceRefs,
  tabId: TabId,
): SessionId | null {
  const latest = refs.stateRef.current
  const tab = latest.tabs.find(item => item.id === tabId)
  if (!tab) return null
  return collectLeaves(tab.root).find(id => latest.sessions[id]?.kind === 'terminal') ?? null
}
