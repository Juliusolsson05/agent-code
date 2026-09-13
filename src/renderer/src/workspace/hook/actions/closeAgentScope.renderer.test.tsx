import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { mergeProjectTabs } from '@renderer/workspace/mergeProjectTabs'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  resolveCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import { makeRefs, mountPaneActions, mountUndoCloseAction } from './testing/paneActionsHarness'
import type { DetachedSessionRecord, WorkspaceState } from '@renderer/workspace/types'

function project(): WorkspaceState {
  return {
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'root' }, focusedSessionId: 'root' }],
    activeTabId: 'project',
    sessions: {
      root: { cwd: '/project', kind: 'claude', title: 'Old root' },
      worker: { cwd: '/project', kind: 'codex', title: 'Running worker' },
    },
    detachedSessions: {
      worker: { sessionId: 'worker', surface: 'dispatch', projectTabId: 'project', projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 1 },
    },
    dispatchMode: { scope: 'project', focusedSessionId: 'root' },
    gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
  }
}

function dispatchRow(sessionId: string, projectTabId: string, detachedAt: number): DetachedSessionRecord {
  return { sessionId, surface: 'dispatch', projectTabId, projectTabTitle: projectTabId, projectTabIndex: 0, detachedAt }
}

const UNDO_HINT = ' — ⌘⇧T Undo Close; repeat for earlier closes'

/**
 * The ownership invariants a close must never break:
 *   - every tab's root leaves and focus name sessions that still exist (the
 *     invariant #886 review round 1 finding 3 broke);
 *   - every Dispatch row is filed under a tab that still exists (the one round 2
 *     N1 broke). A row whose project is gone renders nowhere, and the next
 *     autosave prunes its metadata while its backend keeps running.
 */
function expectValidTabs(state: WorkspaceState): void {
  for (const tab of state.tabs) {
    const leaves = collectLeaves(tab.root)
    for (const leaf of leaves) expect(state.sessions[leaf], `tab ${tab.id} leaf ${leaf}`).toBeDefined()
    expect(leaves).toContain(tab.focusedSessionId)
  }
  for (const record of Object.values(state.detachedSessions)) {
    expect(state.tabs.some(tab => tab.id === record.projectTabId), `row ${record.sessionId} names an existing project`).toBe(true)
  }
}

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

