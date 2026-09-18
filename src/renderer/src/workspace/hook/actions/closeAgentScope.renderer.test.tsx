import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { mergeProjectTabs } from '@renderer/workspace/mergeProjectTabs'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  resolveCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'
import { makeRefs, mountPaneActions, mountUndoCloseAction } from './testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// What a close may and may not take with it (#153, #886), on the pool (#992).
//
// WHAT CHANGED UNDER THIS SUITE. It was written while a project owned a tile
// tree, and a third of it pinned consequences of that tree: a tab's root could
// not be empty, so closing a tab's last tile leaf either ended the whole
// project or PROMOTED a Dispatch row into the tree, the user was asked which
// ("Close agent / Close tab"), and undo had to restore the old root "only if
// nobody had rearranged it". None of that can be constructed any more — no
// session is structurally special — so those cases are gone, each with a note
// where it stood. Every invariant that was about SESSIONS rather than about
// the tree carries over unchanged: a close kills exactly what was approved,
// each member is re-judged at its own kill, a parent never orphans a linked
// child, a kept member is never left under a deleted project, and undo
// describes what actually happened.

function project(): WorkspaceState {
  return {
    tabs: [{ id: 'project', title: 'Project' }],
    activeTabId: 'project',
    sessions: {
      root: { cwd: '/project', kind: 'claude', title: 'Old root', projectId: 'project', joinedAt: 0 },
      worker: { cwd: '/project', kind: 'codex', title: 'Running worker', projectId: 'project', joinedAt: 1 },
    },
    stage: oneLaneStage('root'),
    pinnedSessionIds: [],
  }
}

const UNDO_HINT = ' — ⌘⇧T Undo Close; repeat for earlier closes'

/**
 * The ownership invariant a close must never break: every session that is
 * still in the workspace is OWNED — its project exists. A session whose
 * project is gone renders nowhere, and the next autosave prunes its metadata
 * while its backend keeps running (#886 review round 2 N1).
 *
 * (In the tree era this also checked that every tab's root leaves and focus
 * named sessions that still existed — the invariant round 1 finding 3 broke.)
 */
