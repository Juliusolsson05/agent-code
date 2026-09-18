import { describe, expect, it } from 'vitest'

import {
  collectLiveProcessIds,
  collectOwnedSessionIds,
  pruneSessionOwnership,
} from '@renderer/workspace/sessionOwnership'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// (extensionPaneOwnership.test.ts was folded into this file with #992. It pinned
// that an extension view sits BETWEEN the two sets — owned, never spawned — by
// asserting the gap between them was exactly that pane. With the boot-spawn
// set narrowed to the focused lane the gap is "almost everything", so the two
// halves are asserted directly below instead.)
//
// Ownership over the pool (#992): a session is owned because its own row names
// a project that exists. The v2 rules this module used to enforce — tile
// leaves, detached records, buried panes, and the production ghost pool that
// taught them — are tested where they now live, in legacyWorkspaceV2.test.ts.

const agent = (projectId?: string, joinedAt = 0): SessionMeta => ({
  cwd: '/work/project-a',
  kind: 'claude',
  ...(projectId ? { projectId, joinedAt } : {}),
})

function makeState(): WorkspaceState {
  return {
    tabs: [{ id: 'tabA', title: 'project-a' }],
    activeTabId: 'tabA',
    stage: {
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'live' }, { selectedSessionId: 'unfiled' }],
    },
    sessions: {
      live: agent('tabA'),
      // Written by `spawn`, never filed by its caller: no project at all.
      unfiled: agent(),
    },
    pinnedSessionIds: [],
  }
}

describe('collectOwnedSessionIds', () => {
  it('owns a session whose project exists, and nothing else', () => {
    const state = makeState()
    state.sessions.parked = agent('tabA', 5)
    state.sessions.ghost = agent('closed-project')

    expect([...collectOwnedSessionIds(state)].sort()).toEqual(['live', 'parked'])
  })

  it('does not treat a lane, a pin or the active project as ownership', () => {
    // Pointers are not owners. A stale pointer must never keep a session
    // alive or bring one back — this is the rule that stopped dispatch focus
    // from resurrecting work the user could no longer see.
    const state = makeState()
    state.sessions.ghost = agent('closed-project')
    state.stage = { focusedLane: 0, lanes: [{ selectedSessionId: 'ghost' }] }
    state.pinnedSessionIds = ['ghost']
    state.activeTabId = 'closed-project'

    expect(collectOwnedSessionIds(state).has('ghost')).toBe(false)
  })

  it('does not read metadata through the prototype chain', () => {
    // A session id like `toString` resolves to an inherited function under a
    // bare index read. Reaching this needs a hand-edited file, which is an
    // explicit threat model for everything that reads workspace.json.
    const state = makeState()
    expect(collectOwnedSessionIds({ ...state, sessions: Object.create({ toString: agent('tabA') }) }).size).toBe(0)
  })

  it('keeps a process-less extension view owned', () => {
    // Ownership and "needs a process" are different questions. If ownership
    // were derived from the live set, autosave would drop the view's metadata
    // on the next save.
    const state = makeState()
    state.sessions.view = { cwd: '', kind: 'extension-view', extensionViewId: 'timer.main', projectId: 'tabA', joinedAt: 1 }

    expect(collectOwnedSessionIds(state).has('view')).toBe(true)
  })
})