describe('root agent close scope (#153, #886)', () => {
  it('offers agent versus tab from the focused Dispatch row and cancels without killing', async () => {
    const harness = mountPaneActions(project())
    let closing!: Promise<void>
    await act(async () => { closing = harness.actions.closeFocused() })
    expect(currentCloseConfirmation()?.request.agentOnly?.targets.map(t => t.sessionId)).toEqual(['root'])
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId)).toEqual(['root', 'worker'])
    await act(async () => { resolveCloseConfirmation(false); await closing })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['root', 'worker'])
    harness.mounted.unmount()
  })

  it('closes only the root after Close Agent, preserving and promoting the live worker', async () => {
    const state = project()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: emptyRuntime(), worker: { ...emptyRuntime(), sessionStatus: 'running' } }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    await act(async () => { resolveCloseConfirmation('agent'); await closing })
    expect(killed()).toEqual(['root'])
    expect(harness.getState().tabs).toEqual([expect.objectContaining({ id: 'project', root: { type: 'leaf', sessionId: 'worker' } })])
    expect(harness.getState().sessions.worker).toBe(state.sessions.worker)
    expect(harness.getState().detachedSessions.worker).toBeUndefined()
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['worker'])
    expect(harness.spawn).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('bulk session-only close never kills an unselected detached worker or captures purge undo', async () => {
    const harness = mountPaneActions(project())
    await act(async () => {
      expect(await harness.actions.closeSession('root', {
        preConfirmed: true, captureUndo: false, onlyIf: () => true,
      })).toBe(true)
    })
    expect(killed()).toEqual(['root'])
    expect(harness.getState().sessions.worker).toBeDefined()
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    harness.mounted.unmount()
  })

  it('bulk keeps a parent while an unapproved linked child exists, and reports why', async () => {
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const harness = mountPaneActions(state)
    const onRefused = vi.fn()
    await act(async () => {
      expect(await harness.actions.closeSession('root', {
        preConfirmed: true, captureUndo: false, onlyIf: () => true, onRefused,
      })).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(harness.getState().sessions).toEqual(state.sessions)
    expect(onRefused).toHaveBeenCalledWith('linked-session-open')
    harness.mounted.unmount()
  })

  it('a bare preConfirmed grant names one session and cannot approve its linked children (N7)', async () => {
    // The contract says only bulk cleanup may assert preConfirmed, and only with
    // onlyIf. The bare form used to silently approve the whole linked expansion;
    // naming a session must never be permission to kill its children.
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const harness = mountPaneActions(state)
    await act(async () => {
      expect(await harness.actions.closeSession('root', { preConfirmed: true })).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(harness.getState().sessions).toEqual(state.sessions)
    expect(harness.showToast).toHaveBeenLastCalledWith('Kept “Old root” open — a linked session is still open.')
    harness.mounted.unmount()
  })

  it('bulk respects current eligibility inside the action instead of the modal snapshot', async () => {
    const harness = mountPaneActions(project())
    await act(async () => {
      expect(await harness.actions.closeSession('root', {
        preConfirmed: true, captureUndo: false, onlyIf: () => false,
      })).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('rejects a root-agent grant if that agent starts working under the dialog', async () => {
    const state = project()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: emptyRuntime(), worker: emptyRuntime() }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    refs.latestRuntimesRef.current.root = { ...emptyRuntime(), processActive: true }
    await act(async () => {
      resolveCloseConfirmation('agent')
      expect(await closing).toBe(false)
    })
    expect(killOwnedSession).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('Close Tab closes the listed project as one undo unit, and undo re-nests the linked child under the restored root', async () => {
    const state = project()
    // One linked child row and one unrelated row, so the two scopes differ and
    // the three-way choice is offered (see the n4 case below for equal sets).
    state.sessions.child = { cwd: '/project', kind: 'codex', linkedParentId: 'root' }
    state.detachedSessions.child = dispatchRow('child', 'project', 2)
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    expect(currentCloseConfirmation()?.request.agentOnly?.targets.map(t => t.sessionId)).toEqual(['root', 'child'])
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })
    // Linked child before its parent; the root last.
    expect(killed()).toEqual(['child', 'worker', 'root'])
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'tab',
      detachedEntries: [
        { sessionId: 'child', meta: state.sessions.child },
        { sessionId: 'worker', meta: state.sessions.worker },
      ],
    })

    // #886 review round 2 N3: the tab restore must re-point the restored child
    // at its restored parent's NEW id, or it comes back un-nested and no longer
    // closes with its parent.
    const spawn = vi.fn()
      .mockResolvedValueOnce('root-2')
      .mockResolvedValueOnce('child-2')
      .mockResolvedValueOnce('worker-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    const restored = undo.getState()
    expect(restored.sessions['child-2']?.linkedParentId).toBe('root-2')
    const rows = buildVisibleDispatchRows(restored)
    expect(rows.find(row => row.sessionId === 'child-2')?.depth).toBe(1)
    expect(rows.find(row => row.sessionId === 'worker-2')?.depth).toBe(0)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('asks the ordinary question when both scopes close the same sessions, still restoring the project as one unit (n4)', async () => {
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    const request = currentCloseConfirmation()?.request
    expect(request?.agentOnly).toBeUndefined()
    expect(request?.targets.map(t => t.sessionId)).toEqual(['root', 'worker'])
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })
    expect(killed()).toEqual(['worker', 'root'])
    expect(harness.getState().tabs).toEqual([])
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'tab', detachedEntries: [{ sessionId: 'worker', meta: state.sessions.worker }],
    })
    harness.mounted.unmount()
  })

  it('undo restores the root and Dispatch order without restarting the surviving worker', async () => {
    const state = project()
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    const spawn = vi.fn(async () => 'restored-root')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(undo.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'restored-root' })
    expect(undo.getState().detachedSessions.worker).toEqual(state.detachedSessions.worker)
    expect(undo.getState().sessions.worker).toBe(state.sessions.worker)
    expect(buildVisibleDispatchRows(undo.getState()).map(row => row.sessionId)).toEqual(['restored-root', 'worker'])
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('promotes the next displayed row even when detached records were inserted out of order', async () => {
    const state = project()
    state.sessions.earlier = { cwd: '/project', kind: 'codex' }
    state.detachedSessions.earlier = { ...state.detachedSessions.worker, sessionId: 'earlier', detachedAt: 0 }
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'earlier' })
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['earlier', 'worker'])
    expect(killed()).toEqual(['root'])
    harness.mounted.unmount()
  })

  it('undo preserves a later split instead of forcing the old root layout back', async () => {
    const harness = mountPaneActions(project())
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    const current = harness.getState()
    const edited = {
      ...current,
      sessions: { ...current.sessions, second: { cwd: '/project', kind: 'codex' as const } },
      tabs: current.tabs.map(tab => ({ ...tab, root: {
        type: 'split' as const, direction: 'vertical' as const, ratio: 0.5,
        a: { type: 'leaf' as const, sessionId: 'worker' },
        b: { type: 'leaf' as const, sessionId: 'second' },
      } })),
    }
    const undo = mountUndoCloseAction(edited, harness.refs, vi.fn(async () => 'restored-root'))
    await act(async () => { await undo.actions.undoClose() })
    expect(undo.getState().tabs[0].root).toBe(edited.tabs[0].root)
    expect(undo.getState().detachedSessions['restored-root']).toMatchObject({ projectTabId: 'project' })
    expect(Object.keys(undo.getState().sessions).sort()).toEqual(['restored-root', 'second', 'worker'])
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('automation silentIfSoleTarget closes a root with a Dispatch sibling alone, with no dialog, promoting the sibling (m4)', async () => {
    // Behavior change for automation, called out in PR #887: this shape used to
    // expand to the whole tab and raise a dialog naming the requesting agent.
    const harness = mountPaneActions(project())
    let closing!: Promise<boolean>
    await act(async () => {
      closing = harness.actions.closeSession('root', {
        silentIfSoleTarget: { headline: 'Agent “Lead” is asking to close an agent it started.' },
      })
    })
    const dialog = currentCloseConfirmation()
    if (dialog) resolveCloseConfirmation(false)
    expect(dialog).toBeNull()
    expect(await closing).toBe(true)
    expect(killed()).toEqual(['root'])
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'worker' })
    expect(harness.getState().sessions.worker).toBeDefined()
    harness.mounted.unmount()
  })
})

