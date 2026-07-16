import { describe, expect, it } from 'vitest'

import { pruneSessionOwnership } from '@renderer/workspace/sessionOwnership'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'

function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: leaf('live'), focusedSessionId: 'live' },
    ],
    activeTabId: 'tabA',
    dispatchMode: {
      scope: 'project',
      focusedSessionId: 'missing',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'live' },
          { selectedSessionId: 'missing' },
        ],
      },
    },
    sessions: {
      live: { cwd: '/work/project-a', kind: 'claude' },
      missing: { cwd: '/work/project-a', kind: 'claude' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('pruneSessionOwnership', () => {
  it('clears stale tiled lane ids while preserving lane shape', () => {
    const result = pruneSessionOwnership(makeState())

    expect(result.sessions).toEqual({
      live: { cwd: '/work/project-a', kind: 'claude' },
    })
    expect(result.dispatchMode?.focusedSessionId).toBeUndefined()
    expect(result.dispatchMode?.tiled?.focusedLane).toBe(1)
    expect(result.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'live' },
      { selectedSessionId: undefined },
    ])
  })

  it('drops detached sessions whose project tab no longer exists', () => {
    const state = makeState()
    state.sessions.parked = { cwd: '/work/project-a', kind: 'codex' }
    state.sessions.ghost = { cwd: '/work/deleted-project', kind: 'claude' }
    state.detachedSessions = {
      parked: {
        sessionId: 'parked',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 20,
      },
      ghost: {
        sessionId: 'ghost',
        surface: 'dispatch',
        projectTabId: 'deleted-tab',
        projectTabTitle: 'deleted-project',
        projectTabIndex: 1,
        detachedAt: 10,
      },
    }
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'ghost',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'parked' },
          { selectedSessionId: 'ghost' },
        ],
      },
    }

    const result = pruneSessionOwnership(state)

    expect(result.sessions).toEqual({
      live: { cwd: '/work/project-a', kind: 'claude' },
      parked: { cwd: '/work/project-a', kind: 'codex' },
    })
    expect(result.detachedSessions).toEqual({
      parked: expect.objectContaining({
        sessionId: 'parked',
        projectTabId: 'tabA',
      }),
    })
    expect(result.droppedSessionIds).toEqual(expect.arrayContaining(['missing', 'ghost']))
    expect(result.dispatchMode?.focusedSessionId).toBeUndefined()
    expect(result.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'parked' },
      { selectedSessionId: undefined },
    ])
  })

  it('collapses a production-shaped ghost pool without touching valid hidden ownership', () => {
    const state = makeState()
    for (let index = 0; index < 8; index += 1) {
      const sessionId = `parked-${index}`
      state.sessions[sessionId] = { cwd: '/work/project-a', kind: 'codex' }
      state.detachedSessions[sessionId] = {
        sessionId,
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: index,
      }
    }
    for (let index = 0; index < 82; index += 1) {
      const sessionId = `ghost-${index}`
      state.sessions[sessionId] = { cwd: `/work/deleted-${index}`, kind: 'claude' }
      state.detachedSessions[sessionId] = {
        sessionId,
        surface: 'dispatch',
        projectTabId: `deleted-tab-${index}`,
        projectTabTitle: `deleted-${index}`,
        projectTabIndex: index + 1,
        detachedAt: index,
      }
    }
    state.sessions.buried = { cwd: '/work/archive', kind: 'claude' }
    state.buried = [{
      id: 'buried',
      sessionId: 'buried',
      sessionMeta: state.sessions.buried,
      buriedAt: 1,
      sourceTabId: 'already-closed-source-tab',
      sourceTabTitle: 'archive',
      sourceTabIndex: 2,
    }]

    const result = pruneSessionOwnership(state)

    // WHY use the observed production cardinalities instead of only another
    // one-record example: the bug was initially mistaken for legitimate lazy
    // recovery because the invalid records looked individually well-formed.
    // This fixture locks in the actual distinction—five/eight/etc. is not the
    // algorithm, parent-tab reachability is—while proving an 82-record ghost
    // pool collapses to the real owned workspace in one save cycle.
    expect(Object.keys(result.sessions)).toHaveLength(10)
    expect(Object.keys(result.detachedSessions)).toHaveLength(8)
    expect(result.buried).toHaveLength(1)
    expect(result.sessions).toHaveProperty('live')
    expect(result.sessions).toHaveProperty('buried')
    expect(result.sessions).not.toHaveProperty('ghost-0')
    expect(result.sessions).not.toHaveProperty('ghost-81')
    expect(result.droppedSessionIds).toHaveLength(83)
  })
})
