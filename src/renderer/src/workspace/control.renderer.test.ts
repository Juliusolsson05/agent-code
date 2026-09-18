import { afterEach, describe, expect, it } from 'vitest'
import { workspaceControlCapabilities } from './control'
import { useAppStore } from '@renderer/app-state/store'
import type { WorkspaceState } from './types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

const original = useAppStore.getState()
afterEach(() => useAppStore.setState(original, true))
const context = {
  requestId: 'read', caller: { kind: 'application' as const, id: 'trial' },
  owner: { kind: 'window' as const, windowId: 'left', generation: 'first' },
}

// Known domain contracts: a session belongs to exactly one project whether or
// not a lane shows it, and multiple lanes can show one ID. This is a
// deterministic contract setup, not a recorded provider fixture.
function workspace(): WorkspaceState {
  return {
    tabs: [{ id: 'alpha', title: 'Alpha' }],
    activeTabId: 'alpha', stage: oneLaneStage('parent'),
    sessions: { parent: { cwd: '/trial', kind: 'claude', projectId: 'alpha', joinedAt: 0 }, child: { cwd: '/trial', kind: 'codex', linkedParentId: 'parent', projectId: 'alpha', joinedAt: 1 } },
     pinnedSessionIds: ['child'],
  }
}

describe('workspace control observation', () => {
  it('reports a parked session by its project and reads fresh state without waking providers', async () => {
    const state = workspace()
    useAppStore.setState({ workspaceState: state })
    const capability = workspaceControlCapabilities(() => ({ restoreStatus: 'pending' }))[0]
    const result = await capability.execute({}, context)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    const child = result.value.sessions.find(session => session.sessionId === 'child')!
    // `child` is in no lane: it is parked. v2 had FOUR ownership placements,
    // one per owner structure (grid leaf, related strip, detached, buried), and
    // this case asserted the 'related' and 'buried' ones. Ownership is one
    // field now, so there is one ownership placement — 'project' — and it is
    // never `visible`, because belonging to a project puts nothing on screen.
    // Only a lane does (the 'dispatch' placements in the next case).
    expect(child.placements).toEqual([{ kind: 'project', tabId: 'alpha', visible: false }])
    // The lane occupant carries both: where it belongs, and where it is shown.
    expect(result.value.sessions.find(session => session.sessionId === 'parent')?.placements).toEqual([
      { kind: 'project', tabId: 'alpha', visible: false },
      { kind: 'dispatch', lane: 0, visible: true },
    ])
    expect(useAppStore.getState().workspaceState).toBe(state)
    useAppStore.setState({ workspaceState: { ...state, sessions: { ...state.sessions, child: { ...state.sessions.child, title: 'Changed after registration' } } } })
    const next = await capability.execute({}, context)
    expect(next.ok && next.value.sessions.find(session => session.sessionId === 'child')?.title).toBe('Changed after registration')
  })

  it('reports both mirrored lanes under one session', async () => {
    const state = workspace()
    state.stage = { focusedLane: 1, lanes: [{ selectedSessionId: 'child' }, { selectedSessionId: 'child' }] }
    useAppStore.setState({ workspaceState: state })
    const capability = workspaceControlCapabilities(() => ({ restoreStatus: 'pending' }))[0]
    const result = await capability.execute({}, context)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.sessions.filter(session => session.sessionId === 'child')).toHaveLength(1)
    expect(result.value.sessions.find(session => session.sessionId === 'child')?.placements.filter(p => p.kind === 'dispatch'))
      .toEqual([{ kind: 'dispatch', lane: 0, visible: true }, { kind: 'dispatch', lane: 1, visible: true }])
    // A Tile Tabs precedence case lived here until #992 deleted Tile Tabs;
    // the stage is the only layout, so lane placements are always visible.
    expect(result.value.mode).toBe('tiled-dispatch')
  })
})
