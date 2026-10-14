import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { grantedObserveTopics, OBSERVE_NUDGE_MS, subscribeObserveNudges, type ObserveTopic } from '@renderer/apps/host/observeNudges'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'

// The frame path (#1479 review, host-a M1–M3 / host-b vb1–vb5): an extension
// frame's `sessions.subscribe` wakes ONLY on these pushes, so this is the test
// that fails if an agent finishing its turn stops reaching the Skitgubbe panel.
// Every mutation the reviewers ran against the inline viewBridge code survived
// the whole suite; each assertion below names the one it kills.

const initial = useAppStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.getState().setWorkspaceState(state => ({
    ...state,
    sessions: { a: { cwd: '/work/a', kind: 'claude', projectId: 'p', joinedAt: 0 } } as typeof state.sessions,
  }))
  useAppStore.getState().setWorkspaceRuntimes({ a: emptyRuntime() })
})
afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initial)
})

const update = (patch: Partial<SessionRuntime>) =>
  useAppStore.getState().setWorkspaceRuntimes(prev => ({ ...prev, a: { ...prev.a!, ...patch } }))
const touchWorkspace = () =>
  useAppStore.getState().setWorkspaceState(state => ({ ...state }))

function watch(topics: ObserveTopic[]) {
  const pushed: ObserveTopic[] = []
  const dispose = subscribeObserveNudges(topics, topic => pushed.push(topic))
  return { pushed, dispose }
}

describe('subscribeObserveNudges', () => {
  it('pushes `sessions` when an agent finishes its turn, which changes no session row', () => {
    const { pushed, dispose } = watch(['workspace', 'sessions', 'panes'])
    update({ streamPhase: 'responding' })
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    // vb1/M1 (no status subscription) → nothing pushed. vb2/M2 (status pushes
    // every topic) → workspace and panes too: frames would re-read data that
    // did not change on every status flip.
    expect(pushed).toEqual(['sessions'])

    update({ streamPhase: 'idle', unreadKind: 'output', unreadSince: 1 })
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    // vb4/M3 (pending never cleared) would still be ['sessions'] here only by
    // luck; the next case is what catches a stale pending set.
    expect(pushed).toEqual(['sessions', 'sessions'])
    dispose()
  })

  it('a streamed chunk that changes no status pushes nothing', () => {
    const { pushed, dispose } = watch(['sessions'])
    update({ entries: [{ type: 'user', uuid: 'u1' } as unknown as SessionRuntime['entries'][number]] })
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS * 3)
    expect(pushed).toEqual([])
    dispose()
  })

  it('coalesces a workspace burst and a status flip into one push per topic, after the window', () => {
    const { pushed, dispose } = watch(['workspace', 'sessions'])
    touchWorkspace()
    update({ sessionStatus: 'running' })
    touchWorkspace()
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS - 1)
    expect(pushed).toEqual([])
    vi.advanceTimersByTime(1)
    expect([...pushed].sort()).toEqual(['sessions', 'workspace'])

    // A later status-only flip must push ONLY sessions: a pending set that is
    // never cleared (vb4/M3) would replay `workspace` here.
    update({ sessionStatus: 'idle' })
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    expect(pushed.slice(2)).toEqual(['sessions'])
    dispose()
  })

  it('does not watch status for a frame without sessions.observe', () => {
    // vb3: removing the `sessions` gate would push a topic this frame was
    // never granted, telling it that data it may not read has changed.
    const { pushed, dispose } = watch(grantedObserveTopics(['workspace.observe']))
    update({ sessionStatus: 'running' })
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    expect(pushed).toEqual([])
    touchWorkspace()
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    expect(pushed).toEqual(['workspace'])
    dispose()
  })

  it('dispose unsubscribes both sources and cancels a pending push', () => {
    const { pushed, dispose } = watch(['workspace', 'sessions'])
    update({ sessionStatus: 'running' })
    dispose()
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    // vb5: a leaked status listener keeps recomputing the signature on every
    // store write after the frame is gone, and would push into a dead frame.
    update({ sessionStatus: 'idle' })
    touchWorkspace()
    vi.advanceTimersByTime(OBSERVE_NUDGE_MS)
    expect(pushed).toEqual([])
  })

  it('grants map capability names to topics and ignore everything else', () => {
    expect(grantedObserveTopics(['sessions.observe', 'fs.read', 'panes.observe'])).toEqual(['sessions', 'panes'])
    expect(grantedObserveTopics([])).toEqual([])
  })
})
