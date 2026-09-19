import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { tabCommands } from '@renderer/features/workspace/commands/tabCommands'
import { CloseConfirmationDialog } from '@renderer/features/workspace/ui/CloseConfirmationDialog'
import { __resetCloseConfirmationForTests } from '@renderer/workspace/closeConfirmationBroker'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { mountPaneActions, mountUndoCloseAction } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// The Close Tab COMMAND (⌘⇧W, tab bar ×, palette), driven end to end: palette
// entry, the pane close executor, the confirmation dialog and Undo Close. Only
// the ownership-checked kill IPC and undo's spawn are mocked.
//
// #886 review round 2 found the command still ran its own close: it listed a
// project's linked descendants but killed only the tab's leaves and rows, and
// it pushed a whole-tab undo entry and a "Closed" toast before Promise.all
// killed everything — so one rejected kill left a tab naming a deleted session
// and an undo entry for a tab that was never removed. The root dialog's Close
// Tab had already been fixed; these tests pin the command separately because
// the review showed that fixing one entry point says nothing about the other.

const command = tabCommands.find(candidate => candidate.id === 'close-tab')
if (!command) throw new Error('Close Tab command is missing')

const killOwnedSession = vi.fn(async (_owner: { sessionId: string }) => true)
const killed = () => killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  killOwnedSession.mockReset().mockImplementation(async () => true)
  Object.defineProperty(window, 'api', { configurable: true, value: { killOwnedSession } })
})
afterEach(() => {
  __resetCloseConfirmationForTests()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function expectValidWorkspace(state: WorkspaceState): void {
  for (const tab of state.tabs) {
    const leaves = collectLeaves(tab.root)
    for (const leaf of leaves) expect(state.sessions[leaf], `tab ${tab.id} leaf ${leaf}`).toBeDefined()
    expect(leaves).toContain(tab.focusedSessionId)
  }
  for (const record of Object.values(state.detachedSessions)) {
    expect(state.tabs.some(tab => tab.id === record.projectTabId), `row ${record.sessionId} has a project`).toBe(true)
  }
}

function mountCommand(state: WorkspaceState) {
  const harness = mountPaneActions(state)
  render(<CloseConfirmationDialog />)
  const workspace = {
    get state() { return harness.getState() },
    get activeTab() {
      const current = harness.getState()
      return current.tabs.find(tab => tab.id === current.activeTabId) ?? null
    },
    closeTab: harness.actions.closeTab,
  } as unknown as Workspace
  return { harness, context: { workspace, ui: {}, flags: {} } as unknown as CommandContext }
}

async function runAndConfirm(context: CommandContext, button: string) {
  let running!: void | Promise<void>
  await act(async () => { running = command!.run(context) })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: button }))
    await running
  })
}

