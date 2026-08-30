import { describe, expect, it } from 'vitest'

import { navigateToAgentIndexTarget } from '@renderer/workspace/agentIndexNavigation'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveAgentPaneLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { TileNode, TileTabsState, WorkspaceState } from '@renderer/workspace/types'

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
    dispatchMode: null,
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
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 0,
        ratios: [0.2, 0.4, 0.4],
        lanes: [
          { selectedSessionId: 'a1' },
          { selectedSessionId: 'b1' },
        ],
      },
    }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'B1'))
    expect(result?.kind).toBe('focus-existing-tiled-dispatch-lane')
    expect(result?.state.dispatchMode?.tiled?.focusedLane).toBe(1)
    expect(result?.state.dispatchMode?.tiled?.lanes).toEqual(
      state.dispatchMode.tiled?.lanes,
    )
    expect(result?.state.dispatchMode?.tiled?.ratios).toEqual([0.2, 0.4, 0.4])
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
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a1' }, {}],
      },
    }

    const result = navigateToAgentIndexTarget(
      state,
      null,
      target(state, 'A2'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.state.dispatchMode?.tiled?.focusedLane).toBe(1)
    expect(result?.state.dispatchMode?.tiled?.lanes[1])
      .toEqual({ selectedSessionId: 'a2' })
  })

  it('opens an already-visible agent in the focused Tiled Dispatch lane for the bang intent', () => {
    const state = makeState()
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 0,
        ratios: [0.2, 0.4, 0.4],
        lanes: [
          { selectedSessionId: 'a1' },
          { selectedSessionId: 'a2' },
          { selectedSessionId: 'b1' },
        ],
      },
    }

    const result = navigateToAgentIndexTarget(
      state,
      null,
      target(state, 'A2'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.kind).toBe('replace-focused-tiled-dispatch-lane')
    expect(result?.state.dispatchMode?.tiled).toEqual({
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
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'a1' },
          { selectedSessionId: 'b1' },
        ],
      },
    }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'A3'))
    expect(result?.kind).toBe('replace-focused-tiled-dispatch-lane')
    expect(result?.state.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'a1' },
      { selectedSessionId: 'a3' },
    ])
    expect(result?.state.dispatchMode?.tiled?.focusedLane).toBe(1)
    expect(result?.requiresWake).toBe(true)
  })

  it('keeps the focused copy when a target appears in more than one Tiled Dispatch lane', () => {
    const state = makeState()
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'b1',
      tiled: {
        focusedLane: 2,
        lanes: [
          { selectedSessionId: 'b1' },
          { selectedSessionId: 'a1' },
          { selectedSessionId: 'b1' },
        ],
      },
    }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'B1'))
    expect(result?.kind).toBe('focus-existing-tiled-dispatch-lane')
    expect(result?.state.dispatchMode?.tiled?.focusedLane).toBe(2)
  })

  it('selects a target in classic Dispatch without changing grid focus', () => {
    const state = makeState()
    state.dispatchMode = { scope: 'global', focusedSessionId: 'a1' }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'B1'))
    expect(result?.kind).toBe('focus-classic-dispatch')
    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.state.dispatchMode?.focusedSessionId).toBe('b1')
    expect(result?.state.tabs[0].focusedSessionId).toBe('a1')
  })

  it('degrades the bang intent to ordinary navigation outside Tiled Dispatch', () => {
    const state = makeState()
    state.dispatchMode = { scope: 'global', focusedSessionId: 'a1' }

    const result = navigateToAgentIndexTarget(
      state,
      null,
      target(state, 'B1'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.kind).toBe('focus-classic-dispatch')
    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.state.dispatchMode?.focusedSessionId).toBe('b1')
  })

  it('keeps bang navigation equivalent to ordinary navigation in grid and Tiled Tabs', () => {
    const gridState = makeState()
    const gridTarget = target(gridState, 'B1')
    expect(navigateToAgentIndexTarget(
      gridState,
      null,
      gridTarget,
      'open-in-focused-tiled-dispatch-lane',
    )).toEqual(navigateToAgentIndexTarget(gridState, null, gridTarget))

    const tiledTabsState = makeState()
    const tileTabs: TileTabsState = {
      tabIds: ['tab-a', 'tab-b'],
      focusedTabId: 'tab-a',
      direction: 'horizontal',
      ratios: [0.41, 0.59],
    }
    const tiledTabsTarget = target(tiledTabsState, 'B1')
    // WHY compare the complete reducer result instead of only its kind: the
    // fallback contract includes tab membership, focus, ratios, wake state,
    // and the workspace mutation. A future early bang branch must not drift
    // any of those fields on surfaces where focused-lane placement is absent.
    expect(navigateToAgentIndexTarget(
      tiledTabsState,
      tileTabs,
      tiledTabsTarget,
      'open-in-focused-tiled-dispatch-lane',
    )).toEqual(navigateToAgentIndexTarget(
      tiledTabsState,
      tileTabs,
      tiledTabsTarget,
    ))
  })

  it('focuses an already tiled tab and preserves membership, direction, and ratios', () => {
    const state = makeState()
    const tileTabs: TileTabsState = {
      tabIds: ['tab-a', 'tab-b'],
      focusedTabId: 'tab-a',
      direction: 'horizontal',
      ratios: [0.41, 0.59],
    }

    const result = navigateToAgentIndexTarget(state, tileTabs, target(state, 'B1'))
    expect(result?.kind).toBe('focus-tiled-tab-pane')
    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.tileTabs).toEqual({
      ...tileTabs,
      focusedTabId: 'tab-b',
    })
  })

  it('uses the focused Tiled Tab slot for a target owned by a non-tiled tab', () => {
    const state = makeState()
    const tileTabs: TileTabsState = {
      tabIds: ['tab-a', 'tab-b'],
      focusedTabId: 'tab-b',
      direction: 'vertical',
      ratios: [0.3, 0.7],
    }

    const result = navigateToAgentIndexTarget(state, tileTabs, target(state, 'C1'))
    expect(result?.kind).toBe('replace-focused-tiled-tab')
    expect(result?.tileTabs).toEqual({
      tabIds: ['tab-a', 'tab-c'],
      focusedTabId: 'tab-c',
      direction: 'vertical',
      ratios: [0.3, 0.7],
    })
    expect(result?.state.tabs.find(tab => tab.id === 'tab-c')?.focusedSessionId).toBe('c1')
  })

  it('activates and focuses an existing pane in the regular grid', () => {
    const state = makeState()
    const result = navigateToAgentIndexTarget(state, null, target(state, 'B1'))
    expect(result?.kind).toBe('focus-grid-pane')
    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.state.tabs.find(tab => tab.id === 'tab-b')?.focusedSessionId).toBe('b1')
  })

  it('focuses a related agent already rendered inside its owner pane', () => {
    const state = makeState()
    state.sessions.child = {
      cwd: '/work/alpha/child',
      kind: 'codex',
      linkedParentId: 'a2',
    }
    state.detachedSessions.child = {
      sessionId: 'child',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 20,
    }
    state.gridRelatedSelections = { a2: 'child' }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'A4'))
    expect(result?.kind).toBe('focus-grid-pane')
    expect(result?.state.tabs[0].focusedSessionId).toBe('a2')
    expect(result?.state.gridRelatedSelections).toEqual({ a2: 'child' })
  })

  it('selects a physical pane owner when that pane currently shows a related child', () => {
    const state = makeState()
    state.sessions.child = {
      cwd: '/work/alpha/child',
      kind: 'codex',
      linkedParentId: 'a2',
    }
    state.detachedSessions.child = {
      sessionId: 'child',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 20,
    }
    state.gridRelatedSelections = { a2: 'child' }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'A2'))
    expect(result?.kind).toBe('focus-grid-pane')
    expect(result?.state.tabs[0].focusedSessionId).toBe('a2')
    expect(result?.state.gridRelatedSelections).toEqual({})
  })

  it('swaps a detached target into the focused grid leaf without reshaping the grid', () => {
    const state = makeState()
    const result = navigateToAgentIndexTarget(state, null, target(state, 'A3'))
    expect(result?.kind).toBe('swap-detached-into-focused-grid-pane')
    expect(result?.requiresWake).toBe(true)
    expect(result?.state.tabs[0].root).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.37,
      a: leaf('a3'),
      b: leaf('a2'),
    })
    expect(result?.state.tabs[0].focusedSessionId).toBe('a3')
    expect(result?.state.detachedSessions.a3).toBeUndefined()
    expect(result?.state.detachedSessions.a1).toMatchObject({
      sessionId: 'a1',
      projectTabId: 'tab-a',
      detachedAt: 10,
    })
    expect(resolveAgentPaneLabel(result!.state, 'A3')?.sessionId).toBe('a1')
    expect(result?.state.sessions.a1).toBe(state.sessions.a1)
    expect(result?.state.sessions.a3).toBe(state.sessions.a3)
  })

  it('swaps a detached target into the focused pane of the focused Tiled Tab', () => {
    const state = makeState()
    const tileTabs: TileTabsState = {
      tabIds: ['tab-a', 'tab-b'],
      focusedTabId: 'tab-b',
      direction: 'vertical',
      ratios: [0.5, 0.5],
    }

    const result = navigateToAgentIndexTarget(state, tileTabs, target(state, 'A3'))
    expect(result?.kind).toBe('swap-detached-into-focused-grid-pane')
    expect(result?.tileTabs).toEqual(tileTabs)
    expect(result?.state.tabs.find(tab => tab.id === 'tab-b')?.root).toEqual(leaf('a3'))
    expect(result?.state.detachedSessions.b1).toMatchObject({
      sessionId: 'b1',
      projectTabId: 'tab-a',
      detachedAt: 10,
    })
  })

  it('preserves every other detached coordinate when swapping a target into the grid', () => {
    const state = makeState()
    state.sessions.a4 = { cwd: '/work/alpha/four', kind: 'codex' }
    state.detachedSessions.a4 = {
      sessionId: 'a4',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 20,
    }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'A3'))

    expect(resolveAgentPaneLabel(result!.state, 'A3')?.sessionId).toBe('a1')
    expect(resolveAgentPaneLabel(result!.state, 'A4')?.sessionId).toBe('a4')
    expect(result?.state.detachedSessions.a4).toBe(state.detachedSessions.a4)
  })

  it('promotes a cross-project Tiled Dispatch swap so untouched lanes stay in scope', () => {
    const state = makeState()
    state.dispatchMode = {
      scope: 'project',
      focusedSessionId: 'a2',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'a1' },
          { selectedSessionId: 'a2' },
        ],
      },
    }

    const result = navigateToAgentIndexTarget(state, null, target(state, 'B1'))

    expect(result?.state.dispatchMode?.scope).toBe('global')
    expect(result?.state.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'a1' },
      { selectedSessionId: 'b1' },
    ])
    expect(buildVisibleDispatchRows(result!.state).map(row => row.sessionId)).toContain('a1')
  })

  it('promotes a forced cross-project mirror while retaining the existing copy', () => {
    const state = makeState()
    state.dispatchMode = {
      scope: 'project',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 0,
        lanes: [
          { selectedSessionId: 'a1' },
          // Restored layouts can temporarily retain an out-of-scope lane. The
          // forced intent must ignore this existing copy, then promote scope
          // before the layout healer evaluates either mirrored lane.
          { selectedSessionId: 'b1' },
        ],
      },
    }

    const result = navigateToAgentIndexTarget(
      state,
      null,
      target(state, 'B1'),
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(result?.state.activeTabId).toBe('tab-b')
    expect(result?.state.dispatchMode?.scope).toBe('global')
    expect(result?.state.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'b1' },
      { selectedSessionId: 'b1' },
    ])
  })

  it('follows visible Tiled Tabs when stale restored state also contains Dispatch', () => {
    const state = makeState()
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 0,
        lanes: [{ selectedSessionId: 'a1' }],
      },
    }
    const tileTabs: TileTabsState = {
      tabIds: ['tab-a', 'tab-b'],
      focusedTabId: 'tab-a',
      direction: 'horizontal',
      ratios: [0.5, 0.5],
    }
    const resolved = resolveAgentPaneLabel(state, 'B1', tileTabs)
    if (!resolved) throw new Error('Missing B1 target')

    const result = navigateToAgentIndexTarget(state, tileTabs, resolved)

    expect(result?.kind).toBe('focus-tiled-tab-pane')
    expect(result?.tileTabs?.focusedTabId).toBe('tab-b')
    expect(result?.state.dispatchMode).toBe(state.dispatchMode)
  })
})