describe('Close Focused Session without a Dispatch target (#886 review finding 1)', () => {
  function tiledProject(lane: { selectedSessionId?: string }): WorkspaceState {
    return {
      tabs: [
        // An idle sole grid leaf with no Dispatch rows: the shape the blocker
        // killed instantly, taking its whole project with it.
        { id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'root' }, focusedSessionId: 'root' },
        { id: 'other', title: 'Other', root: { type: 'leaf', sessionId: 'other-root' }, focusedSessionId: 'other-root' },
      ],
      activeTabId: 'project',
      sessions: {
        root: { cwd: '/project', kind: 'claude' },
        'other-root': { cwd: '/other', kind: 'claude' },
      },
      detachedSessions: {},
      // Project scope, so the other project's session is outside the visible rows.
      dispatchMode: { scope: 'project', tiled: { lanes: [lane], focusedLane: 0 } },
      gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
  }

  it.each([
    ['an empty lane', {}],
    ['a lane holding a dead session id', { selectedSessionId: 'closed-long-ago' }],
    ['a lane holding a session outside the visible scope', { selectedSessionId: 'other-root' }],
  ])('closes nothing for %s, never the hidden grid session', async (_label, lane) => {
    const state = tiledProject(lane)
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeFocused() })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(currentCloseConfirmation()).toBeNull()
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    // Not merely equal: no write happened at all, so ownership is untouched.
    expect(harness.getState()).toBe(state)
    harness.mounted.unmount()
  })
})

