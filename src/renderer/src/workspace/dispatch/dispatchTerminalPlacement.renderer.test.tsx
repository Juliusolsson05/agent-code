import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveTabSessions } from '@renderer/workspace/queries'
import {
  makeRefs,
  mountPaneActions,
  mountUndoCloseAction,
} from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { SessionId, WorkspaceState, TiledDispatchState } from '@renderer/workspace/types'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'

// End-to-end placement contract for terminals created on the stage (#671).
//
// WHY these drive `splitFocused` instead of asserting selector output over a
// hand-built fixture: the bug was never in the selectors. The index has always
// listed a project's sessions in one order; what was wrong is that
// `splitFocused` filed a new TERMINAL differently from a new agent — into the
// tile tree, whose leaves sorted ahead of every detached row — so the terminal
// could not help jumping above the agents. A test that writes the row by hand
// and then checks the list asserts only that selectors sort; it passes
// identically against the unfixed code. The spawn action is the unit under
// test, so the spawn action is what these mount.
//
// #992 removed the two homes that made the bug possible: there is one pool,
// ordered by `joinedAt`, and a terminal is filed into it exactly like an
// agent. The ordering assertion is kept because it is the user-visible
// contract and would catch any future "terminals are special" branch; the
// "not into the grid" half of it has nothing left to assert.

function makeDispatchState(stage: TiledDispatchState = freshStage()): WorkspaceState {
  // Three agents of one project, oldest first (`joinedAt` is the only thing
  // ordering them).
  return {
    tabs: [{
      id: 'tabA',
      title: 'project-a',
    }],
    activeTabId: 'tabA',
    stage,
    sessions: {
      a1: { cwd: '/work/project-a', kind: 'claude', projectId: 'tabA', joinedAt: 0 },
      a2: { cwd: '/work/project-a', kind: 'claude', projectId: 'tabA', joinedAt: 100 },
      // Distinct on purpose: a3 is the focused Dispatch row in the ordering
      // test, so a cwd shared with the grid leaf would make the #366 assertion
      // below unable to tell which source the terminal actually inherited.
      a3: { cwd: '/work/project-a/worktree', kind: 'codex', projectId: 'tabA', joinedAt: 200 },
    },
    pinnedSessionIds: [],
  } as WorkspaceState
}

describe('Dispatch terminal placement (#671)', () => {
  it('files a new terminal under the project AFTER its agents', async () => {
    const harness = mountPaneActions(
      makeDispatchState({ lanes: [{ selectedSessionId: 'a3' }], rows: [{ length: 1 }], focusedLane: 0 }),
      { spawnSessionId: 'aTerm' },
    )

    await act(async () => {
      await harness.actions.splitFocused('terminal')
    })

    const state = harness.getState()

    // Filed like any other session: under the project, stamped after every
    // existing member. (`toBeGreaterThan(200)` rather than a literal because
    // the stamp is wall-clock; 200 is the newest fixture row.)
    expect(state.sessions['aTerm' as SessionId]).toMatchObject({ projectId: 'tabA', kind: 'terminal' })
    expect(state.sessions['aTerm' as SessionId]!.joinedAt).toBeGreaterThan(200)
    expect(resolveTabSessions(state, 'tabA')).toEqual(['a1', 'a2', 'a3', 'aTerm'])

    // …and the user-visible consequence: creation order, terminal last.
    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toEqual([
      'a1',
      'a2',
      'a3',
      'aTerm',
    ])

    // cwd comes from the focused LANE's occupant (#366), which here is an
    // agent in a worktree. `/work/project-a/worktree` is reachable ONLY through
    // `target.cwdSessionId`; dropping that link from the cwd chain falls back
    // to the project's first session (`/work/project-a`) and fails here.
    // Without the distinct cwd this assertion could not tell the two apart.
    expect(harness.spawn).toHaveBeenCalledWith('/work/project-a/worktree', expect.objectContaining({
      kind: 'terminal',
    }))
    harness.mounted.unmount()
  })

  it('fills the focused lane when it is EMPTY, not lane 0', async () => {
    // Context-places (#992 §4.3): an empty focused lane is the one spawn a
    // fill is allowed in. The focused lane is lane 1 here and EMPTY; lane 0 is
    // occupied, which is what makes this case distinguish "the lane the user
    // was looking at" from "lane 0" — the "everything jumps to tile 1" failure
    // mode this layout has hit before.
    const harness = mountPaneActions(
      makeDispatchState({
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, {}],
      }),
      { spawnSessionId: 'aTerm' },
    )

    await act(async () => {
      await harness.actions.splitFocused('terminal')
    })

    const tiled = harness.getState().stage
    expect(tiled.lanes[1]!.selectedSessionId).toBe('aTerm')
    expect(tiled.lanes[0]!.selectedSessionId).toBe('a1')
    expect(tiled.focusedLane).toBe(1)
    harness.mounted.unmount()
  })

  it('pools the terminal when the focused lane is OCCUPIED — no lane changes, no focus move', async () => {
    // The other half of context-places: an occupied lane is never displaced.
    // Until stage 4 of #992 this spawn REPLACED a3 in lane 1; now a3 stays
    // where the user put it, the terminal is reachable from the index, and
    // not even the focus cursor moves — "nothing on screen moves" is half
    // the rule. (cwd still comes from the occupied lane's agent; see the
    // first case for why that link is load-bearing.)
    const harness = mountPaneActions(
      makeDispatchState({
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'a3' }],
      }),
      { spawnSessionId: 'aTerm' },
    )
    const before = harness.getState().stage

    await act(async () => {
      await harness.actions.splitFocused('terminal')
    })

    expect(harness.getState().stage).toBe(before)
    expect(harness.spawn).toHaveBeenCalledWith('/work/project-a/worktree', expect.objectContaining({
      kind: 'terminal',
    }))
    harness.mounted.unmount()
  })

  // 'normal (non-Dispatch) mode still splits the grid' lived here until #992:
  // there is no grid to split, so the stage branch above is the whole flow.
})

