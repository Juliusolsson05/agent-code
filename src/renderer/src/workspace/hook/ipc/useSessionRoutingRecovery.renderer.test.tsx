import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRoutingGap, SessionRoutingHistoryResult, SessionRoutingResyncResult } from '@shared/types/sessionRouting'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { makeWorkspaceRefsForTest } from './testing/workspaceRefsForTest'
import { useSessionRoutingRecovery } from './useSessionRoutingRecovery'

const original = useAppStore.getState()
const originalApi = window.api
const gap: SessionRoutingGap = { sessionId: 'pane', ownershipRevision: 1, gapRevision: 2, reason: 'queue_expired', missedEvents: 3 }
const source = { sourceKey: 'captured-source', kind: 'claude' as const, cwd: '/fixture', providerSessionId: 'native-a' }
let live!: (gap: SessionRoutingGap) => void
let state: WorkspaceState
let refs: ReturnType<typeof makeWorkspaceRefsForTest>
let resync: ReturnType<typeof vi.fn<(gap: SessionRoutingGap) => Promise<SessionRoutingResyncResult>>>
let load: ReturnType<typeof vi.fn<() => Promise<SessionRoutingHistoryResult>>>
let list: ReturnType<typeof vi.fn<() => Promise<SessionRoutingGap[]>>>
let setRuntimes: WorkspaceSetRuntimes

beforeEach(() => {
  state = { tabs: [], activeTabId: '', dispatchMode: null, detachedSessions: {}, buried: [], pinnedSessionIds: [], sessions: { pane: { kind: 'claude', cwd: '/fixture', providerSessionId: 'native-a', providerSessionIdSource: 'runtime-start' } } }
  refs = makeWorkspaceRefsForTest(state)
  const runtime = { ...emptyRuntime(), sessionRunId: 'run-a', transcriptStatus: 'ready' as const, draftInput: 'keep this draft' }
  useAppStore.setState({ workspaceState: state, workspaceRuntimes: { pane: runtime } })
  refs.latestRuntimesRef.current = { pane: runtime }
  setRuntimes = next => {
    const value = typeof next === 'function' ? next(refs.latestRuntimesRef.current) : next
    refs.latestRuntimesRef.current = value
    useAppStore.setState({ workspaceRuntimes: value })
  }
  resync = vi.fn(async () => ({ kind: 'seeded', sessionRunId: 'run-a', history: source }))
  load = vi.fn(async () => ({ kind: 'loaded', chunk: {
    entries: [{ type: 'assistant', uuid: 'durable-answer', message: { role: 'assistant', content: [{ type: 'text', text: 'saved answer' }] } }],
    hasMore: false, totalEntries: 1,
  } }))
  list = vi.fn(async () => [])
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onSessionRoutingGap: (cb: typeof live) => { live = cb; return () => {} },
    getSessionRoutingGaps: list,
    resyncSessionRouting: resync,
    loadSessionRoutingHistory: load,
    gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
    reportSessionLifecycle: vi.fn(),
    reportPerformance: vi.fn(),
  } })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

function Harness({ sessions = state.sessions }: { sessions?: WorkspaceState['sessions'] }) {
  useSessionRoutingRecovery(refs, setRuntimes, sessions)
  return <PaneHeader sessionId="pane" projectDir="/fixture" statusMode={false} isSessionLive={false} />
}

