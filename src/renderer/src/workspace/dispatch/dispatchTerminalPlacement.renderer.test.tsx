import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import {
  makeRefs,
  mountPaneActions,
  mountUndoCloseAction,
} from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { DispatchModeState, SessionId, WorkspaceState } from '@renderer/workspace/types'

// End-to-end placement contract for sessions created from Dispatch (#671).
//
// WHY these drive `splitFocused` instead of asserting selector output over a
// hand-built fixture: the bug was never in the selectors. `buildDispatchGroups`
// has always emitted `[...grid, ...detached]`; what was wrong is that
// `splitFocused` filed a Dispatch TERMINAL into the grid tree while filing
// every agent as a detached row, so the terminal could not help sorting above
// the agents. A test that writes the detached record by hand and then checks
// the concatenation asserts only that selectors concatenate — it passes
// identically against the unfixed code and would not notice the grid branch
// coming back. The spawn action is the unit under test, so the spawn action is
// what these mount.

function makeDispatchState(dispatchMode: DispatchModeState): WorkspaceState {
  // One grid leaf (a1) plus two detached Dispatch agents, oldest first. This is
  // the ordinary shape of a project in Dispatch: the original pane stayed in
  // the grid and everything created since is a detached row.
  return {
    tabs: [{
      id: 'tabA',
      title: 'project-a',
      root: { type: 'leaf', sessionId: 'a1' },
      focusedSessionId: 'a1',
    }],
    activeTabId: 'tabA',
    dispatchMode,
    sessions: {
      a1: { cwd: '/work/project-a', kind: 'claude' },
      a2: { cwd: '/work/project-a', kind: 'claude' },
      // Distinct on purpose: a3 is the focused Dispatch row in the ordering
      // test, so a cwd shared with the grid leaf would make the #366 assertion
      // below unable to tell which source the terminal actually inherited.
      a3: { cwd: '/work/project-a/worktree', kind: 'codex' },
    },
    detachedSessions: {
      a2: {
        sessionId: 'a2',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 100,
      },
      a3: {
        sessionId: 'a3',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 200,
      },
    },
    buried: [],
    pinnedSessionIds: [],
  } as WorkspaceState
}

describe('Dispatch terminal placement (#671)', () => {
  it('files a Dispatch-created terminal as a detached row after the agents, not into the grid', async () => {
    const harness = mountPaneActions(
      makeDispatchState({ scope: 'project', focusedSessionId: 'a3' }),
      { spawnSessionId: 'aTerm' },
    )

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'terminal')
    })

    const state = harness.getState()

    // The load-bearing assertion. Before the fix the terminal was spliced into
    // `tab.root` by `splitLeaf`, which put it in the grid slice that
    // `buildDispatchGroups` emits BEFORE every detached row.
    expect(collectLeaves(state.tabs[0]!.root)).toEqual(['a1'])
    expect(state.detachedSessions['aTerm' as SessionId]).toMatchObject({
      surface: 'dispatch',
      projectTabId: 'tabA',
    })

    // …and the user-visible consequence: creation order, terminal last.
    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toEqual([
      'a1',
      'a2',
      'a3',
      'aTerm',
    ])

    // cwd comes from the focused Dispatch row (#366), which here is a DETACHED
    // agent in a worktree — the normal Dispatch state, and the case with no
    // grid leaf to fall back on. `/work/project-a/worktree` is reachable ONLY
    // through `target.cwdSessionId`; dropping that link from the cwd chain
    // falls back to the grid leaf's `/work/project-a` and fails here. Without
    // the distinct cwd this assertion could not tell the two apart.
    expect(harness.spawn).toHaveBeenCalledWith('/work/project-a/worktree', expect.objectContaining({
      kind: 'terminal',
    }))
    harness.mounted.unmount()
  })

  it('places the new terminal in the FOCUSED tiled lane, not lane 0', async () => {
    const harness = mountPaneActions(
      makeDispatchState({
        scope: 'project',
        focusedSessionId: 'a1',
        tiled: {
          focusedLane: 1,
          lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'a3' }],
        },
      }),
      { spawnSessionId: 'aTerm' },
    )

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'terminal')
    })

    const tiled = harness.getState().dispatchMode!.tiled!
    // Lane 1 is where the user was looking. Lane 0 must be untouched — the
    // "everything jumps to tile 1" failure mode this layout has hit before.
    expect(tiled.lanes[1]!.selectedSessionId).toBe('aTerm')
    expect(tiled.lanes[0]!.selectedSessionId).toBe('a1')
    expect(tiled.focusedLane).toBe(1)
    harness.mounted.unmount()
  })

  it('normal (non-Dispatch) mode still splits the grid', async () => {
    // The merged branch is gated on `dispatchMode`; ⌥T outside Dispatch must
    // keep its old grid behaviour. Without this, "merge the flows" could
    // quietly mean "terminals never enter the grid again".
    const state = makeDispatchState({ scope: 'project', focusedSessionId: 'a1' })
    const harness = mountPaneActions(
      { ...state, dispatchMode: null },
      { spawnSessionId: 'aTerm' },
    )

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'terminal')
    })

    const next = harness.getState()
    expect(collectLeaves(next.tabs[0]!.root)).toEqual(['a1', 'aTerm'])
    expect(next.detachedSessions['aTerm' as SessionId]).toBeUndefined()
    harness.mounted.unmount()
  })
})