function expectEverySessionOwned(state: WorkspaceState): void {
  const owned = collectOwnedSessionIds(state)
  for (const id of Object.keys(state.sessions)) expect(owned.has(id), `${id} is owned`).toBe(true)
  // And no project outlives its sessions.
  for (const tab of state.tabs) {
    expect(Object.values(state.sessions).some(meta => meta.projectId === tab.id), `project ${tab.id} holds a session`).toBe(true)
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

describe('a session close is session-scoped (#153, #886)', () => {
  it('closes only the named session, without asking, and leaves the rest of its project alone', async () => {
    // The tree-era form of this case opened a three-way "Close agent / Close
    // tab" dialog, because `root` was its tab's sole tile leaf and the tree
    // could not be left empty. One idle session with no linked children is the
    // cheap case now, whoever it is: no dialog, one kill.
    const state = project()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: emptyRuntime(), worker: { ...emptyRuntime(), sessionStatus: 'running' } }
    const harness = mountPaneActions(state, { refs })
    await act(async () => { expect(await harness.actions.closeFocused()).toBeUndefined() })

    expect(currentCloseConfirmation()).toBeNull()
    expect(killed()).toEqual(['root'])
    expect(harness.getState().tabs).toEqual(state.tabs)
    expect(harness.getState().sessions.worker).toBe(state.sessions.worker)
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['worker'])
    // The lane that showed it goes EMPTY. It is not refilled with the worker
    // (#681) and it is not removed.
    expect(harness.getState().stage.lanes).toEqual([{ selectedSessionId: undefined }])
    expect(harness.spawn).not.toHaveBeenCalled()
    expectEverySessionOwned(harness.getState())
    harness.mounted.unmount()
  })

  it('asks before closing a working session, and cancels without killing', async () => {
    const state = project()
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: { ...emptyRuntime(), processActive: true }, worker: emptyRuntime() }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<void>
    await act(async () => { closing = harness.actions.closeFocused() })
    // Exactly the session named: closing it is no longer a reason to list the
    // rest of its project.
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId)).toEqual(['root'])
    await act(async () => { resolveCloseConfirmation(false); await closing })
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(harness.getState()).toBe(state)
    harness.mounted.unmount()
  })

  it('bulk session-only close never kills an unselected session or captures purge undo', async () => {
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

  it('rejects a grant if the named agent starts working under the dialog', async () => {
    // A linked child makes this a two-session close, so a dialog opens while
    // both are idle. (The tree-era case used the root-scope dialog for this.)
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const refs = makeRefs(state)
    refs.latestRuntimesRef.current = { root: emptyRuntime(), worker: emptyRuntime() }
    const harness = mountPaneActions(state, { refs })
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    expect(currentCloseConfirmation()?.request.targets.map(t => [t.sessionId, t.live])).toEqual([['root', false], ['worker', false]])
    refs.latestRuntimesRef.current.root = { ...emptyRuntime(), processActive: true }
    await act(async () => {
      resolveCloseConfirmation(true)
      expect(await closing).toBe(false)
    })
    // The gate re-enumerates after the dialog and refuses the WHOLE plan: the
    // list the user approved no longer describes the workspace, so nothing in
    // it is killed — not even the child that is still idle.
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(harness.getState()).toBe(state)
    harness.mounted.unmount()
  })

  it('removes the project with its LAST session and records the project as one undo unit', async () => {
    // A project owns nothing, so it exists while a session names it. Here the
    // named session and its linked child are the whole project.
    const state = project()
    state.sessions.worker.linkedParentId = 'root'
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('root') })
    const request = currentCloseConfirmation()?.request
    // One ordinary question about one list. (Tree era, #886 n4: this shape had
    // to SUPPRESS a three-way scope choice, because both scopes named the same
    // set. The choice and the request field that carried it are deleted.)
    expect(request?.reason).toBe('multi')
    expect(request?.targets.map(t => t.sessionId)).toEqual(['root', 'worker'])
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })
    expect(killed()).toEqual(['worker', 'root'])
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.getState().activeTabId).toBe('')
    expect(harness.refs.undoStackRef.current.peek()).toEqual({
      type: 'tab',
      closedAt: expect.any(Number),
      tab: { id: 'project', title: 'Project' },
      tabIndex: 0,
      // Index order, not commit order: the restored project must list its
      // sessions the way it used to.
      sessions: [
        { sessionId: 'root', meta: state.sessions.root },
        { sessionId: 'worker', meta: state.sessions.worker },
      ],
    })
    expect(harness.showToast).toHaveBeenLastCalledWith(`Closed “Project”${UNDO_HINT}`)
    harness.mounted.unmount()
  })

  it('undo puts a closed session back at its old place without restarting anyone else', async () => {
    const state = project()
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({ type: 'session', sessionId: 'root', sessionMeta: state.sessions.root })

    const spawn = vi.fn(async () => 'restored-root')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(undo.getState().sessions.worker).toBe(state.sessions.worker)
    // `joinedAt` rides back verbatim, so it lists FIRST again, not last.
    expect(undo.getState().sessions['restored-root']).toMatchObject({ projectId: 'project', joinedAt: 0, title: 'Old root' })
    expect(buildVisibleDispatchRows(undo.getState()).map(row => row.sessionId)).toEqual(['restored-root', 'worker'])
    // Undo returns it to the POOL. It does not re-aim the lane the close
    // emptied: a lane the user may since have re-aimed must not be yanked back.
    expect(undo.getState().stage).toBe(harness.getState().stage)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('automation silentIfSoleTarget closes a session with siblings alone, with no dialog (m4)', async () => {
    // Behavior change for automation, called out in PR #887: a tab's sole tile
    // leaf used to expand to the whole tab and raise a dialog naming the
    // requesting agent. It expands to exactly itself.
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
    expect(harness.getState().sessions.worker).toBeDefined()
    harness.mounted.unmount()
  })

  // Deleted with the tile tree (#992), each because its subject no longer exists:
  //   - "offers agent versus tab from the focused Dispatch row" — the scope
  //     choice (closing a tab's sole leaf);
  //   - "closes only the root after Close Agent, preserving and PROMOTING the
  //     live worker" and "promotes the next displayed row even when detached
  //     records were inserted out of order" — row promotion into an emptied tree;
  //   - "undo preserves a later split instead of forcing the old root layout
  //     back" — `replacedRoot`, undo's conditional reversal of a promotion.
})