describe('linked cascade revalidates each approved session at its own kill (#886 review finding 2)', () => {
  function parentWithTwoChildren(): WorkspaceState {
    return {
      // The parent is a split leaf, so no root-scope choice is involved: this is
      // the ordinary gated close of a session with linked children.
      tabs: [{ id: 'project', title: 'Project', focusedSessionId: 'parent', root: {
        type: 'split', direction: 'vertical', ratio: 0.5,
        a: { type: 'leaf', sessionId: 'anchor' }, b: { type: 'leaf', sessionId: 'parent' },
      } }],
      activeTabId: 'project',
      sessions: {
        anchor: { cwd: '/project', kind: 'claude' },
        parent: { cwd: '/project', kind: 'claude', title: 'Parent' },
        first: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' },
        second: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' },
      },
      detachedSessions: { first: dispatchRow('first', 'project', 1), second: dispatchRow('second', 'project', 2) },
      dispatchMode: null, gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
  }

  /** Approve closing the idle parent and both idle children, then hold the
   *  first child's backend kill so the workspace can change under the cascade. */
  async function approveWithFirstKillHeld() {
    let finishFirst: ((owned: boolean) => void) | undefined
    killOwnedSession.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirst = resolve }))
    const state = parentWithTwoChildren()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = {
      anchor: emptyRuntime(), parent: emptyRuntime(), first: emptyRuntime(), second: emptyRuntime(),
    }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('parent') })
    expect(currentCloseConfirmation()?.request.targets.map(t => [t.sessionId, t.live]))
      .toEqual([['parent', false], ['first', false], ['second', false]])
    await act(async () => { resolveCloseConfirmation(true) })
    await waitFor(() => expect(killOwnedSession).toHaveBeenCalledOnce())
    return { harness, refs, closing, release: () => finishFirst?.(true) }
  }

  it('keeps a second child that starts working before the first kill resolves, keeps the parent, and reports the partial close', async () => {
    const { harness, refs, closing, release } = await approveWithFirstKillHeld()
    refs.latestRuntimesRef.current.second = { ...emptyRuntime(), processActive: true }
    // false: the agent the caller named is still running (closeSession's doc).
    await act(async () => { release(); expect(await closing).toBe(false) })
    expect(killed()).toEqual(['first'])
    expect(Object.keys(harness.getState().sessions).sort()).toEqual(['anchor', 'parent', 'second'])
    expect(harness.getState().tabs[0].root).toEqual(parentWithTwoChildren().tabs[0].root)
    // #886 review round 2 (Codex 3, N4): not a silent refusal. The toast names
    // what closed, why the parent stayed, and that the second child stayed open
    // too; the closed child is recoverable.
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 1 of 3 listed sessions — kept “Parent” open because a linked session is still open; 1 other session stayed open because it changed or failed to close${UNDO_HINT}`,
    )
    expect(harness.refs.undoStackRef.current.length).toBe(1)
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({ type: 'detached', record: { sessionId: 'first' } })
    expectValidTabs(harness.getState())
    harness.mounted.unmount()
  })

  it('keeps the parent when a child is linked to it after approval, and undo brings both closed children back as one unit', async () => {
    const { harness, closing, release } = await approveWithFirstKillHeld()
    act(() => harness.setState(prev => ({
      ...prev,
      sessions: { ...prev.sessions, late: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' } },
      detachedSessions: { ...prev.detachedSessions, late: dispatchRow('late', 'project', 3) },
    })))
    await act(async () => { release(); expect(await closing).toBe(false) })
    // Both approved children close; the unapproved late child is never touched
    // and holds its parent open.
    expect(killed()).toEqual(['first', 'second'])
    expect(Object.keys(harness.getState().sessions).sort()).toEqual(['anchor', 'late', 'parent'])
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 2 of 3 listed sessions — kept “Parent” open because a linked session is still open${UNDO_HINT}`,
    )
    expect(harness.refs.undoStackRef.current.length).toBe(1)
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'group',
      entries: [{ record: { sessionId: 'first' } }, { record: { sessionId: 'second' } }],
    })

    // A group replays last-first. A transient spawn failure before anything came
    // back keeps the whole unit on the stack instead of consuming it.
    const spawn = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce('second-2')
      .mockResolvedValueOnce('first-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({ type: 'group', entries: [{}, {}] })
    expect(Object.keys(undo.getState().sessions).sort()).toEqual(['anchor', 'late', 'parent'])
    await act(async () => { await undo.actions.undoClose() })
    const restored = undo.getState()
    expect(restored.sessions['first-2']?.linkedParentId).toBe('parent')
    expect(restored.sessions['second-2']?.linkedParentId).toBe('parent')
    expect(restored.detachedSessions['first-2']).toMatchObject({ projectTabId: 'project', detachedAt: 1 })
    expect(restored.detachedSessions['second-2']).toMatchObject({ projectTabId: 'project', detachedAt: 2 })
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})

