import { describe, expect, it } from 'vitest'

import {
  keepTiledLaneSessions,
  LANE_HISTORY_LIMIT,
  remapTiledLanes,
  sanitizeLaneHistory,
  withLaneClearedByUser,
  withLaneSession,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { insertLaneIntoGrid, removeLaneFromGrid } from '@renderer/workspace/dispatch/gridShape'
import { migrateWorkspaceToStage } from '@renderer/workspace/workspaceShape'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { DispatchLane, SessionId, TiledDispatchState } from '@renderer/workspace/types'

// Lane History (feat/lane-history). The rules pinned here are the ones a
// regression would break silently: who gets recorded, when, and whether the
// record survives the paths that rebuild lanes (remap, prune, grid edits,
// restart).

const S = (n: string): SessionId => `session-${n}`
const ids = (lane: DispatchLane) => (lane.history ?? []).map(entry => entry.sessionId)

describe('withLaneSession records the agent it replaces', () => {
  it('records the departing agent with the time it LEFT, newest first', () => {
    let lane: DispatchLane = withLaneSession({}, S('a'), 1000)
    // The first agent into an empty lane replaces nobody.
    expect(lane.history).toBeUndefined()

    lane = withLaneSession(lane, S('b'), 2000)
    lane = withLaneSession(lane, S('c'), 3000)

    expect(lane.selectedSessionId).toBe(S('c'))
    expect(lane.history).toEqual([
      { sessionId: S('b'), at: 3000 },
      { sessionId: S('a'), at: 2000 },
    ])
  })

  it('keeps one row per agent, moving a returning agent to the top', () => {
    let lane: DispatchLane = withLaneSession({}, S('a'), 1000)
    lane = withLaneSession(lane, S('b'), 2000)
    lane = withLaneSession(lane, S('a'), 3000)
    lane = withLaneSession(lane, S('c'), 4000)

    // `a` came back (so it left the history: it was the occupant), then left
    // again at 4000. One row for it, at the newest time.
    expect(lane.history).toEqual([
      { sessionId: S('a'), at: 4000 },
      { sessionId: S('b'), at: 3000 },
    ])
  })

  it('never lists the current occupant', () => {
    let lane: DispatchLane = withLaneSession({}, S('a'), 1000)
    lane = withLaneSession(lane, S('b'), 2000)
    lane = withLaneSession(lane, S('a'), 3000)

    expect(lane.selectedSessionId).toBe(S('a'))
    expect(ids(lane)).toEqual([S('b')])
  })

  it('re-selecting the same agent records nothing', () => {
    const lane = withLaneSession(withLaneSession({}, S('a'), 1000), S('a'), 2000)
    expect(lane.history).toBeUndefined()
  })

  it('caps the list at LANE_HISTORY_LIMIT distinct agents, dropping the oldest', () => {
    let lane: DispatchLane = {}
    for (let i = 0; i <= LANE_HISTORY_LIMIT + 1; i++) lane = withLaneSession(lane, S(`${i}`), i)

    expect(lane.history).toHaveLength(LANE_HISTORY_LIMIT)
    expect(lane.history?.[0]?.sessionId).toBe(S(`${LANE_HISTORY_LIMIT}`))
    expect(ids(lane)).not.toContain(S('0'))
  })
})

describe('Clear Lane records; session removal does not', () => {
  it('withLaneClearedByUser records the agent the user cleared', () => {
    const lane = withLaneClearedByUser(withLaneSession({}, S('a'), 1000), 5000)
    expect(lane.selectedSessionId).toBeUndefined()
    expect(lane.history).toEqual([{ sessionId: S('a'), at: 5000 }])
  })

  it('clearing an already-empty lane records nothing', () => {
    expect(withLaneClearedByUser({}, 5000).history).toBeUndefined()
  })
})

describe('history survives the paths that rebuild lanes', () => {
  const stageWith = (lanes: DispatchLane[]): TiledDispatchState => ({
    lanes,
    rows: [{ length: lanes.length }],
    focusedLane: 0,
  })

  it('remaps history ids with the selection (reload / provider switch)', () => {
    const stage = stageWith([
      { selectedSessionId: S('x'), history: [{ sessionId: S('old'), at: 1 }, { sessionId: S('y'), at: 0 }] },
    ])
    const next = remapTiledLanes(stage, new Map([[S('old'), S('new')]]))

    // Without this the same agent's successor id would be filtered as dead
    // and silently fall out of the lane's history.
    expect(next.lanes[0]!.history).toEqual([{ sessionId: S('new'), at: 1 }, { sessionId: S('y'), at: 0 }])
    expect(next.lanes[0]!.selectedSessionId).toBe(S('x'))
  })

  it('remap returns the same stage when nothing it holds was remapped', () => {
    const stage = stageWith([{ selectedSessionId: S('x'), history: [{ sessionId: S('y'), at: 0 }] }])
    expect(remapTiledLanes(stage, new Map([[S('other'), S('z')]]))).toBe(stage)
  })

  it('the autosave prune drops dead agents from history like it drops dead selections', () => {
    const stage = stageWith([
      { selectedSessionId: S('live'), history: [{ sessionId: S('dead'), at: 2 }, { sessionId: S('kept'), at: 1 }] },
      { history: [{ sessionId: S('dead'), at: 1 }] },
    ])
    const next = keepTiledLaneSessions(stage, new Set([S('live'), S('kept')]))

    expect(next.lanes[0]).toEqual({ selectedSessionId: S('live'), history: [{ sessionId: S('kept'), at: 1 }] })
    // A history that empties disappears rather than persisting as [].
    expect(next.lanes[1]).toEqual({})
  })

  it('moves with its lane when a lane is inserted before it or removed beside it', () => {
    const history = [{ sessionId: S('was-here'), at: 1 }]
    const stage = stageWith([{ selectedSessionId: S('a') }, { selectedSessionId: S('b'), history }])

    const inserted = insertLaneIntoGrid(stage, 1, 'before')!
    expect(inserted.lanes[2]).toEqual({ selectedSessionId: S('b'), history })

    const removed = removeLaneFromGrid(stage, 0)!
    expect(removed.lanes[0]).toEqual({ selectedSessionId: S('b'), history })
  })
})

describe('history survives a restart', () => {
  // A real v3 file shape: the load projection rebuilds each lane field by
  // hand, so history that is not copied there is lost on every restart.
  const persisted = (lanes: unknown[]): PersistedWorkspace => ({
    projects: [{ id: 'p', title: 'proj' }],
    sessions: {
      [S('a')]: { cwd: '/x', kind: 'claude', projectId: 'p' },
      [S('b')]: { cwd: '/x', kind: 'claude', projectId: 'p' },
    },
    stage: { lanes, rows: [{ length: lanes.length }], focusedLane: 0 },
  } as unknown as PersistedWorkspace)

  it('keeps valid entries of live agents in order', () => {
    const migrated = migrateWorkspaceToStage(persisted([
      { selectedSessionId: S('a'), history: [{ sessionId: S('b'), at: 20 }, { sessionId: S('gone'), at: 10 }] },
    ]))
    expect(migrated.stage.lanes[0]).toEqual({ selectedSessionId: S('a'), history: [{ sessionId: S('b'), at: 20 }] })
  })

  it('degrades a corrupt history to none without losing the lane', () => {
    const migrated = migrateWorkspaceToStage(persisted([
      { selectedSessionId: S('a'), history: 'not a list' },
      { selectedSessionId: S('b'), history: [null, { sessionId: 7, at: 1 }, { sessionId: S('a'), at: 'soon' }, { sessionId: S('a'), at: 3 }] },
    ]))
    expect(migrated.stage.lanes[0]).toEqual({ selectedSessionId: S('a') })
    expect(migrated.stage.lanes[1]).toEqual({ selectedSessionId: S('b'), history: [{ sessionId: S('a'), at: 3 }] })
  })
})

describe('sanitizeLaneHistory', () => {
  it('re-applies one-row-per-agent and the cap to an edited file', () => {
    const raw = [
      { sessionId: S('a'), at: 3 },
      { sessionId: S('a'), at: 2 },
      ...Array.from({ length: LANE_HISTORY_LIMIT + 5 }, (_, i) => ({ sessionId: S(`${i}`), at: 1 })),
    ]
    const clean = sanitizeLaneHistory(raw, () => true)!
    expect(clean[0]).toEqual({ sessionId: S('a'), at: 3 })
    expect(clean.filter(entry => entry.sessionId === S('a'))).toHaveLength(1)
    expect(clean).toHaveLength(LANE_HISTORY_LIMIT)
  })
})