describe('Close Focused Session without a Dispatch target (#886 review finding 1)', () => {
  function tiledProject(lane: { selectedSessionId?: string }): WorkspaceState {
    return {
      // `root` is an idle agent that no lane shows: the shape the blocker
      // killed instantly (it was the tab's sole tile leaf then), taking its
      // whole project with it.
      tabs: [{ id: 'project', title: 'Project' }, { id: 'other', title: 'Other' }],
      activeTabId: 'project',
      sessions: {
        root: { cwd: '/project', kind: 'claude', projectId: 'project', joinedAt: 0 },
        'other-root': { cwd: '/other', kind: 'claude', projectId: 'other', joinedAt: 0 },
      },
      stage: { lanes: [lane], focusedLane: 0 },
      pinnedSessionIds: [],
    }
  }

  it.each([
    ['an empty lane', {}],
    ['a lane holding a dead session id', { selectedSessionId: 'closed-long-ago' }],
    // A third row lived here until #992: "a lane holding a session outside the
    // visible scope" (another project's agent under project scope). There is
    // no scope now — that lane SHOWS the agent, so closing it is correct and
    // is covered by the case below instead of being refused here.
  ])('closes nothing for %s, never an agent the user cannot see', async (_label, lane) => {
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

  it('closes another project s agent when that is what the focused lane shows', async () => {
    // The stage has no project scope (#992): a lane may show any project's
    // agent, and the destructive target is what is highlighted. The active
    // project is still `project`; the lane shows `other-root`; the lane wins.
    const harness = mountPaneActions(tiledProject({ selectedSessionId: 'other-root' }))
    await act(async () => { await harness.actions.closeFocused() })
    // The target is captured from the lane — never the active project's own
    // agent, whatever happens after (a sole idle leaf may confirm or close).
    const targeted = currentCloseConfirmation()?.request.targets.map(target => target.sessionId)
      ?? killOwnedSession.mock.calls.map(call => (call[0] as { sessionId: string }).sessionId)
    expect(targeted).toContain('other-root')
    expect(targeted).not.toContain('root')
    harness.mounted.unmount()
  })
})

describe('linked cascade revalidates each approved session at its own kill (#886 review finding 2)', () => {
  function parentWithTwoChildren(): WorkspaceState {
    return {
      tabs: [{ id: 'project', title: 'Project' }],
      activeTabId: 'project',
      sessions: {
        anchor: { cwd: '/project', kind: 'claude', projectId: 'project', joinedAt: 0 },
        parent: { cwd: '/project', kind: 'claude', title: 'Parent', projectId: 'project', joinedAt: 1 },
        first: { cwd: '/project', kind: 'codex', linkedParentId: 'parent', projectId: 'project', joinedAt: 2 },
        second: { cwd: '/project', kind: 'codex', linkedParentId: 'parent', projectId: 'project', joinedAt: 3 },
      },
      stage: oneLaneStage('parent'),
      pinnedSessionIds: [],
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
    // #886 review round 2 (Codex 3, N4): not a silent refusal. The toast names
    // what closed, why the parent stayed, and that the second child stayed open
    // too; the closed child is recoverable.
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 1 of 3 listed sessions — kept “Parent” open because a linked session is still open; 1 other session stayed open because it changed or failed to close${UNDO_HINT}`,
    )
    expect(harness.refs.undoStackRef.current.length).toBe(1)
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({ type: 'session', sessionId: 'first' })
    expectEverySessionOwned(harness.getState())
    harness.mounted.unmount()
  })

  it('keeps the parent when a child is linked to it after approval, and undo brings both closed children back as one unit', async () => {
    const { harness, closing, release } = await approveWithFirstKillHeld()
    act(() => harness.setState(prev => ({
      ...prev,
      sessions: {
        ...prev.sessions,
        late: { cwd: '/project', kind: 'codex', linkedParentId: 'parent', projectId: 'project', joinedAt: 4 },
      },
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
      entries: [{ type: 'session', sessionId: 'first' }, { type: 'session', sessionId: 'second' }],
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
    expect(restored.sessions['first-2']).toMatchObject({ linkedParentId: 'parent', projectId: 'project', joinedAt: 2 })
    expect(restored.sessions['second-2']).toMatchObject({ linkedParentId: 'parent', projectId: 'project', joinedAt: 3 })
    // Back in their old places: between the parent and the child linked later.
    expect(buildVisibleDispatchRows(restored).map(row => row.sessionId))
      .toEqual(['anchor', 'parent', 'first-2', 'second-2', 'late'])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})

describe('a project leaves only with its last session (#886 review finding 3, round 2 N1)', () => {
  // The two #886 findings this describe block replaces were both about the
  // tile tree's root. Finding 3: closing parent P whose linked child C was the
  // tab's sole leaf PROMOTED P into the root while closing C, then deleted P —
  // a tab rooted at a deleted session. Round 2 N1: the fix (never promote a
  // pending member) removed the tab instead, stranding a member that was then
  // KEPT under a deleted tab. Both were the same question — "what keeps this
  // project alive?" — answered by a structure. The answer is data now: a
  // project exists while a session names it, decided at each commit against
  // the live store. These cases pin that both failure shapes stay closed.

  function parentAndChild(extra: WorkspaceState['sessions'] = {}): WorkspaceState {
    return {
      tabs: [{ id: 'project', title: 'Project' }],
      activeTabId: 'project',
      sessions: {
        child: { cwd: '/project', kind: 'codex', linkedParentId: 'parent', projectId: 'project', joinedAt: 0 },
        parent: { cwd: '/project', kind: 'claude', title: 'Parent', projectId: 'project', joinedAt: 1 },
        ...extra,
      },
      stage: oneLaneStage('parent'),
      pinnedSessionIds: [],
    }
  }

  async function closeApprovedParent(state: WorkspaceState) {
    const harness = mountPaneActions(state)
    let closing!: Promise<boolean>
    await act(async () => { closing = harness.actions.closeSession('parent') })
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId)).toEqual(['parent', 'child'])
    await act(async () => { resolveCloseConfirmation(true); expect(await closing).toBe(true) })
    expect(killed()).toEqual(['child', 'parent'])
    expectEverySessionOwned(harness.getState())
    return harness
  }

  it('removes the emptied project when nothing unrelated survives, recording it for undo', async () => {
    const state = parentAndChild()
    const harness = await closeApprovedParent(state)
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'tab',
      tab: { id: 'project', title: 'Project' },
      tabIndex: 0,
      sessions: [
        { sessionId: 'child', meta: { linkedParentId: 'parent', joinedAt: 0 } },
        { sessionId: 'parent', meta: { joinedAt: 1 } },
      ],
    })
    harness.mounted.unmount()
  })

  it('keeps the project when an unrelated session survives', async () => {
    const state = parentAndChild({ other: { cwd: '/project', kind: 'claude', projectId: 'project', joinedAt: 2 } })
    const harness = await closeApprovedParent(state)
    expect(harness.getState().tabs).toEqual(state.tabs)
    expect(Object.keys(harness.getState().sessions)).toEqual(['other'])
    harness.mounted.unmount()
  })

  /** Hold the child's kill so a pending member can change before its own
   *  verdict — after the child's commit has already run. */
  async function closeParentWithChildKillHeld(state: WorkspaceState, listed: string[], change: string) {
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

  it('keeps a parent that starts working during its child s kill filed under a living project', async () => {
    const { harness, result } = await closeParentWithChildKillHeld(parentAndChild(), ['parent', 'child'], 'parent')
    expect(result).toBe(false)
    expect(killed()).toEqual(['child'])
    // Round 1 of #886 removed the project here and left the working parent
    // under a deleted tab: invisible, pruned by the next autosave, backend
    // still running. The project stays because the parent still names it.
    expect(harness.getState().tabs.map(tab => tab.id)).toEqual(['project'])
    expect(buildVisibleDispatchRows(harness.getState()).map(row => row.sessionId)).toEqual(['parent'])
    expectEverySessionOwned(harness.getState())
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 1 of 2 listed sessions — kept “Parent” open because it changed${UNDO_HINT}`,
    )
    // The closed child is recoverable, as itself.
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({ type: 'session', sessionId: 'child' })
    harness.mounted.unmount()
  })

  it('keeps both the parent and a second child that changes during the first child s kill visible', async () => {
    const state = parentAndChild({
      second: { cwd: '/project', kind: 'codex', linkedParentId: 'parent', projectId: 'project', joinedAt: 2 },
    })
    const { harness, result } = await closeParentWithChildKillHeld(state, ['parent', 'child', 'second'], 'second')
    expect(result).toBe(false)
    expect(killed()).toEqual(['child'])
    const after = harness.getState()
    expect(after.tabs).toHaveLength(1)
    expect(buildVisibleDispatchRows(after).map(row => row.sessionId).sort()).toEqual(['parent', 'second'])
    expectEverySessionOwned(after)
    expect(harness.showToast).toHaveBeenLastCalledWith(
      `Closed 1 of 3 listed sessions — kept “Parent” open because a linked session is still open; 1 other session stayed open because it changed or failed to close${UNDO_HINT}`,
    )
    harness.mounted.unmount()
  })
})

describe('undo keeps close lineage across a removed project (#886 review finding 4)', () => {
  it('two agents: close A, close B (the project goes), undo, undo brings back the project with both, in order', async () => {
    const harness = mountPaneActions(project())
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    await act(async () => { await harness.actions.closeSession('worker', { preConfirmed: true }) })
    expect(harness.getState().tabs).toEqual([])

    const spawn = vi.fn().mockResolvedValueOnce('worker-2').mockResolvedValueOnce('root-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    // First undo re-creates the project under a NEW id with the worker...
    await act(async () => { await undo.actions.undoClose() })
    const newProjectId = undo.getState().tabs[0]!.id
    expect(newProjectId).not.toBe('project')
    // ...and publishes project -> newProjectId, which is the only reason the
    // older entry (A, anchored on the dead id) is still restorable.
    await act(async () => { await undo.actions.undoClose() })

    const restored = undo.getState()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(restored.tabs).toEqual([{ id: newProjectId, title: 'Project' }])
    expect(restored.sessions['root-2']).toMatchObject({ projectId: newProjectId, joinedAt: 0 })
    expect(restored.sessions['worker-2']).toMatchObject({ projectId: newProjectId, joinedAt: 1 })
    expect(buildVisibleDispatchRows(restored).map(row => row.sessionId)).toEqual(['root-2', 'worker-2'])
    expect(harness.refs.undoStackRef.current.length).toBe(0)
    expectEverySessionOwned(restored)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('three agents: close A, close B, undo, undo restores the original order around the survivor', async () => {
    const state = project()
    state.sessions.second = { cwd: '/project', kind: 'codex', projectId: 'project', joinedAt: 2 }
    const harness = mountPaneActions(state)
    await act(async () => { await harness.actions.closeSession('root', { preConfirmed: true }) })
    await act(async () => { await harness.actions.closeSession('worker', { preConfirmed: true }) })
    // The project survives both closes: `second` still names it.
    expect(harness.getState().tabs.map(tab => tab.id)).toEqual(['project'])

    const spawn = vi.fn().mockResolvedValueOnce('worker-2').mockResolvedValueOnce('root-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    await act(async () => { await undo.actions.undoClose() })

    const restored = undo.getState()
    expect(restored.tabs.map(tab => tab.id)).toEqual(['project'])
    expect(buildVisibleDispatchRows(restored).map(row => row.sessionId)).toEqual(['root-2', 'worker-2', 'second'])
    expect(restored.sessions.second).toBe(state.sessions.second)
    undo.mounted.unmount()
    harness.mounted.unmount()
  })

  it('still treats an entry whose project was merged away as stale instead of resurrecting it (#914)', async () => {
    const state = project()
    state.tabs.push({ id: 'target', title: 'Target' })
    state.sessions['target-root'] = { cwd: '/target', kind: 'claude', projectId: 'target', joinedAt: 0 }
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
  function twoProjects(): WorkspaceState {
    return {
      tabs: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
      activeTabId: 'a',
      sessions: {
        parent: { cwd: '/a', kind: 'claude', title: 'Parent', projectId: 'a', joinedAt: 0 },
        worker: { cwd: '/a', kind: 'codex', projectId: 'a', joinedAt: 1 },
        anchor: { cwd: '/b', kind: 'claude', projectId: 'b', joinedAt: 0 },
        // Filed under project B, but linked to a parent in A: linkage is a
        // lifecycle bond, membership is a label, and they need not agree.
        child: { cwd: '/a', kind: 'codex', linkedParentId: 'parent', projectId: 'b', joinedAt: 1 },
      },
      stage: oneLaneStage('parent'),
      pinnedSessionIds: [],
    }
  }

  it('closes a linked child filed in another project before its parent, and captures it for undo', async () => {
    const state = twoProjects()
    const harness = mountPaneActions(state)
    let closing!: Promise<void>
    await act(async () => { closing = harness.actions.closeTab('a') })
    const listed = currentCloseConfirmation()?.request.targets.map(t => t.sessionId)
    expect(listed).toEqual(['parent', 'child', 'worker'])
    await act(async () => { resolveCloseConfirmation(true); await closing })

    // Exactly the listed set, the linked child before its parent.
    expect([...killed()].sort()).toEqual([...listed!].sort())
    expect(killed().indexOf('child')).toBeLessThan(killed().indexOf('parent'))
    expect(harness.getState().tabs).toEqual([{ id: 'b', title: 'B' }])
    expect(Object.keys(harness.getState().sessions)).toEqual(['anchor'])
    expect(harness.getState().activeTabId).toBe('b')
    expectEverySessionOwned(harness.getState())
    // One unit: the child as a session of B (its project survived), then
    // project A with its two sessions folded in.
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'group',
      entries: [
        { type: 'session', sessionId: 'child', sessionMeta: { projectId: 'b' } },
        { type: 'tab', tab: { id: 'a' }, sessions: [{ sessionId: 'parent' }, { sessionId: 'worker' }] },
      ],
    })
    harness.mounted.unmount()
  })

  it('undo re-nests the linked child under its restored parent', async () => {
    // #886 review round 2 N3: the restore must re-point the child at its
    // parent's NEW id, or it comes back un-nested and no longer closes with it.
    const state = twoProjects()
    state.sessions.child = { ...state.sessions.child!, projectId: 'a', joinedAt: 2 }
    const harness = mountPaneActions(state)
    let closing!: Promise<void>
    await act(async () => { closing = harness.actions.closeTab('a') })
    await act(async () => { resolveCloseConfirmation(true); await closing })
    expect(harness.refs.undoStackRef.current.peek()).toMatchObject({
      type: 'tab', sessions: [{ sessionId: 'parent' }, { sessionId: 'worker' }, { sessionId: 'child' }],
    })

    const spawn = vi.fn()
      .mockResolvedValueOnce('parent-2')
      .mockResolvedValueOnce('worker-2')
      .mockResolvedValueOnce('child-2')
    const undo = mountUndoCloseAction(harness.getState(), harness.refs, spawn)
    await act(async () => { await undo.actions.undoClose() })
    const restored = undo.getState()
    expect(restored.sessions['child-2']?.linkedParentId).toBe('parent-2')
    const rows = buildVisibleDispatchRows(restored)
    expect(rows.find(row => row.sessionId === 'child-2')?.depth).toBe(1)
    expect(rows.find(row => row.sessionId === 'worker-2')?.depth).toBe(0)
    // Re-inserted where it was: first, ahead of B.
    expect(restored.tabs.map(tab => tab.title)).toEqual(['A', 'B'])
    undo.mounted.unmount()
    harness.mounted.unmount()
  })
})
