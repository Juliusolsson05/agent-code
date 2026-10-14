import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionMoves } from '@renderer/workspace/hook/ipc/useSessionMoves'
import { buildSessionMovePacket } from '@renderer/workspace/sessionMove'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import type { SessionMoveCancelled, SessionMoveCommitted, SessionMoveOffer } from '@shared/types/sessionMove'

// The renderer half of moving agents between live windows (#1481). The
// properties asserted here are the ones that keep an agent from being lost or
// killed by a move:
//
//   - the TARGET confirms only through autosave (the queued id), never on merge,
//     because the confirmation makes the source drop its rows;
//   - a target that cannot merge refuses instead of half-applying;
//   - the SOURCE drops rows only on main's moved-out, and never kills;
//   - nothing is applied before bootstrap, which would be erased by rehydrate.

const api = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown) => void>,
  sendSessionsToWindow: vi.fn(),
  refuseSessionMove: vi.fn(async () => undefined),
  confirmSessionMove: vi.fn(async () => undefined),
  getBackendSnapshot: vi.fn(async (_sessionId: string): Promise<unknown> => null),
  killOwnedSession: vi.fn(async () => true),
}))
vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession: vi.fn(async () => undefined),
}))

function meta(cwd: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { cwd, kind: 'claude', ...extra }
}

function sourceState(): WorkspaceState {
  return {
    tabs: [{ id: 'src-tab', title: 'agent-code' }],
    activeTabId: 'src-tab',
    stage: { lanes: [{ selectedSessionId: 'mover' }, { selectedSessionId: 'stayer' }], rows: [{ length: 2 }], focusedLane: 0 },
    sessions: {
      mover: meta('/dev/agent-code', { projectId: 'src-tab', joinedAt: 1, title: 'Mover' }),
      child: meta('/dev/agent-code', { projectId: 'src-tab', joinedAt: 2, orchestrationParentId: 'mover' }),
      stayer: meta('/dev/agent-code', { projectId: 'src-tab', joinedAt: 3 }),
    },
    pinnedSessionIds: [],
  }
}

function targetState(): WorkspaceState {
  return {
    tabs: [{ id: 'dst-tab', title: 'agent-code' }],
    activeTabId: 'dst-tab',
    stage: { lanes: [{ selectedSessionId: 'resident' }, {}], rows: [{ length: 2 }], focusedLane: 1 },
    sessions: { resident: meta('/dev/agent-code', { projectId: 'dst-tab', joinedAt: 10 }) },
    pinnedSessionIds: [],
  }
}

function offerFromSource(moveId = 'move-1'): SessionMoveOffer {
  const built = buildSessionMovePacket(sourceState(), { mover: 'draft text' }, 'mover')
  if (!built.ok) throw new Error(built.message)
  return { moveId, sourceWindowId: 'A', sessionIds: built.sessionIds, packet: JSON.stringify(built.packet) }
}

function harness(initial: WorkspaceState, bootstrapComplete = true) {
  const runtimes: Record<SessionId, SessionRuntime> = Object.fromEntries(Object.keys(initial.sessions).map(id => [id, emptyRuntime()]))
  const refs = {
    latestStateRef: { current: initial },
    stateRef: { current: initial },
    latestRuntimesRef: { current: runtimes },
    pendingAdoptionWindowIdsRef: { current: [] as string[] },
    pendingSessionMoveIdsRef: { current: [] as string[] },
    seenUuidsRef: { current: {} },
    bootstrapTimersRef: { current: new Map() },
  } as unknown as WorkspaceRefs
  const selectTiledLaneSession = vi.fn(async () => undefined)
  const showToast = vi.fn()
  const hook = renderHook(({ ready }: { ready: boolean }) => useSessionMoves({
    refs,
    setState: updater => {
      refs.latestStateRef.current = typeof updater === 'function' ? updater(refs.latestStateRef.current) : updater
    },
    setRuntimes: updater => {
      refs.latestRuntimesRef.current = typeof updater === 'function' ? updater(refs.latestRuntimesRef.current) : updater
    },
    bootstrapComplete: ready,
    selectTiledLaneSession,
    showToast,
  }), { initialProps: { ready: bootstrapComplete } })
  return {
    refs,
    selectTiledLaneSession,
    showToast,
    hook,
    state: () => refs.latestStateRef.current,
    runtimes: () => refs.latestRuntimesRef.current,
    fire: (channel: string, event: unknown) => act(() => { api.handlers[channel]?.(event) }),
  }
}