describe('collectLiveProcessIds — the boot-spawn set', () => {
  it('is the focused lane s occupant and nothing else', () => {
    const state = makeState()
    state.sessions.other = agent('tabA', 1)
    state.stage = {
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'live' }, { selectedSessionId: 'other' }, {}],
    }

    // `live` is on a lane too — and is NOT spawned at boot. It renders its
    // committed transcript and wakes on its first send, exactly as every
    // restored lane always has. See the function's comment for why this is
    // not 16 processes in one Promise.all.
    expect([...collectLiveProcessIds(state)]).toEqual(['other'])
  })

  it('is empty when the focused lane is empty', () => {
    const state = makeState()
    state.stage = { focusedLane: 1, lanes: [{ selectedSessionId: 'live' }, {}] }

    expect(collectLiveProcessIds(state).size).toBe(0)
  })

  it('never spawns a session nothing owns, however it is pointed at', () => {
    // The #258 shape, restated: a lane naming unowned metadata must not turn
    // that metadata into a backend process.
    const state = makeState() // the focused lane names `unfiled`
    expect(collectLiveProcessIds(state).size).toBe(0)

    state.sessions.ghost = agent('closed-project')
    state.stage = { focusedLane: 0, lanes: [{ selectedSessionId: 'ghost' }] }
    expect(collectLiveProcessIds(state).size).toBe(0)
  })

  it('restores the gate invariant: every live id is a key of sessions', () => {
    // Rehydrate compares |resolved| to |live| while `resolved` can only ever
    // contain keys of `sessions`, so the comparison is satisfiable only when
    // the live set is a subset of those keys. A lane naming a session with no
    // metadata once froze a real workspace for three weeks: restore never
    // completed, so autosave — the file's only writer — stayed locked.
    const state = makeState()
    state.stage = { focusedLane: 0, lanes: [{ selectedSessionId: 'closed-long-ago' }] }

    expect(collectLiveProcessIds(state).size).toBe(0)
  })

  it('never spawns for an extension view', () => {
    // It has no process. Recovering one would fall through SessionManager's
    // provider switch into the terminal branch and start a stray shell.
    const state = makeState()
    state.sessions.view = { cwd: '', kind: 'extension-view', extensionViewId: 'timer.main', projectId: 'tabA', joinedAt: 1 }
    state.stage = { focusedLane: 0, lanes: [{ selectedSessionId: 'view' }] }

    expect(collectLiveProcessIds(state).size).toBe(0)
  })
})

describe('pruneSessionOwnership — what autosave may make durable', () => {
  it('drops unowned rows and empties the lanes that named them, keeping the shape', () => {
    const result = pruneSessionOwnership(makeState())

    expect(result.sessions).toEqual({ live: agent('tabA') })
    expect(result.droppedSessionIds).toEqual(['unfiled'])
    // The lane goes empty; it is not removed and focus does not move.
    expect(result.stage.focusedLane).toBe(1)
    expect(result.stage.lanes).toEqual([{ selectedSessionId: 'live' }, { selectedSessionId: undefined }])
  })

  it('collapses a ghost pool in one save cycle without touching parked agents', () => {
    // The production cardinalities that made the original bug hard to see —
    // 8 legitimately parked agents beside 82 records whose project had been
    // closed — restated for the pool. The distinction is project
    // reachability, not any count.
    const state = makeState()
    delete state.sessions.unfiled
    for (let index = 0; index < 8; index += 1) state.sessions[`parked-${index}`] = agent('tabA', index + 1)
    for (let index = 0; index < 82; index += 1) state.sessions[`ghost-${index}`] = agent(`deleted-tab-${index}`)

    const result = pruneSessionOwnership(state)

    expect(Object.keys(result.sessions)).toHaveLength(9)
    expect(result.sessions).toHaveProperty('parked-7')
    expect(result.sessions).not.toHaveProperty('ghost-0')
    expect(result.droppedSessionIds).toHaveLength(82)
  })

  it('scrubs row bindings to projects that no longer exist', () => {
    // A binding to a closed project filters that row's index to nothing, with
    // no UI path back: the picker only lists projects that exist.
    const state = makeState()
    state.stage = {
      focusedLane: 0,
      lanes: [{ selectedSessionId: 'live' }],
      rows: [{ length: 1, projectTabIds: ['tabA', 'closed-project'] }],
    }

    expect(pruneSessionOwnership(state).stage.rows).toEqual([{ length: 1, projectTabIds: ['tabA'] }])
  })

  it('returns the stage by reference when nothing needed scrubbing', () => {
    // Autosave runs on a debounce for the life of the app; a prune that
    // rebuilt a healthy stage every time would churn every lane memo.
    const state = makeState()
    delete state.sessions.unfiled
    state.stage = { focusedLane: 0, lanes: [{ selectedSessionId: 'live' }], rows: [{ length: 1 }] }

    expect(pruneSessionOwnership(state).stage).toBe(state.stage)
  })
})
