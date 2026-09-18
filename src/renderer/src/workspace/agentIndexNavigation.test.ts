import { describe, expect, it } from 'vitest'

import { navigateToAgentIndexTarget } from '@renderer/workspace/agentIndexNavigation'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function split(a: string, b: string): TileNode {
  return {
    type: 'split',
    direction: 'vertical',
    ratio: 0.37,
    a: leaf(a),
    b: leaf(b),
  }
}

function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'alpha', root: split('a1', 'a2'), focusedSessionId: 'a1' },
      { id: 'tab-b', title: 'beta', root: leaf('b1'), focusedSessionId: 'b1' },
      { id: 'tab-c', title: 'gamma', root: leaf('c1'), focusedSessionId: 'c1' },
    ],
    activeTabId: 'tab-a',
    gridRelatedSelections: {},
    stage: oneLaneStage('a1'),
    sessions: {
      a1: { cwd: '/work/alpha/one', kind: 'claude' },
      a2: { cwd: '/work/alpha/two', kind: 'codex' },
      a3: { cwd: '/work/alpha/three', kind: 'claude' },
      b1: { cwd: '/work/beta/one', kind: 'codex' },
      c1: { cwd: '/work/gamma/one', kind: 'opencode' },
    },
    detachedSessions: {
      a3: {
        sessionId: 'a3',
        surface: 'dispatch',
        projectTabId: 'tab-a',
        projectTabTitle: 'alpha',
        projectTabIndex: 0,
        detachedAt: 10,
      },
    },
    buried: [],
    pinnedSessionIds: [],
  }
}

function target(state: WorkspaceState, label: string) {
  const resolved = resolveAgentPaneLabel(state, label)
  if (!resolved) throw new Error(`Missing test target ${label}`)
  return resolved
}