describe('closing a terminal is undoable (#671)', () => {
  // WHY this is part of the #671 suite: making terminals pool rows moved them
  // onto a close branch that, at the time, captured no undo entry. There is one
  // close path now and it always captures — these pin that it keeps doing so
  // for the kind where it matters most. For a terminal a missing entry is not
  // merely a lost convenience — closing it
  // stops the attach PTY but leaves the tmux session alive, and once the row is
  // gone from workspace.json the next launch's tmux reconcile reaps it as an
  // orphan. Without an undo entry carrying `tmuxName`, the scrollback is
  // unrecoverable.

  function detachedTerminalState(): WorkspaceState {
    const state = makeDispatchState({ lanes: [{ selectedSessionId: 'aTerm' }], rows: [{ length: 1 }], focusedLane: 0 })
    state.sessions['aTerm' as SessionId] = {
      cwd: '/work/project-a',
      kind: 'terminal',
      tmuxName: 'agent-code-aTerm',
    }
    state.sessions['aTerm' as SessionId] = { ...state.sessions['aTerm' as SessionId]!, projectId: 'tabA', joinedAt: 300 }
    return state
  }

  beforeEach(() => {
    // closeSession proves ownership in main before tearing a backend down.
    // These specs are about renderer bookkeeping, so the IPC is stubbed as
    // "yes, it was ours" — the interesting behaviour is what lands on the undo
    // stack afterwards.
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { killOwnedSession: vi.fn().mockResolvedValue(true) },
    })
  })

  it('captures an undo entry carrying tmuxName when a terminal is closed', async () => {
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    const harness = mountPaneActions(state, { refs })

    await act(async () => {
      await harness.actions.closeSession('aTerm' as SessionId, { preConfirmed: true })
    })

    const entry = refs.undoStackRef.current.peek()
    expect(entry).toMatchObject({
      type: 'session',
      sessionId: 'aTerm',
      // The row is stored verbatim, so `joinedAt` rides along and undo
      // restores the row's position rather than sending it to the bottom of
      // its project's list.
      sessionMeta: { kind: 'terminal', tmuxName: 'agent-code-aTerm', projectId: 'tabA', joinedAt: 300 },
    })
    harness.mounted.unmount()
  })

  it('undo respawns the terminal with recoverTmuxName and re-files it at its old position', async () => {
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'session',
      closedAt: Date.now(),
      sessionId: 'aTerm' as SessionId,
      sessionMeta: {
        cwd: '/work/project-a',
        kind: 'terminal',
        tmuxName: 'agent-code-aTerm',
        projectId: 'tabA',
        joinedAt: 300,
      },
    })
    // Close-then-undo: the session is gone from state by the time undo runs.
    delete state.sessions['aTerm' as SessionId]

    const spawn = vi.fn().mockResolvedValue('aTerm2')
    const undo = mountUndoCloseAction(state, refs, spawn)

    await act(async () => {
      await undo.actions.undoClose()
    })

    // recoverTmuxName is the whole point: without it undo hands the user an
    // empty shell and the original scrollback is still orphaned.
    expect(spawn).toHaveBeenCalledWith('/work/project-a', {
      kind: 'terminal',
      resumeSessionId: undefined,
      recoverTmuxName: 'agent-code-aTerm',
      builtInMcpOverrides: {},
    })
    expect(undo.getState().sessions['aTerm2' as SessionId]).toMatchObject({
      projectId: 'tabA',
      joinedAt: 300,
    })
    expect(resolveTabSessions(undo.getState(), 'tabA')).toEqual(['a1', 'a2', 'a3', 'aTerm2'])
    undo.mounted.unmount()
  })

  it('makes the restored row VISIBLE when another project tab is active', async () => {
    // The #672 review's blocker. Every other path that files a row sets
    // activeTabId in the same updater; the restore did not. While the index
    // was filtered to the active project, undoing a row that belonged to a
    // different one spawned a live backend into a list it was filtered out of
    // — no toast, no visible row, a claude/codex process or a re-attached tmux
    // session running invisibly. The index lists the whole fleet now, so the
    // row would be listed either way; activating its project is still what
    // puts the user where the thing they just restored is.
    //
    // The existing fixture has ONE tab, so the restore target was always the
    // active tab and the bug could not surface. This one adds the second tab
    // and asserts VISIBILITY rather than the field, because the field is the
    // mechanism and the visible row is the contract.
    const state = detachedTerminalState()
    state.tabs.push({ id: 'tabB', title: 'project-b' })
    state.sessions['b1' as SessionId] = { cwd: '/work/project-b', kind: 'claude', projectId: 'tabB', joinedAt: 0 }
    // The user has switched away from the project the closed row belonged to.
    state.activeTabId = 'tabB'

    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'session',
      closedAt: Date.now(),
      sessionId: 'aTerm' as SessionId,
      sessionMeta: {
        cwd: '/work/project-a',
        kind: 'terminal',
        tmuxName: 'agent-code-aTerm',
        projectId: 'tabA',
        joinedAt: 300,
      },
    })
    delete state.sessions['aTerm' as SessionId]

    const spawn = vi.fn().mockResolvedValue('aTerm2')
    const undo = mountUndoCloseAction(state, refs, spawn)

    await act(async () => {
      await undo.actions.undoClose()
    })

    const next = undo.getState()
    expect(spawn).toHaveBeenCalled()
    expect(next.activeTabId).toBe('tabA')
    // The assertion that would have caught the bug: the restored session is in
    // the rows Dispatch actually renders, in project scope.
    const visible = buildVisibleDispatchRows(next).map(row => row.sessionId)
    expect(visible).toContain('aTerm2')
    undo.mounted.unmount()
  })

  it('does not capture an undo entry when the caller opts out', async () => {
    // Bulk and programmatic closes (Close Old Agents, closeOrchestrationRun,
    // cascade children) opt out so a single operation closing a dozen sessions
    // cannot flush the user's own close history out of the 10-entry stack.
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    const harness = mountPaneActions(state, { refs })

    await act(async () => {
      await harness.actions.closeSession('aTerm' as SessionId, {
        preConfirmed: true,
        captureUndo: false,
      })
    })

    expect(refs.undoStackRef.current.length).toBe(0)
  })

  it('treats the entry as stale when its project tab is gone, instead of stranding a backend', async () => {
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'session',
      closedAt: Date.now(),
      sessionId: 'aTerm' as SessionId,
      // A project that no longer exists: a row filed under it is unowned, so
      // it would be listed nowhere and dropped by the next autosave while its
      // backend kept running — live and unreachable.
      sessionMeta: { cwd: '/work/project-a', kind: 'terminal', projectId: 'tab-closed', joinedAt: 300 },
    })

    const spawn = vi.fn().mockResolvedValue('aTerm2')
    const undo = mountUndoCloseAction(state, refs, spawn)

    await act(async () => {
      await undo.actions.undoClose()
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(refs.undoStackRef.current.length).toBe(0)
    undo.mounted.unmount()
  })
})
