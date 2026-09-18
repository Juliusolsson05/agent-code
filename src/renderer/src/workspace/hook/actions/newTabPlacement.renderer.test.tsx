import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import { useTabActions } from '@renderer/workspace/hook/actions/tab'
import {
  makeRefs,
  sessionActionsWithSpawn,
  stateWriter,
} from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'

// Where a new project's first agent appears (#992).
//
// This is the rule that lets a fresh install show its one agent without
// bootstrap knowing that lanes exist. Until the stage became a required field,
// bootstrap entered Tiled Dispatch after creating the first tab, and THAT
// action seeded lane 0. With the action gone the seed had to live somewhere,
// and the honest home is the spawn itself: "the agent you just asked for
// appears where you are looking — unless something is already there".
//
// It is mounted through the real hook rather than asserted on a reducer copy,
// because the bootstrap suite's own newTab is a stand-in: if this rule broke,
// that suite would keep passing.

function workspace(stage: TiledDispatchState): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-a', title: 'app',  
    }],
    activeTabId: 'tab-a',
    stage,
    sessions: { a1: { cwd: '/work/app', kind: 'claude', projectId: 'tab-a', joinedAt: 0 } },
    pinnedSessionIds: [],
  }
}

function mount(initial: WorkspaceState) {
  const refs = makeRefs(initial)
  const writer = stateWriter(initial, refs)
  const spawn = vi.fn().mockResolvedValue('new-session')
  const hook = renderHook(() => useTabActions(
    initial,
    writer.setState,
    vi.fn(),
    vi.fn(),
    refs,
    vi.fn(),
    sessionActionsWithSpawn(spawn),
  ))
  return { hook, getState: writer.getState }
}

describe('newTab places the first agent of a new project', () => {
  it('fills the fresh stage s single empty lane — the fresh-install shape', async () => {
    const initial = { ...workspace(freshStage()), tabs: [], sessions: {}, activeTabId: '' }
    const { hook, getState } = mount(initial)

    await act(async () => { await hook.result.current.newTab('/work/first') })

    expect(getState().stage.lanes).toEqual([{ selectedSessionId: 'new-session' }])
    expect(getState().stage.rows).toEqual([{ length: 1 }])
    expect(getState().stage.focusedLane).toBe(0)
  })

  it('takes the FOCUSED lane when it is empty, not the first empty lane', async () => {
    const { hook, getState } = mount(workspace({
      lanes: [{}, { selectedSessionId: 'a1' }, {}],
      rows: [{ length: 3 }],
      focusedLane: 2,
    }))

    await act(async () => { await hook.result.current.newTab('/work/second') })

    expect(getState().stage.lanes).toEqual([{}, { selectedSessionId: 'a1' }, { selectedSessionId: 'new-session' }])
  })

  it('never displaces an occupied focused lane', async () => {
    // The agent the user is commanding stays exactly where it is. The new
    // project is active and its agent is in the pool, at the top of its index.
    const stage: TiledDispatchState = {
      lanes: [{ selectedSessionId: 'a1' }, {}],
      rows: [{ length: 2 }],
      focusedLane: 0,
    }
    const { hook, getState } = mount(workspace(stage))

    const created = await act(async () => hook.result.current.newTab('/work/second'))

    // Same reference: not rebuilt, so lane memos do not churn on ⌘T either.
    expect(getState().stage).toBe(stage)
    expect(getState().activeTabId).toBe(created.tabId)
  })
})