describe('closing a detached Dispatch session is undoable (#671)', () => {
  // WHY this is part of the #671 suite: making Dispatch terminals detached rows
  // moved them onto `closeSession`'s detached branch, which captured no undo
  // entry. For a terminal that is not merely a lost convenience — closing it
  // stops the attach PTY but leaves the tmux session alive, and once the row is
  // gone from workspace.json the next launch's tmux reconcile reaps it as an
  // orphan. Without an undo entry carrying `tmuxName`, the scrollback is
  // unrecoverable.

  function detachedTerminalState(): WorkspaceState {
    const state = makeDispatchState({ scope: 'project', focusedSessionId: 'aTerm' })
    state.sessions['aTerm' as SessionId] = {
      cwd: '/work/project-a',
      kind: 'terminal',
      tmuxName: 'agent-code-aTerm',
    }
    state.detachedSessions['aTerm' as SessionId] = {
      sessionId: 'aTerm' as SessionId,
      surface: 'dispatch',
      projectTabId: 'tabA',
      projectTabTitle: 'project-a',
      projectTabIndex: 0,
      detachedAt: 300,
    }
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

  it('captures an undo entry carrying tmuxName when a detached terminal is closed', async () => {
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    const harness = mountPaneActions(state, { refs })

    await act(async () => {
      await harness.actions.closeSession('aTerm' as SessionId, { preConfirmed: true })
    })

    const entry = refs.undoStackRef.current.peek()
    expect(entry).toMatchObject({
      type: 'detached',
      sessionMeta: { kind: 'terminal', tmuxName: 'agent-code-aTerm' },
      // detachedAt is preserved so undo restores the row's position rather
      // than sending it to the bottom of the Dispatch list.
      record: { detachedAt: 300, projectTabId: 'tabA' },
    })
    harness.mounted.unmount()
  })

  it('undo respawns the terminal with recoverTmuxName and re-files it at its old position', async () => {
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'detached',
      closedAt: Date.now(),
      sessionMeta: {
        cwd: '/work/project-a',
        kind: 'terminal',
        tmuxName: 'agent-code-aTerm',
      },
      record: {
        sessionId: 'aTerm' as SessionId,
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 300,
      },
    })
    // Close-then-undo: the session is gone from state by the time undo runs.
    delete state.sessions['aTerm' as SessionId]
    delete state.detachedSessions['aTerm' as SessionId]

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
      builtInMcpDomains: undefined,
    })
    expect(undo.getState().detachedSessions['aTerm2' as SessionId]).toMatchObject({
      sessionId: 'aTerm2',
      projectTabId: 'tabA',
      detachedAt: 300,
    })
    undo.mounted.unmount()
  })

  it('treats the entry as stale when its project tab is gone, instead of stranding a backend', async () => {
    const state = detachedTerminalState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'detached',
      closedAt: Date.now(),
      sessionMeta: { cwd: '/work/project-a', kind: 'terminal' },
      record: {
        sessionId: 'aTerm' as SessionId,
        surface: 'dispatch',
        // A project tab that no longer exists: a detached record filed under it
        // would render in no Dispatch group at all, so the session would be
        // live and unreachable.
        projectTabId: 'tab-closed',
        projectTabTitle: 'gone',
        projectTabIndex: 0,
        detachedAt: 300,
      },
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