describe('a cascade never promotes a session it is about to close (#886 review finding 3)', () => {
  /** Parent P detached to Dispatch; its linked child C is the tab's sole grid
   *  leaf. Reached by attaching C beside P and detaching P, both supported. */
  function detachedParentWithRootChild(withUnrelatedRow: boolean): WorkspaceState {
    return {
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'child' }, focusedSessionId: 'child' }],
      activeTabId: 'project',
      sessions: {
        parent: { cwd: '/project', kind: 'claude', title: 'Parent' },
        child: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' },
        ...(withUnrelatedRow ? { other: { cwd: '/project', kind: 'claude' as const } } : {}),
      },
      detachedSessions: {
        parent: dispatchRow('parent', 'project', 1),
        ...(withUnrelatedRow ? { other: dispatchRow('other', 'project', 2) } : {}),
      },
      dispatchMode: { scope: 'project', focusedSessionId: 'parent' },
      gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
  }

  async function closeApprovedParent(state: WorkspaceState) {
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('parent') })
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId)).toEqual(['parent', 'child'])
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })
    expect(killed()).toEqual(['child', 'parent'])
    expectValidTabs(harness.getState())
    return harness
  }

  it('removes the emptied project when nothing unrelated survives, recording the project as it was for undo', async () => {
    const harness = await closeApprovedParent(detachedParentWithRootChild(false))
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.getState().detachedSessions).toEqual({})
    // Built from the approval snapshot: the child was the root and the parent a
    // row, so undo brings the project back in that shape, not rooted at
    // whichever session happened to close last.
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'tab',
      tab: { id: 'project', root: { type: 'leaf', sessionId: 'child' }, focusedSessionId: 'child' },
      sessionMetas: { child: { linkedParentId: 'parent' } },
      detachedEntries: [{ sessionId: 'parent', detachedAt: 1 }],
    })
    harness.mounted.unmount()
  })

  it('promotes the unrelated row, never the closing parent', async () => {
    const harness = await closeApprovedParent(detachedParentWithRootChild(true))
    expect(harness.getState().tabs).toEqual([expect.objectContaining({
      id: 'project', root: { type: 'leaf', sessionId: 'other' }, focusedSessionId: 'other',
    })])
    expect(Object.keys(harness.getState().sessions)).toEqual(['other'])
    expect(harness.getState().detachedSessions).toEqual({})
    harness.mounted.unmount()
  })
})

