import { describe, expect, it } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  resolveAgentPaneLabel,
  tabIndexLabel,
} from '@renderer/workspace/tile-tree/paneLabels'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function split(a: string, b: string): TileNode {
  return {
    type: 'split',
    direction: 'vertical',
    ratio: 0.5,
    a: leaf(a),
    b: leaf(b),
  }
}

function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'alpha', root: split('terminal', 'agent-a'), focusedSessionId: 'agent-a' },
      { id: 'tab-b', title: 'beta', root: leaf('agent-b'), focusedSessionId: 'agent-b' },
    ],
    activeTabId: 'tab-a',
    stage: oneLaneStage('agent-a'),
    sessions: {
      terminal: { cwd: '/work/alpha', kind: 'terminal' },
      'agent-a': { cwd: '/work/alpha', kind: 'codex', title: 'Review UI' },
      'agent-b': { cwd: '/work/beta', kind: 'claude' },
      detached: { cwd: '/work/alpha/background', kind: 'opencode' },
    },
    detachedSessions: {
      detached: {
        sessionId: 'detached',
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

describe('resolveAgentPaneLabel', () => {
  it('matches exact labels case-insensitively without collapsing terminal positions', () => {
    expect(resolveAgentPaneLabel(makeState(), '  a2  ')).toMatchObject({
      label: 'A2',
      sessionId: 'agent-a',
      title: 'Review UI',
      kind: 'codex',
    })
  })

  it('uses the canonical detached ordering after grid leaves', () => {
    expect(resolveAgentPaneLabel(makeState(), 'a3')).toMatchObject({
      label: 'A3',
      sessionId: 'detached',
      tabId: 'tab-a',
      kind: 'opencode',
    })
  })

  it('resolves a terminal by its own label (#865)', () => {
    // #546 made labels agent-only; a shell kept its coordinate but could not be
    // jumped to, while Dispatch ⌘N and ⌥↑/↓ already selected it. One rule now.
    expect(resolveAgentPaneLabel(makeState(), 'A1')).toMatchObject({
      label: 'A1',
      sessionId: 'terminal',
      kind: 'terminal',
      title: 'alpha',
    })
  })

  it('rejects incomplete labels, zero indexes, and stale coordinates', () => {
    const state = makeState()
    expect(resolveAgentPaneLabel(state, 'A')).toBeNull()
    expect(resolveAgentPaneLabel(state, '2')).toBeNull()
    expect(resolveAgentPaneLabel(state, 'A0')).toBeNull()
    expect(resolveAgentPaneLabel(state, 'Z9')).toBeNull()
  })

  it('resolves the exact globally numbered labels rendered by Dispatch', () => {
    const state = makeState()
    state.stage = { lanes: [{ selectedSessionId: 'agent-a' }], rows: [{ length: 1 }], focusedLane: 0 }

    // Every visible row resolves to itself, terminals included (#865).
    const rows = buildVisibleDispatchRows(state)
    expect(rows.some(row => row.kind === 'terminal')).toBe(true)
    for (const row of rows) {
      expect(resolveAgentPaneLabel(state, row.label)?.sessionId).toBe(row.sessionId)
    }
  })

  it('lets Dispatch row order override a conflicting pane-local coordinate', () => {
    const state = makeState()
    state.tabs[0] = {
      ...state.tabs[0],
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: leaf('agent-a'),
        b: leaf('agent-late'),
      },
    }
    state.sessions['agent-late'] = { cwd: '/work/alpha/late', kind: 'claude' }
    state.sessions.child = {
      cwd: '/work/alpha/child',
      kind: 'codex',
      linkedParentId: 'agent-a',
    }
    state.detachedSessions.child = {
      sessionId: 'child',
      surface: 'dispatch',
      projectTabId: 'tab-a',
      projectTabTitle: 'alpha',
      projectTabIndex: 0,
      detachedAt: 5,
    }
    state.stage = { lanes: [{ selectedSessionId: 'agent-a' }], rows: [{ length: 1 }], focusedLane: 0 }

    // Pane-local A2 would be agent-late, but the index visibly nests child at
    // A2 — and the label beside an agent must resolve to THAT agent.
    //
    // A third assertion lived here until #992: with Dispatch OFF the same
    // state resolved A2 to agent-late, through the pane-local fallback. The
    // index is always on now, so the visible label always wins; the fallback
    // only ever answers for a label the index does not offer.
    expect(buildVisibleDispatchRows(state).find(row => row.label === 'A2')?.sessionId)
      .toBe('child')
    expect(resolveAgentPaneLabel(state, 'A2')?.sessionId).toBe('child')
  })

  it('keeps spreadsheet-style labels beyond the first 26 tabs', () => {
    expect(tabIndexLabel(25)).toBe('Z')
    expect(tabIndexLabel(26)).toBe('AA')
    expect(tabIndexLabel(27)).toBe('AB')
  })
})
