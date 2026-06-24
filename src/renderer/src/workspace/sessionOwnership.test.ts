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
})