describe('a member kept after an earlier commit stays placed (#886 review round 2 N1)', () => {
  /** Hold the sole grid leaf's kill so a pending member can change before its
   *  own verdict — after the leaf's commit has already decided the project. */
  async function closeParentWithRootKillHeld(state: WorkspaceState, listed: string[], change: string) {
    let release: ((owned: boolean) => void) | undefined
    killOwnedSession.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = Object.fromEntries(Object.keys(state.sessions).map(id => [id, emptyRuntime()]))
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('parent') })
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId)).toEqual(listed)
    await act(async () => { resolveCloseConfirmation(true) })
    await waitFor(() => expect(killOwnedSession).toHaveBeenCalledOnce())
    refs.latestRuntimesRef.current[change] = { ...emptyRuntime(), processActive: true }
    let result!: boolean
    await act(async () => { release?.(true); result = await closing })
    return { harness, result }
  }

  it('keeps a parent that starts working during its root child\'s kill as the project root, visible in Dispatch', async () => {
    const state: WorkspaceState = {
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'child' }, focusedSessionId: 'child' }],
      activeTabId: 'project',
      sessions: {
        parent: { cwd: '/project', kind: 'claude', title: 'Parent' },
        child: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' },
      },
      detachedSessions: { parent: dispatchRow('parent', 'project', 1) },
      dispatchMode: { scope: 'project', focusedSessionId: 'parent' },
      gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
    const { harness, result } = await closeParentWithRootKillHeld(state, ['parent', 'child'], 'parent')
    expect(result).toBe(false)
    expect(killed()).toEqual(['child'])
    // Round 1 removed the project here and left the working parent as a row
    // under a deleted tab. The fallback promotion keeps its project alive.
    expect(harness.getState().tabs).toEqual([expect.objectContaining({
      id: 'project', root: { type: 'leaf', sessionId: 'parent' }, focusedSessionId: 'parent',
    })])
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['parent'])
    expectValidTabs(harness.getState())
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 1 of 2 listed sessions — kept “Parent” open because it changed${UNDO_HINT}`,
    )
    // The closed child is recoverable: undo restores it as root and returns the
    // parent to its Dispatch row.
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'detached', record: { sessionId: 'child' }, replacedRoot: { sessionId: 'parent', detachedAt: 1 },
    })
    harness.mounted.unmount()
  })

  it('keeps both the parent and a second child that changes during the root child\'s kill placed and visible', async () => {
    const state: WorkspaceState = {
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'child' }, focusedSessionId: 'child' }],
      activeTabId: 'project',
      sessions: {
        parent: { cwd: '/project', kind: 'claude', title: 'Parent' },
        child: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' },
        second: { cwd: '/project', kind: 'codex', linkedParentId: 'parent' },
      },
      detachedSessions: { parent: dispatchRow('parent', 'project', 1), second: dispatchRow('second', 'project', 2) },
      dispatchMode: { scope: 'project', focusedSessionId: 'parent' },
      gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
    const { harness, result } = await closeParentWithRootKillHeld(state, ['parent', 'child', 'second'], 'second')
    expect(result).toBe(false)
    expect(killed()).toEqual(['child'])
    const after = harness.getState()
    expect(after.tabs).toHaveLength(1)
    expect(buildVisibleDispatchRows(after).map(row => row.sessionId).sort()).toEqual(['parent', 'second'])
    expectValidTabs(after)
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 1 of 3 listed sessions — kept “Parent” open because a linked session is still open; 1 other session stayed open because it changed or failed to close${UNDO_HINT}`,
    )
    harness.mounted.unmount()
  })
})