beforeEach(() => {
  api.handlers = {}
  for (const fn of [api.sendSessionsToWindow, api.refuseSessionMove, api.confirmSessionMove, api.getBackendSnapshot, api.killOwnedSession]) fn.mockReset()
  api.getBackendSnapshot.mockResolvedValue(null)
  const on = (channel: string) => (cb: (event: unknown) => void) => {
    api.handlers[channel] = cb
    return () => { delete api.handlers[channel] }
  }
  ;(window as unknown as { api: unknown }).api = {
    onSessionMoveOffer: on('offer'),
    onSessionsMovedOut: on('moved-out'),
    onSessionMoveCancelled: on('cancelled'),
    onSessionMoveFailed: on('failed'),
    sendSessionsToWindow: api.sendSessionsToWindow,
    refuseSessionMove: api.refuseSessionMove,
    confirmSessionMove: api.confirmSessionMove,
    getBackendSnapshot: api.getBackendSnapshot,
    killOwnedSession: api.killOwnedSession,
  }
})

describe('receiving a moved agent (target window)', () => {
  it('merges under the same-folder project, seeds runtimes, shows the agent in the focused lane, and queues the confirmation for autosave', async () => {
    const h = harness(targetState())
    await h.fire('offer', offerFromSource())

    await waitFor(() => expect(Object.keys(h.state().sessions).sort()).toEqual(['child', 'mover', 'resident']))
    expect(h.state().sessions.mover?.projectId).toBe('dst-tab')
    expect(h.runtimes().mover?.draftInput).toBe('draft text')
    expect(h.runtimes().child).toBeDefined()
    // The focused lane (1), through the ordinary lane-select action.
    expect(h.selectTiledLaneSession).toHaveBeenCalledWith(1, 'mover')
    // Queued for the autosave that proves durability, NOT sent: sending makes
    // the source drop its rows while this merge is still only in memory.
    expect(h.refs.pendingSessionMoveIdsRef.current).toEqual(['move-1'])
    expect(api.confirmSessionMove).not.toHaveBeenCalled()
    expect(api.refuseSessionMove).not.toHaveBeenCalled()
  })

  it('refuses an agent it already shows, changing nothing and queuing nothing', async () => {
    const initial = targetState()
    initial.sessions.mover = meta('/dev/agent-code', { projectId: 'dst-tab', joinedAt: 11 })
    const h = harness(initial)
    await h.fire('offer', offerFromSource())

    await waitFor(() => expect(api.refuseSessionMove).toHaveBeenCalledWith('move-1', expect.any(String)))
    expect(h.state()).toBe(initial)
    expect(h.refs.pendingSessionMoveIdsRef.current).toEqual([])
  })

  it('refuses a packet that does not match the sessions main routed here', async () => {
    const h = harness(targetState())
    await h.fire('offer', { ...offerFromSource(), sessionIds: ['mover'] })
    await waitFor(() => expect(api.refuseSessionMove).toHaveBeenCalled())
    expect(h.state().sessions.mover).toBeUndefined()
  })

  it('holds an offer that arrives before bootstrap until the window has restored', async () => {
    const h = harness(targetState(), false)
    await h.fire('offer', offerFromSource())
    expect(h.state().sessions.mover).toBeUndefined()

    h.hook.rerender({ ready: true })
    await waitFor(() => expect(h.state().sessions.mover).toBeDefined())
  })

  it('gives back what it merged when main cancels the move, rows only', async () => {
    const h = harness(targetState())
    await h.fire('offer', offerFromSource())
    await waitFor(() => expect(h.state().sessions.mover).toBeDefined())

    const cancelled: SessionMoveCancelled = { moveId: 'move-1', sessionIds: ['mover', 'child'] }
    await h.fire('cancelled', cancelled)

    await waitFor(() => expect(Object.keys(h.state().sessions)).toEqual(['resident']))
    expect(h.refs.pendingSessionMoveIdsRef.current).toEqual([])
    expect(api.killOwnedSession).not.toHaveBeenCalled()
  })
})

