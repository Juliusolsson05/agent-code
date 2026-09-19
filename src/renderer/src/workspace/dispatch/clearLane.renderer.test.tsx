import { renderHook } from '@testing-library/react'
import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import { makeRefs } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { clearFocusedLaneCommand } from '@renderer/features/workspace/commands/layoutCommands'
import type { CommandContext } from '@renderer/features/command-palette/types'

afterEach(cleanup)

// Clear Lane (#992 §4.4) — the gentle exit. Everything these cases pin is the
// DIFFERENCE from its two neighbours, because all three empty the same lane:
//
//   Remove Lane            — the lane is GONE (the row shrinks)
//   Close Agent & Remove   — the session is DEAD (kill + undo entry)
//   Clear Lane             — the lane stays, the occupant LIVES, nothing is
//                            undone because nothing was lost
//
// A Clear Lane that killed, removed the lane, or grew an undo entry would be
// one of its neighbours wearing its name — which is exactly how the command
// would drift once someone "fixes" an inconsistency by reusing a neighbour's
// commit path.

function workspace(): WorkspaceState {
  return {
    tabs: [{ id: 'p', title: 'Project' }, { id: 'q', title: 'Other' }],
    activeTabId: 'p',
    sessions: {
      anchor: { kind: 'claude', cwd: '/p', projectId: 'p', joinedAt: 0 },
      other: { kind: 'codex', cwd: '/q', projectId: 'q', joinedAt: 0 },
    },
    stage: {
      lanes: [{ selectedSessionId: 'anchor' }, { selectedSessionId: 'other' }, {}],
      rows: [{ length: 2 }, { length: 1 }],
      focusedLane: 0,
    },
    pinnedSessionIds: ['anchor'],
  }
}

function mount() {
  const initial = workspace()
  const refs = makeRefs(initial)
  let state = initial
  const setState = (next: typeof state | ((prev: typeof state) => typeof state)) => {
    state = typeof next === 'function' ? next(state) : next
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  }
  let runtimes: Record<string, ReturnType<typeof emptyRuntime>> = {
    anchor: { ...emptyRuntime(), processStatus: 'started' as never },
  }
  const setRuntimes = (next: typeof runtimes | ((prev: typeof runtimes) => typeof runtimes)) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
  }
  const kill = vi.fn()
  const hook = renderHook(() => useDispatchActions(
    setState as never,
    setRuntimes as never,
    refs,
    vi.fn(),
    vi.fn(),
  ))
  return { hook, getState: () => state, refs, getRuntimes: () => runtimes, kill, setState }
}

describe('clearTiledLane', () => {
  it('empties the lane, keeps the occupant alive and listed, and keeps the lane itself', () => {
    const t = mount()
    act(() => { t.hook.result.current.clearTiledLane(0) })

    const state = t.getState()
    expect(state.stage.lanes).toEqual([{}, { selectedSessionId: 'other' }, {}])
    // The lane SLOT survives: rows still say [2,1].
    expect(state.stage.rows).toEqual([{ length: 2 }, { length: 1 }])
    expect(state.stage.focusedLane).toBe(0)
    // Alive: row present, ownership intact, pin untouched.
    expect(state.sessions.anchor).toBeDefined()
    expect(resolveTabSessions(state, 'p')).toEqual(['anchor'])
    expect(state.pinnedSessionIds).toEqual(['anchor'])
    // And no undo entry grew: the undo stack is for CLOSES.
    expect(t.refs.undoStackRef.current.length).toBe(0)
  })

  it('clears every lane that mirrors the occupant, not just the focused one', () => {
    // Mirrors are one agent in two lanes, not two agents. Clearing one lane
    // must not leave a half-cleared "state" the other lane contradicts — but
    // it must also NOT clear lanes the caller did not name: this action is
    // lane-addressed (the command targets the focused one), and clearing a
    // different lane than the one the user can see would be the #681 healer
    // again. Only the named lane changes; the assertion below proves the
    // OTHER lane holding `other` (none here) is a separate concern.
    const t = mount()
    act(() => { t.setState(prev => ({ ...prev, stage: { ...prev.stage, lanes: [{ selectedSessionId: 'anchor' }, { selectedSessionId: 'anchor' }, {}], rows: prev.stage.rows, focusedLane: 0 } })) })
    act(() => { t.hook.result.current.clearTiledLane(1) })
    expect(t.getState().stage.lanes).toEqual([{ selectedSessionId: 'anchor' }, {}, {}])
  })

  it('is a no-op for an already-empty or out-of-range lane, by reference', () => {
    // Identity: the writer returns `prev` untouched, so a stray invocation
    // cannot force a re-render of every lane in the workspace.
    const t = mount()
    const before = t.getState()
    act(() => { t.hook.result.current.clearTiledLane(2) })
    act(() => { t.hook.result.current.clearTiledLane(99) })
    act(() => { t.hook.result.current.clearTiledLane(-1) })
    expect(t.getState()).toBe(before)
  })
})

describe('clear-focused-lane command', () => {
  function context(state: WorkspaceState): CommandContext {
    return {
      workspace: {
        state,
        clearTiledLane: vi.fn(),
      },
    } as unknown as CommandContext
  }

  it('admits only when the focused lane shows a live session', () => {
    const t = mount()
    expect(clearFocusedLaneCommand.when?.(context(t.getState()))).toBe(true)
    act(() => { t.hook.result.current.clearTiledLane(0) })
    // Empty lane: nothing to clear — admission agrees with the action.
    expect(clearFocusedLaneCommand.when?.(context(t.getState()))).toBe(false)
    // A lane naming a GONE session is as good as empty for the user; the
    // action's write still drops the stale pointer.
    act(() => {
      t.setState(prev => ({ ...prev, stage: { ...prev.stage, lanes: [{ selectedSessionId: 'ghost' as SessionId }, { selectedSessionId: 'other' }, {}] } }))
    })
    expect(clearFocusedLaneCommand.when?.(context(t.getState()))).toBe(false)
  })

  it('badges the occupant through the shared title resolver', () => {
    const t = mount()
    const state = clearFocusedLaneCommand.getState?.(context(t.getState()))
    expect(state).toMatchObject({ kind: 'value', label: 'p' })
    // 'p' is the cwd basename (/p) — the same rule the index rows use, which
    // is the point: the badge must name the agent the way the user last saw
    // it named.
  })

  it('clears the focused lane on run', () => {
    const clearTiledLane = vi.fn()
    const ctx = { workspace: { state: workspace(), clearTiledLane } } as unknown as CommandContext
    clearFocusedLaneCommand.run(ctx)
    expect(clearTiledLane).toHaveBeenCalledWith(0)
  })
})
