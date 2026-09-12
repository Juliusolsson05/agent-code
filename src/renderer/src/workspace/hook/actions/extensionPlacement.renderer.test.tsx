import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  makeRefs,
  mountPaneActions,
  mountUndoCloseAction,
} from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

const extensionMeta: SessionMeta = {
  kind: 'extension-view',
  cwd: '/projects/b/worktree',
  extensionViewId: 'timer.main',
  title: 'My timer',
}

function workspace(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'A', root: { type: 'leaf', sessionId: 'a' }, focusedSessionId: 'a' },
      { id: 'tab-b', title: 'B', root: { type: 'leaf', sessionId: 'b' }, focusedSessionId: 'b' },
    ],
    activeTabId: 'tab-a',
    sessions: {
      a: { kind: 'claude', cwd: '/projects/a' },
      b: { kind: 'terminal', cwd: '/projects/b' },
      detached: { kind: 'codex', cwd: '/projects/b/worktree' },
    },
    detachedSessions: {
      detached: {
        sessionId: 'detached', surface: 'dispatch', projectTabId: 'tab-b',
        projectTabTitle: 'B', projectTabIndex: 1, detachedAt: 100,
      },
    },
    dispatchMode: null,
    pinnedSessionIds: [],
    buried: [],
  } as WorkspaceState
}

describe('extension view placement follows the visible command target', () => {
  it('splits the grid and persists metadata without spawning a backend', () => {
    const harness = mountPaneActions(workspace())
    act(() => { harness.actions.openExtensionViewInPane('timer.main') })
    const state = harness.getState()
    const id = state.tabs[0]!.focusedSessionId
    expect(collectLeaves(state.tabs[0]!.root)).toEqual(['a', id])
    expect(state.sessions[id]).toEqual({ kind: 'extension-view', cwd: '/projects/a', extensionViewId: 'timer.main' })
    expect(harness.spawn).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it.each([false, true])('opens from a detached global Dispatch target (tiled=%s)', tiled => {
    const initial = workspace()
    initial.dispatchMode = {
      scope: 'global', focusedSessionId: 'detached',
      ...(tiled ? { tiled: {
        focusedLane: 1, lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'detached' }],
      } } : {}),
    }
    const harness = mountPaneActions(initial)
    act(() => { harness.actions.openExtensionViewInPane('timer.main') })
    const state = harness.getState()
    const id = state.dispatchMode!.focusedSessionId!
    expect(id).not.toBe('detached')
    expect(state.activeTabId).toBe('tab-b')
    expect(state.detachedSessions[id]).toMatchObject({ projectTabId: 'tab-b', surface: 'dispatch' })
    expect(state.sessions[id]).toEqual({ kind: 'extension-view', cwd: '/projects/b/worktree', extensionViewId: 'timer.main' })
    expect(state.tabs).toEqual(initial.tabs)
    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toContain(id)
    if (tiled) {
      expect(state.dispatchMode!.tiled!.lanes.map(lane => lane.selectedSessionId)).toEqual(['a', id])
    }
    expect(harness.spawn).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })
})

describe('extension undo restores UI identity without a provider process', () => {
  it('restores a detached view and consumes the undo entry', async () => {
    const initial = workspace()
    initial.dispatchMode = { scope: 'project', focusedSessionId: 'a' }
    const refs = makeRefs(initial)
    refs.undoStackRef.current.push({
      type: 'detached', closedAt: Date.now(), sessionMeta: extensionMeta,
      record: {
        sessionId: 'closed', surface: 'dispatch', projectTabId: 'tab-b',
        projectTabTitle: 'B', projectTabIndex: 1, detachedAt: 50,
      },
    })
    // A main-process spawn of extension-view really rejects. Resolving the
    // mock would hide the poisoned-stack bug this scenario is meant to catch.
    const spawn = vi.fn().mockRejectedValue(new Error('extension views have no process'))
    const harness = mountUndoCloseAction(initial, refs, spawn)
    await act(async () => { await harness.actions.undoClose() })
    const state = harness.getState()
    const id = state.dispatchMode!.focusedSessionId!
    expect(spawn).not.toHaveBeenCalled()
    expect(refs.undoStackRef.current.length).toBe(0)
    expect(state.activeTabId).toBe('tab-b')
    expect(state.sessions[id]).toEqual(extensionMeta)
    expect(state.detachedSessions[id]).toMatchObject({ sessionId: id, projectTabId: 'tab-b', detachedAt: 50 })
    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toContain(id)
    harness.mounted.unmount()
  })

  it('restores a closed tab with both a grid view and a detached view', async () => {
    const initial = workspace()
    const refs = makeRefs(initial)
    refs.undoStackRef.current.push({
      type: 'tab', closedAt: Date.now(), tabIndex: 1,
      tab: { id: 'closed', title: 'Extensions', root: { type: 'leaf', sessionId: 'old-view' }, focusedSessionId: 'old-view' },
      sessionMetas: { 'old-view': extensionMeta },
      detachedEntries: [{ meta: { ...extensionMeta, extensionViewId: 'timer.history' }, detachedAt: 75 }],
    })
    const spawn = vi.fn().mockRejectedValue(new Error('extension views have no process'))
    const harness = mountUndoCloseAction(initial, refs, spawn)
    await act(async () => { await harness.actions.undoClose() })
    const state = harness.getState()
    const tab = state.tabs[1]!
    expect(spawn).not.toHaveBeenCalled()
    expect(tab.title).toBe('Extensions')
    expect(state.sessions[tab.focusedSessionId]).toEqual(extensionMeta)
    const restored = Object.values(state.detachedSessions).filter(row => row.projectTabId === tab.id)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.detachedAt).toBe(75)
    expect(state.sessions[restored[0]!.sessionId]).toEqual({ ...extensionMeta, extensionViewId: 'timer.history' })
    expect(refs.undoStackRef.current.length).toBe(0)
    harness.mounted.unmount()
  })
})
