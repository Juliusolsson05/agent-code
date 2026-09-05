import { afterEach, describe, expect, it } from 'vitest'
import { workspaceControlCapabilities } from './control'
import { useAppStore } from '@renderer/app-state/store'
import type { WorkspaceState } from './types'

const original = useAppStore.getState()
afterEach(() => useAppStore.setState(original, true))
const context = {
  requestId: 'read', caller: { kind: 'application' as const, id: 'trial' },
  owner: { kind: 'window' as const, windowId: 'left', generation: 'first' },
}

// Known domain contracts from the existing navigation tests: detached children
// may appear in a parent's tile and multiple Dispatch lanes can show one ID.
// This is a deterministic contract setup, not a recorded provider fixture.
function workspace(): WorkspaceState {
  return {
    tabs: [{ id: 'alpha', title: 'Alpha', root: { type: 'leaf', sessionId: 'parent' }, focusedSessionId: 'parent' }],
    activeTabId: 'alpha', dispatchMode: null,
    sessions: { parent: { cwd: '/trial', kind: 'claude' }, child: { cwd: '/trial', kind: 'codex', linkedParentId: 'parent' } },
    detachedSessions: { child: { sessionId: 'child', surface: 'dispatch', projectTabId: 'alpha', projectTabTitle: 'Alpha', projectTabIndex: 0, detachedAt: 1 } },
    buried: [{ id: 'hidden', sessionId: 'hidden', sessionMeta: { cwd: '/trial/hidden', kind: 'opencode' }, buriedAt: 1, sourceTabId: 'alpha', sourceTabTitle: 'Alpha', sourceTabIndex: 0 }],
    gridRelatedSelections: { parent: 'child' }, pinnedSessionIds: ['child'],
  }
}

describe('workspace control observation', () => {
  it('preserves related and buried identities and reads fresh state without waking providers', async () => {
    const state = workspace()
    useAppStore.setState({ workspaceState: state, workspaceTileTabs: null })
    const capability = workspaceControlCapabilities(() => ({ restoreStatus: 'pending' }))[0]
    const result = await capability.execute({}, context)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    const child = result.value.sessions.find(session => session.sessionId === 'child')!
    expect(child.placements).toContainEqual({ kind: 'related', tabId: 'alpha', gridOwnerSessionId: 'parent', visible: true })
    expect(result.value.sessions.find(session => session.sessionId === 'hidden')?.placements).toContainEqual({ kind: 'buried', tabId: 'alpha', visible: false })
    expect(useAppStore.getState().workspaceState).toBe(state)
    useAppStore.setState({ workspaceState: { ...state, sessions: { ...state.sessions, child: { ...state.sessions.child, title: 'Changed after registration' } } } })
    const next = await capability.execute({}, context)
    expect(next.ok && next.value.sessions.find(session => session.sessionId === 'child')?.title).toBe('Changed after registration')
  })

  it('reports both mirrored lanes under one session and respects tiled-tabs precedence', async () => {
    const state = workspace()
    state.dispatchMode = { scope: 'global', tiled: { focusedLane: 1, lanes: [{ selectedSessionId: 'child' }, { selectedSessionId: 'child' }] } }
    useAppStore.setState({ workspaceState: state, workspaceTileTabs: null })
    const capability = workspaceControlCapabilities(() => ({ restoreStatus: 'pending' }))[0]
    const result = await capability.execute({}, context)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.value.sessions.filter(session => session.sessionId === 'child')).toHaveLength(1)
    expect(result.value.sessions.find(session => session.sessionId === 'child')?.placements.filter(p => p.kind === 'dispatch'))
      .toEqual([{ kind: 'dispatch', lane: 0, visible: true }, { kind: 'dispatch', lane: 1, visible: true }])
    useAppStore.setState({ workspaceTileTabs: { tabIds: ['alpha'], focusedTabId: 'alpha', direction: 'vertical', ratios: [1] } })
    const tiled = await capability.execute({}, context)
    if (!tiled.ok) throw new Error(tiled.error.message)
    expect(tiled.value.mode).toBe('tiled-tabs')
    expect(tiled.value.sessions.flatMap(session => session.placements).filter(p => p.kind === 'dispatch').every(p => !p.visible)).toBe(true)
  })
})