describe('desktop observation repair with the real history mapper and shared pane header', () => {
  it('recovers committed content while preserving the draft, and keeps transient loss visible after refresh', async () => {
    render(<Harness />)
    act(() => live(gap))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('View refreshed'))
    const runtime = refs.latestRuntimesRef.current.pane!
    expect(runtime.entries.some(entry => entry.uuid === 'durable-answer')).toBe(true)
    expect(runtime.draftInput).toBe('keep this draft')
    expect(runtime.routingGap?.phase).toBe('refreshed')
    expect(runtime.exited).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('may be missing')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh view' }))
    await waitFor(() => expect(resync).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(refs.latestRuntimesRef.current.pane!.routingGap?.phase).toBe('refreshed'))
    expect(refs.latestRuntimesRef.current.pane!.entries.filter(entry => entry.uuid === 'durable-answer')).toHaveLength(1)
  })

  it('does not treat a newly selected native conversation as a refresh of the displayed conversation', async () => {
    resync.mockResolvedValue({ kind: 'seeded', sessionRunId: 'run-a', history: { ...source, providerSessionId: 'native-b' } })
    render(<Harness />)
    act(() => live(gap))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unavailable'))
    expect(load).not.toHaveBeenCalled()
    expect(refs.latestRuntimesRef.current.pane!.entries).toEqual([])
  })

  it('reports an unavailable repair without turning it into a provider transcript error', async () => {
    load.mockResolvedValue({ kind: 'unavailable' })
    render(<Harness />)
    act(() => live(gap))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unavailable'))
    expect(refs.latestRuntimesRef.current.pane).toMatchObject({ transcriptStatus: 'ready', transcriptError: null, draftInput: 'keep this draft' })
  })

  it.each(['native target', 'run', 'close'])('does not apply a delayed history reply after changing the %s', async change => {
    let finish!: (value: SessionRoutingHistoryResult) => void
    load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<Harness />)
    act(() => live(gap))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    act(() => {
      if (change === 'native target') refs.stateRef.current = { ...state, sessions: { pane: { ...state.sessions.pane!, providerSessionId: 'native-b' } } }
      if (change === 'run') setRuntimes(prev => ({ ...prev, pane: { ...prev.pane!, sessionRunId: 'run-b' } }))
      if (change === 'close') setRuntimes({})
      finish({ kind: 'loaded', chunk: { entries: [{ type: 'assistant', uuid: 'obsolete', message: { content: [{ type: 'text', text: 'old target' }] } }], hasMore: false } })
    })
    await act(async () => { await Promise.resolve() })
    expect(refs.latestRuntimesRef.current.pane?.entries ?? []).toEqual([])
    expect(refs.seenUuidsRef.current.pane?.has('obsolete') ?? false).toBe(false)
    if (change === 'close') expect(refs.latestRuntimesRef.current).toEqual({})
  })

  it('pulls an early unacknowledged notice when the pane becomes visible without creating an orphan runtime', async () => {
    const saved = refs.latestRuntimesRef.current.pane!
    refs.stateRef.current = { ...state, sessions: {} }
    setRuntimes({})
    const view = render(<Harness sessions={{}} />)
    act(() => live(gap))
    expect(refs.latestRuntimesRef.current).toEqual({})
    expect(resync).not.toHaveBeenCalled()
    list.mockResolvedValue([gap])
    act(() => { refs.stateRef.current = state; setRuntimes({ pane: saved }); view.rerender(<Harness sessions={state.sessions} />) })
    await waitFor(() => expect(refs.latestRuntimesRef.current.pane!.routingGap?.phase).toBe('refreshed'))
  })

  it('lets a newer gap retain its warning when an older refresh settles', async () => {
    let finish!: (value: SessionRoutingResyncResult) => void
    resync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    resync.mockResolvedValueOnce({ kind: 'unavailable' })
    render(<Harness />)
    act(() => { live(gap); live({ ...gap, gapRevision: 3 }) })
    await waitFor(() => expect(refs.latestRuntimesRef.current.pane!.routingGap).toMatchObject({ gapRevision: 3, phase: 'unavailable' }))
    await act(async () => { finish({ kind: 'seeded', sessionRunId: 'run-a', history: source }) })
    expect(refs.latestRuntimesRef.current.pane!.routingGap).toMatchObject({ gapRevision: 3, phase: 'unavailable' })
    expect(load).not.toHaveBeenCalled()
  })
})