describe('agent index navigation', () => {
  it('focuses an existing Tiled Dispatch lane without changing any lane selection', () => {
    const state = makeState()
    state.stage = {
      focusedLane: 0,
      ratios: [0.2, 0.4, 0.4],
      lanes: [
        { selectedSessionId: 'a1' },
        { selectedSessionId: 'b1' },
      ],
    }

    const result = navigateToAgentIndexTarget(state, target(state, 'B1'))
    expect(result?.kind).toBe('focus-existing-tiled-dispatch-lane')
    expect(result?.state.stage.focusedLane).toBe(1)
    expect(result?.state.stage.lanes).toEqual(state.stage.lanes)
    expect(result?.state.stage.ratios).toEqual([0.2, 0.4, 0.4])
  })

  it('fills the focused empty lane when the bang intent names an agent', () => {
    // The ORDINARY way to fill the lane New Lane just created: create the empty
    // lane, focus it, type A2!. Pinned here rather than only at withLaneSession
    // because the helper cannot notice a caller that stops using it — and one
    // did. This path used to spread the lane directly and keep the old
    // `userEmptied` marker, so the lane rendered fine but became a hole the
    // healer skipped forever once that agent exited. Both the marker and the
    // healer are gone (#681); what remains worth asserting is that the bang
    // intent writes into the FOCUSED lane rather than discovering some other
    // lane already showing A2.
    const state = makeState()
    state.stage = {
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a1' }, {}],
    }

    const result = navigateToAgentIndexTarget(
      state,
      target(state, 'A2'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.state.stage.focusedLane).toBe(1)
    expect(result?.state.stage.lanes[1])
      .toEqual({ selectedSessionId: 'a2' })
  })

  it('opens an already-visible agent in the focused Tiled Dispatch lane for the bang intent', () => {
    const state = makeState()
    state.stage = {
      focusedLane: 0,
      ratios: [0.2, 0.4, 0.4],
      lanes: [
        { selectedSessionId: 'a1' },
        { selectedSessionId: 'a2' },
        { selectedSessionId: 'b1' },
      ],
    }

    const result = navigateToAgentIndexTarget(
      state,
      target(state, 'A2'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.kind).toBe('replace-focused-tiled-dispatch-lane')
    expect(result?.state.stage).toEqual({
      focusedLane: 0,
      ratios: [0.2, 0.4, 0.4],
      lanes: [
        { selectedSessionId: 'a2' },
        { selectedSessionId: 'a2' },
        { selectedSessionId: 'b1' },
      ],
    })
    // Both lanes mirror one durable session. Forced placement is a view
    // operation, so it must never rewrite provider ownership metadata.
    expect(result?.state.sessions.a2).toBe(state.sessions.a2)
    expect(result?.requiresWake).toBe(false)
  })

  it('replaces only the focused Tiled Dispatch lane when the agent is absent', () => {
    const state = makeState()
    state.stage = {
      focusedLane: 1,
      lanes: [
        { selectedSessionId: 'a1' },
        { selectedSessionId: 'b1' },
      ],
    }

    const result = navigateToAgentIndexTarget(state, target(state, 'A3'))
    expect(result?.kind).toBe('replace-focused-tiled-dispatch-lane')
    expect(result?.state.stage.lanes).toEqual([
      { selectedSessionId: 'a1' },
      { selectedSessionId: 'a3' },
    ])
    expect(result?.state.stage.focusedLane).toBe(1)
    expect(result?.requiresWake).toBe(true)
  })

  it('keeps the focused copy when a target appears in more than one Tiled Dispatch lane', () => {
    const state = makeState()
    state.stage = {
      focusedLane: 2,
      lanes: [
        { selectedSessionId: 'b1' },
        { selectedSessionId: 'a1' },
        { selectedSessionId: 'b1' },
      ],
    }

    const result = navigateToAgentIndexTarget(state, target(state, 'B1'))
    expect(result?.kind).toBe('focus-existing-tiled-dispatch-lane')
    expect(result?.state.stage.focusedLane).toBe(2)
  })

  // Two classic-Dispatch cases lived here until #992: "selects a target in
  // classic Dispatch without changing grid focus" and "degrades the bang
  // intent to ordinary navigation outside Tiled Dispatch". Both exercised the
  // 'focus-classic-dispatch' kind, which was the fallback for a Dispatch with
  // no lanes. The stage is a required field, so that state — and the kind —
  // can no longer be constructed.

  it('moves the active project on a cross-project swap and keeps untouched lanes resolvable', () => {
    const state = makeState()
    state.stage = {
      focusedLane: 1,
      lanes: [
        { selectedSessionId: 'a1' },
        { selectedSessionId: 'a2' },
      ],
    }

    const result = navigateToAgentIndexTarget(state, target(state, 'B1'))

    // This used to assert a promotion of the layout-wide scope to 'global':
    // project-scoped rows derived from activeTabId, so moving it would have
    // blanked lane 0. With no scope, the property that mattered is asserted
    // directly — the active project moves AND the untouched lane's agent is
    // still in the visible rows.
    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.state.stage.lanes).toEqual([
      { selectedSessionId: 'a1' },
      { selectedSessionId: 'b1' },
    ])
    expect(buildVisibleDispatchRows(result!.state).map(row => row.sessionId)).toContain('a1')
  })

  it('mirrors a forced cross-project target while retaining the existing copy', () => {
    const state = makeState()
    state.stage = {
      focusedLane: 0,
      lanes: [
        { selectedSessionId: 'a1' },
        // The forced intent must ignore this existing copy rather than
        // jump focus to it: `B1!` means "here", in the focused lane.
        { selectedSessionId: 'b1' },
      ],
    }

    const result = navigateToAgentIndexTarget(
      state,
      target(state, 'B1'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.state.stage.lanes).toEqual([
      { selectedSessionId: 'b1' },
      { selectedSessionId: 'b1' },
    ])
  })

  it('moves a detached terminal into the focused Tiled Dispatch lane (#865)', () => {
    // Mirrors "replaces only the focused Tiled Dispatch lane when the agent is
    // absent" above, but with a terminal target: #865 widened the label/index
    // guard from AgentProviderKind to SessionKind, and Tiled Dispatch lanes
    // must accept a terminal exactly like an agent — there is nothing in the
    // lane-selection path that is agent-specific.
    const state = makeState()
    state.sessions.a4 = { cwd: '/work/alpha/term', kind: 'terminal' }
    state.detachedSessions.a4 = {
      sessionId: 'a4',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 20,
    }
    state.stage = {
      focusedLane: 1,
      lanes: [
        { selectedSessionId: 'a1' },
        { selectedSessionId: 'b1' },
      ],
    }

    const result = navigateToAgentIndexTarget(state, target(state, 'A4'))
    expect(result?.kind).toBe('replace-focused-tiled-dispatch-lane')
    expect(result?.state.stage.lanes).toEqual([
      { selectedSessionId: 'a1' },
      { selectedSessionId: 'a4' },
    ])
    expect(result?.state.stage.focusedLane).toBe(1)
    expect(result?.requiresWake).toBe(true)
  })

})
