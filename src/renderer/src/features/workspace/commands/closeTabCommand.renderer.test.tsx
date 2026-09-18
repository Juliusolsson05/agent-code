import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { tabCommands } from '@renderer/features/workspace/commands/tabCommands'
import { CloseConfirmationDialog } from '@renderer/features/workspace/ui/CloseConfirmationDialog'
import { __resetCloseConfirmationForTests } from '@renderer/workspace/closeConfirmationBroker'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { mountPaneActions, mountUndoCloseAction } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

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

/**
 * The invariants a close must never break, in the pool-first shape (#992).
 *
 * This used to check the TREE: every leaf has metadata, the tab's focus is one
 * of its leaves, every detached row names a live tab. Those were three ways of
 * saying one thing — nothing on screen points at something that is gone — and
 * with ownership on the row it is said in three different places:
 *   - every row names a project that exists (else autosave drops it as unowned,
 *     which after a PARTIAL close would silently delete a survivor);
 *   - every project still lists at least one session (a project exists only
 *     while something names it — an empty one is a phantom tab);
 *   - every lane and pin resolves (a pointer at a closed session is the
 *     "selected-but-unresolvable lane" bug).
 */
function expectValidWorkspace(state: WorkspaceState): void {
  const projectIds = new Set(state.tabs.map(tab => tab.id))
  for (const [id, meta] of Object.entries(state.sessions)) {
    expect(projectIds.has(meta.projectId ?? ''), `session ${id} names a live project`).toBe(true)
  }
  for (const tab of state.tabs) {
    expect(resolveTabSessions(state, tab.id).length, `project ${tab.id} lists a session`).toBeGreaterThan(0)
  }
  for (const lane of state.stage.lanes) {
    if (lane.selectedSessionId !== undefined) expect(state.sessions[lane.selectedSessionId]).toBeDefined()
  }
  for (const pinned of state.pinnedSessionIds) expect(state.sessions[pinned]).toBeDefined()
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
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
      activeTabId: 'a',
      sessions: {
        parent: { cwd: '/a', kind: 'claude', title: 'Parent', projectId: 'a', joinedAt: 0 },
        worker: { cwd: '/a', kind: 'codex', projectId: 'a', joinedAt: 1 },
        // Filed under project B while still linked to a parent in A: a linked
        // child follows its PARENT's close, whatever project lists it.
        child: { cwd: '/a', kind: 'codex', linkedParentId: 'parent', projectId: 'b', joinedAt: 1 },
        anchor: { cwd: '/b', kind: 'claude', projectId: 'b', joinedAt: 0 },
      },
      stage: oneLaneStage('parent'),   pinnedSessionIds: [],
    }
    const { harness, context } = mountCommand(state)
    await runAndConfirm(context, 'Close 3')

    // Exactly the listed set, the linked child before its parent. (The order
    // used to end on the tab's grid leaf, because a tile tree could not be left
    // empty mid-operation. Nothing needs to go last now; only depth orders.)
    expect(killed()).toEqual(['child', 'parent', 'worker'])
    expect(harness.getState().tabs).toEqual([{ id: 'b', title: 'B' }])
    expect(harness.getState().activeTabId).toBe('b')
    expect(Object.keys(harness.getState().sessions)).toEqual(['anchor'])
    // The lane that showed the closed parent is EMPTY, not refilled (#681).
    expect(harness.getState().stage.lanes).toEqual([{}])
    expectValidWorkspace(harness.getState())
    expect(harness.showToast).toHaveBeenLastCalledWith('Closed “A” — ⌘⇧T Undo Close; repeat for earlier closes')
    // One undo unit for one decision: the child's row in B, then project A
    // with both of its sessions in index order.
    expect(harness.refs.undoStackRef.current.length).toBe(1)
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'group',
      entries: [
        { type: 'session', sessionId: 'child', sessionMeta: { projectId: 'b', joinedAt: 1 } },
        { type: 'tab', tab: { id: 'a', title: 'A' }, tabIndex: 0, sessions: [{ sessionId: 'parent' }, { sessionId: 'worker' }] },
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
    expect(restoredA).toBeDefined()
    expect(resolveTabSessions(restored, restoredA!.id)).toEqual(['parent-2', 'worker-2'])
    expect(restored.sessions['worker-2']).toMatchObject({ projectId: restoredA!.id, joinedAt: 1 })
    expect(restored.sessions['child-2']?.linkedParentId).toBe('parent-2')
    // The child returns to project B, where it was listed — not to the
    // restored A, even though that is where its parent lives.
    expect(resolveTabSessions(restored, 'b')).toEqual(['anchor', 'child-2'])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    expectValidWorkspace(restored)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('leaves no phantom tab or undo entry when one member\'s kill rejects, and the project keeps its survivor', async () => {
    killOwnedSession.mockImplementation(async owner => {
      if (owner.sessionId === 'row') throw new Error('backend refused')
      return true
    })
    const state: WorkspaceState = {
      tabs: [{ id: 'a', title: 'A' }],
      activeTabId: 'a',
      sessions: {
        grid: { cwd: '/a', kind: 'claude', projectId: 'a', joinedAt: 0 },
        term: { cwd: '/a', kind: 'terminal', tmuxName: 'agent-code-term', projectId: 'a', joinedAt: 1 },
        row: { cwd: '/a', kind: 'codex', title: 'Row', projectId: 'a', joinedAt: 4 },
      },
      stage: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 },   pinnedSessionIds: [],
    }
    const { harness, context } = mountCommand(state)
    await runAndConfirm(context, 'Close 3')

    // Sequential, each revalidated: the row's kill rejected and it stays; the
    // other two closed. The project is NOT removed — a project leaves only with
    // the commit that takes its last session, and that commit never happened.
    // (In v2 the last grid pane's close had to PROMOTE the surviving row into
    // the tile root so the tab stayed renderable. There is nothing to promote
    // into: the survivor was always a full member of the project.)
    expect(killed()).toEqual(['grid', 'term', 'row'])
    const after = harness.getState()
    expect(after.tabs).toEqual([{ id: 'a', title: 'A' }])
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
        { type: 'session', sessionId: 'grid', sessionMeta: { joinedAt: 0 } },
        // `tmuxName` is why a terminal must always get an entry: without it the
        // next launch's reconcile kills the surviving tmux session as an orphan.
        { type: 'session', sessionId: 'term', sessionMeta: { joinedAt: 1, tmuxName: 'agent-code-term' } },
      ],
    })

    // And undo puts the project back as it was: both closed sessions return to
    // their old positions AHEAD of the survivor, which never moved.
    const spawn = vi.fn().mockResolvedValueOnce('term-2').mockResolvedValueOnce('grid-2')
    const undo = mountUndoCloseAction(after, harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    const restored = undo.getState()
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ kind: 'terminal', recoverTmuxName: 'agent-code-term' })
    expect(resolveTabSessions(restored, 'a')).toEqual(['grid-2', 'term-2', 'row'])
    expect(restored.sessions.row).toMatchObject({ projectId: 'a', joinedAt: 4 })
    expectValidWorkspace(restored)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})