describe('undo keeps close lineage across promoted roots (#886 review finding 4)', () => {
  it('two agents: close A, close B, undo, undo restores A as root with B back as its row', async () => {
    const harness = mountPaneActions(project())
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    await act(async () => { await harness.actions.closeSession('worker', { preConfirmed: true }) })
    expect(harness.getState().tabs).toEqual([])

    const spawn = vi.fn().mockResolvedValueOnce('worker-2').mockResolvedValueOnce('root-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    await act(async () => { await undo.actions.undoClose() })

    const restored = undo.getState()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(restored.tabs).toHaveLength(1)
    expect(restored.tabs[0].root).toEqual({ type: 'leaf', sessionId: 'root-2' })
    // The worker regains its original record, detachedAt included.
    expect(restored.detachedSessions['worker-2']).toMatchObject({ projectTabId: restored.tabs[0].id, detachedAt: 1 })
    expect(buildVisibleDispatchRows(restored).map(row => row.sessionId)).toEqual(['root-2', 'worker-2'])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('three agents: close A, close B, undo, undo restores the original root and row order', async () => {
    const state = project()
    state.sessions.second = { cwd: '/project', kind: 'codex' }
    state.detachedSessions.second = { ...state.detachedSessions.worker, sessionId: 'second', detachedAt: 2 }
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    await act(async () => { await harness.actions.closeSession('worker', { preConfirmed: true }) })
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'second' })

    const spawn = vi.fn().mockResolvedValueOnce('worker-2').mockResolvedValueOnce('root-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    await act(async () => { await undo.actions.undoClose() })

    const restored = undo.getState()
    expect(restored.tabs.map(tab => tab.id)).toEqual(['project'])
    expect(restored.tabs[0].root).toEqual({ type: 'leaf', sessionId: 'root-2' })
    expect(buildVisibleDispatchRows(restored).map(row => row.sessionId)).toEqual(['root-2', 'worker-2', 'second'])
    expect(restored.detachedSessions['worker-2']).toMatchObject({ detachedAt: 1 })
    expect(restored.detachedSessions.second).toMatchObject({ detachedAt: 2 })
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('still treats an entry whose project was merged away as stale instead of resurrecting it (#914)', async () => {
    const state = project()
    state.tabs.push({ id: 'target', title: 'Target', root: { type: 'leaf', sessionId: 'target-root' }, focusedSessionId: 'target-root' })
    state.sessions['target-root'] = { cwd: '/target', kind: 'claude' }
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    act(() => harness.setState(prev => {
      const merged = mergeProjectTabs(prev, { targetTabId: 'target', sourceTabIds: ['project'], now: 10 })
      if (!merged.ok) throw new Error(`merge refused: ${merged.reason}`)
      return merged.state
    }))

    const spawn = vi.fn()
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    // Merge publishes no lineage, so the anchor still resolves to nothing.
    expect(spawn).not.toHaveBeenCalled()
    expect(undo.getState().tabs.map(tab => tab.id)).toEqual(['target'])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})

describe('Close Tab executes the plan the dialog listed (#886 review finding 5)', () => {
  it('closes a linked child attached in another project before its parent, and captures it for undo', async () => {
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
      detachedSessions: { worker: dispatchRow('worker', 'a', 1) },
      dispatchMode: null, gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
    }
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('parent') })
    const listed = currentCloseConfirmation()?.request.targets.map(t => t.sessionId)
    expect(listed).toEqual(['parent', 'child', 'worker'])
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })

    // Exactly the listed set, the linked child before its parent.
    expect([...killed()].sort()).toEqual([...listed!].sort())
    expect(killed().indexOf('child')).toBeLessThan(killed().indexOf('parent'))
    expect(harness.getState().tabs).toEqual([expect.objectContaining({
      id: 'b', root: { type: 'leaf', sessionId: 'anchor' }, focusedSessionId: 'anchor',
    })])
    expect(Object.keys(harness.getState().sessions)).toEqual(['anchor'])
    expect(harness.getState().activeTabId).toBe('b')
    expectValidTabs(harness.getState())
    // One unit: the child's pane in B (so undo reinserts it where it was), then
    // project A with its row folded in.
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'group',
      entries: [
        { type: 'pane', sessionId: 'child', tabId: 'b' },
        { type: 'tab', tab: { id: 'a' }, detachedEntries: [{ sessionId: 'worker' }] },
      ],
    })
    harness.mounted.unmount()
  })
})
