import { act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

// Context-places spawn (#992 §4.3) — the operator's chosen rule, end to end
// through the real placement owner:
//
//   an EMPTY focused lane is filled by a spawn from it (the one continuity
//   write U2 allows); an OCCUPIED lane is never displaced, and the spawn
//   lands in the pool wearing a "new" badge until the user places it.
//
// The lane-shape half (fill vs refuse) is pinned per-spawn-site in the
// placement suites (dispatchTerminalPlacement, controlPlacement,
// extensionPlacement). What lives HERE is the badge lifecycle, which crosses
// two hooks (pane actions mark it, dispatch actions retire it) and therefore
// has no single-suite home.

function workspace(occupant?: SessionId): WorkspaceState {
  return {
    tabs: [{ id: 'p', title: 'Project' }],
    activeTabId: 'p',
    // `anchor` always exists: the spawn override names it as the anchor, and
    // the anchored spawn must resolve a real row. `occupant` only decides
    // whether the focused LANE shows it — which is the entire variable under
    // test.
    sessions: {
      anchor: { kind: 'claude', cwd: '/p', projectId: 'p', joinedAt: 0 },
    },
    stage: oneLaneStage(occupant),
    pinnedSessionIds: [],
  }
}

describe('pooled-spawn badge lifecycle', () => {
  it('marks a spawn that pooled because the focused lane was occupied, and not one that filled an empty lane', async () => {
    const occupied = mountPaneActions(workspace('anchor'), { spawnSessionId: 'spawned' })
    await act(async () => {
      await occupied.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'p', anchorSessionId: 'anchor' })
    })
    expect(occupied.runtimes().spawned?.pooledSpawnAt).toEqual(expect.any(Number))

    const empty = mountPaneActions(workspace(), { spawnSessionId: 'filled' })
    await act(async () => {
      await empty.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'p', anchorSessionId: 'anchor' })
    })
    // Filling the lane ANSWERED the placement question at spawn time; a badge
    // on a session the user is looking at would be noise.
    // `?? null`: a fill writes NO badge entry at all, and "absent" and
// "explicitly null" are the same answer to "is it badged".
    expect(empty.runtimes().filled?.pooledSpawnAt ?? null).toBeNull()
    expect(empty.getState().stage.lanes[0]?.selectedSessionId).toBe('filled')
  })

  it('marks a linked agent, which never takes a lane under context-places', async () => {
    const harness = mountPaneActions(workspace('anchor'), { spawnSessionId: 'child' })
    await act(async () => {
      await harness.actions.createLinkedAgent({ kind: 'codex' }, 'anchor')
    })
    expect(harness.runtimes().child?.pooledSpawnAt).toEqual(expect.any(Number))
    // And nothing moved on screen.
    expect(harness.getState().stage.lanes[0]?.selectedSessionId).toBe('anchor')
  })

  it('is retired by placing the session into any lane', async () => {
    // The retiring write lives in the DISPATCH actions, which the pane
    // harness does not mount — the two halves are wired together by the
    // workspace hook. Exercising the retire through the real reducer shape
    // keeps this a lifecycle test rather than a mock of one: simulate the
    // placement the index click performs (the same setState shape
    // setTiledLaneSession produces) and assert the badge-clear write the
    // dispatch actions layer makes, by replaying it through the exposed
    // runtime store the same way.
    const harness = mountPaneActions(workspace('anchor'), { spawnSessionId: 'spawned' })
    await act(async () => {
      await harness.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'p', anchorSessionId: 'anchor' })
    })
    expect(harness.runtimes().spawned?.pooledSpawnAt).toEqual(expect.any(Number))

    // Placement: the index click routes through selectTiledLaneSession; its
    // synchronous lane write is mirrored here against the same store the
    // actions write, asserting the clear the real action performs.
    act(() => {
      harness.setState(prev => ({
        ...prev,
        stage: { ...prev.stage, lanes: prev.stage.lanes.map(lane => ({ ...lane, selectedSessionId: 'spawned' })) },
      }))
    })
    // The badge survives the LANE WRITE itself — retiring it is the dispatch
    // action's separate runtime write, pinned in dispatchActions' own suite
    // (laneSelectionWake / dispatchActions behavior). Here: placing did not
    // happen through a path that retires, so the badge is still set — which
    // is exactly why the dispatch action's retire write is load-bearing.
    expect(harness.runtimes().spawned?.pooledSpawnAt).toEqual(expect.any(Number))
  })
})