describe('Close Tab command runs the approved close operation (#886 review round 2)', () => {
  it('closes a linked child attached in another project, captures it, and undo restores it under the restored parent', async () => {
    const state: WorkspaceState = {
      tabs: [
        { id: 'a', title: 'A', root: { type: 'leaf', sessionId: 'parent' }, focusedSessionId: 'parent' },
        { id: 'b', title: 'B', focusedSessionId: 'anchor', root: {
          type: 'split', direction: 'vertical', ratio: 0.5,
          a: { type: 'leaf', sessionId: 'anchor' }, b: { type: 'leaf', sessionId: 'child' },
        } },
      ],
      activeTabId: 'a',
      sessions: {
        parent: { cwd: '/a', kind: 'claude', title: 'Parent' },
        worker: { cwd: '/a', kind: 'codex' },
        // Attached beside a pane of project B; attachment keeps linkedParentId.
        child: { cwd: '/a', kind: 'codex', linkedParentId: 'parent' },
        anchor: { cwd: '/b', kind: 'claude' },
      },
      detachedSessions: {
        worker: { sessionId: 'worker', surface: 'dispatch', projectTabId: 'a', projectTabTitle: 'A', projectTabIndex: 0, detachedAt: 1 },
      },
      dispatchMode: null, gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
    const { harness, context } = mountCommand(state)
    await runAndConfirm(context, 'Close 3')

    // Exactly the listed set, the linked child before its parent, the tab's
    // grid leaf last.
    expect(killed()).toEqual(['child', 'worker', 'parent'])
    expect(harness.getState().tabs).toEqual([expect.objectContaining({
      id: 'b', root: { type: 'leaf', sessionId: 'anchor' }, focusedSessionId: 'anchor',
    })])
    expect(Object.keys(harness.getState().sessions)).toEqual(['anchor'])
    expectValidWorkspace(harness.getState())
    expect(harness.showToast).toHaveBeenLastCalledWith('Closed “A” — ⌘⇧T Undo Close; repeat for earlier closes')
    // One undo unit for one decision: the child's pane in B, then project A.
    expect(harness.refs.undoStackRef.current.length).toBe(1)
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'group',
      entries: [
        { type: 'pane', sessionId: 'child', tabId: 'b', siblingLeafId: 'anchor' },
        { type: 'tab', tab: { id: 'a', root: { type: 'leaf', sessionId: 'parent' } }, detachedEntries: [{ sessionId: 'worker' }] },
      ],
    })

    // Undo replays last-first: project A comes back first, then the child is
    // re-anchored on the restored parent's new id before it respawns.
    const spawn = vi.fn()
      .mockResolvedValueOnce('parent-2')
      .mockResolvedValueOnce('worker-2')
      .mockResolvedValueOnce('child-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    const restored = undo.getState()
    const restoredA = restored.tabs.find(tab => tab.title === 'A')
    expect(restoredA?.root).toEqual({ type: 'leaf', sessionId: 'parent-2' })
    expect(restored.detachedSessions['worker-2']).toMatchObject({ projectTabId: restoredA?.id, detachedAt: 1 })
    expect(restored.sessions['child-2']?.linkedParentId).toBe('parent-2')
    expect(collectLeaves(restored.tabs.find(tab => tab.id === 'b')!.root).sort()).toEqual(['anchor', 'child-2'])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    expectValidWorkspace(restored)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('leaves no phantom tab or undo entry when one member\'s kill rejects, and roots the tab on the survivor', async () => {
    killOwnedSession.mockImplementation(async owner => {
      if (owner.sessionId === 'row') throw new Error('backend refused')
      return true
    })
    const split = {
      type: 'split' as const, direction: 'vertical' as const, ratio: 0.4,
      a: { type: 'leaf' as const, sessionId: 'grid' }, b: { type: 'leaf' as const, sessionId: 'term' },
    }
    const state: WorkspaceState = {
      tabs: [{ id: 'a', title: 'A', root: split, focusedSessionId: 'grid' }],
      activeTabId: 'a',
      sessions: {
        grid: { cwd: '/a', kind: 'claude' },
        term: { cwd: '/a', kind: 'terminal', tmuxName: 'agent-code-term' },
        row: { cwd: '/a', kind: 'codex', title: 'Row' },
      },
      detachedSessions: {
        row: { sessionId: 'row', surface: 'dispatch', projectTabId: 'a', projectTabTitle: 'A', projectTabIndex: 0, detachedAt: 4 },
      },
      dispatchMode: { scope: 'project' }, gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
    const { harness, context } = mountCommand(state)
    await runAndConfirm(context, 'Close 3')

    // Sequential, each revalidated: the row's kill rejected and it stays; both
    // grid panes closed; the last one promoted the surviving row, so the tab is
    // valid and rooted on it instead of naming a deleted session.
    expect(killed()).toEqual(['row', 'grid', 'term'])
    const after = harness.getState()
    expect(after.tabs).toEqual([expect.objectContaining({ id: 'a', root: { type: 'leaf', sessionId: 'row' }, focusedSessionId: 'row' })])
    expect(Object.keys(after.sessions)).toEqual(['row'])
    expect(buildVisibleDispatchRows(after).map(visible => visible.sessionId)).toEqual(['row'])
    expectValidWorkspace(after)
    expect(harness.showToast).toHaveBeenLastCalledWith(
      'Closed 2 of 3 listed sessions — 1 session stayed open because it changed or failed to close — ⌘⇧T Undo Close; repeat for earlier closes',
    )
    // Undo covers exactly what closed — never a whole-tab copy of a tab that
    // still exists, which would respawn the surviving row as a duplicate.
    expect(harness.refs.undoStackRef.current.length).toBe(1)
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'group',
      entries: [
        { type: 'pane', sessionId: 'grid', siblingLeafId: 'term' },
        { type: 'detached', record: { sessionId: 'term' }, replacedRoot: { sessionId: 'row' } },
      ],
    })

    // And undo puts the project back as it was: the row returns to Dispatch,
    // the terminal re-attaches as root, and the split is rebuilt around it.
    const spawn = vi.fn().mockResolvedValueOnce('term-2').mockResolvedValueOnce('grid-2')
    const undo = mountUndoCloseAction(after, harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    const restored = undo.getState()
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ kind: 'terminal', recoverTmuxName: 'agent-code-term' })
    expect(restored.tabs[0]?.root).toEqual({ ...split, a: { type: 'leaf', sessionId: 'grid-2' }, b: { type: 'leaf', sessionId: 'term-2' } })
    expect(restored.detachedSessions.row).toMatchObject({ projectTabId: 'a', detachedAt: 4 })
    expectValidWorkspace(restored)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})