describe('a cancel that arrives while the target is still preparing', () => {
  it('stops the merge before any row is published', async () => {
    // Snapshots are the one await between receiving an offer and publishing
    // its rows. Main's deadline can fire inside it; routing has then already
    // gone back to the source, so publishing would paint dead panes here.
    // One pending snapshot per moved session; all are released together.
    const pending: Array<() => void> = []
    const release = () => { for (const resolve of pending.splice(0)) resolve() }
    api.getBackendSnapshot.mockImplementation(() => new Promise(resolve => { pending.push(() => resolve(null)) }))
    const h = harness(targetState())
    await h.fire('offer', offerFromSource())
    await h.fire('cancelled', { moveId: 'move-1', sessionIds: ['mover', 'child'] } satisfies SessionMoveCancelled)

    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => { release() })
    // Let the merge continuation run to completion before asserting absence.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(h.runtimes().mover).toBeUndefined()
    expect(Object.keys(h.state().sessions)).toEqual(['resident'])
    expect(h.refs.pendingSessionMoveIdsRef.current).toEqual([])
    expect(h.selectTiledLaneSession).not.toHaveBeenCalled()
  })
})

describe('sending an agent (source window)', () => {
  it('keeps the rows until main reports the commit, then drops them without killing and resolves the caller', async () => {
    const h = harness(sourceState())
    api.sendSessionsToWindow.mockResolvedValue({ ok: true, moveId: 'move-9', targetWindowNumber: 2 })

    let settled: unknown
    await act(async () => {
      void h.hook.result.current.sendSessionToWindow('mover', 'B').then(result => { settled = result })
    })
    expect(api.sendSessionsToWindow).toHaveBeenCalledWith(expect.objectContaining({ targetWindowId: 'B', sessionIds: ['mover', 'child'] }))
    // Main has only moved routing so far; the target has not saved anything.
    expect(h.state().sessions.mover).toBeDefined()
    expect(settled).toBeUndefined()

    const committed: SessionMoveCommitted = { moveId: 'move-9', sessionIds: ['mover', 'child'], targetWindowNumber: 2 }
    await h.fire('moved-out', committed)

    await waitFor(() => expect(settled).toEqual({ ok: true, movedSessionIds: ['mover', 'child'], targetWindowNumber: 2 }))
    expect(Object.keys(h.state().sessions)).toEqual(['stayer'])
    expect(h.runtimes().mover).toBeUndefined()
    // Owner ruling 4: the lane stays, cleared.
    expect(h.state().stage.lanes).toEqual([{ selectedSessionId: undefined }, { selectedSessionId: 'stayer' }])
    expect(api.killOwnedSession).not.toHaveBeenCalled()
    expect(h.showToast).toHaveBeenCalledWith('Moved Mover and 1 related agent to Window 2')
  })

  it('reports a failure from main without touching the rows', async () => {
    const h = harness(sourceState())
    api.sendSessionsToWindow.mockResolvedValue({ ok: true, moveId: 'move-3', targetWindowNumber: 2 })
    let settled: unknown
    await act(async () => {
      void h.hook.result.current.sendSessionToWindow('mover', 'B').then(result => { settled = result })
    })
    await h.fire('failed', { moveId: 'move-3', message: 'Window 2 did not confirm the move in time. The agent stays here.' })

    await waitFor(() => expect(settled).toMatchObject({ ok: false, reportedByEvent: true }))
    expect(h.state()).toEqual(sourceState())
  })
})
