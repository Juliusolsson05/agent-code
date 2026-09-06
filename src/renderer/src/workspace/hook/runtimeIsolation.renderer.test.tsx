import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { TileTree } from '@renderer/workspace/tile-tree/TileTree'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import { useWorkspace } from './index'
import { useRenderedLeaseHygiene } from './effects/useRenderedLeaseHygiene'
import { appendCodexTranscriptObservation } from '@renderer/lifecycle/codexTranscriptObservationOutbox'

const counts = vi.hoisted(() => ({ controller: 0, panes: {} as Record<string, number>, chronology: [] as string[] }))
vi.mock('@providers/registry.renderer', () => ({
  getRendererProvider: () => ({ TileLeaf: ({ sessionId, runtime, onFocusRequest }: {
    sessionId: string; runtime: SessionRuntime; onFocusRequest: () => void
  }) => {
    counts.panes[sessionId] = (counts.panes[sessionId] ?? 0) + 1
    useEffect(() => { counts.chronology.push(`visible:${sessionId}`) }, [sessionId, runtime])
    return <button data-testid={sessionId} onClick={onFocusRequest}>{runtime.draftInput}</button>
  } }),
}))
// No provider/IPC process is started by this test. The controller, store,
// helpers, draft actions, autosave and real subscribed tile boundaries remain
// mounted; only boot/event ingress and the expensive provider paint are faked.
vi.mock('./ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('./ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))
vi.mock('./persistence/useBootstrap', async () => {
  const { useEffect } = await import('react')
  return { useBootstrap: (...args: Parameters<typeof import('./persistence/useBootstrap').useBootstrap>) => {
    useEffect(() => args[5](true), [args[5]])
  } }
})

const original = useAppStore.getState()
const originalApi = window.api
let current!: ReturnType<typeof useWorkspace>
const saveWorkspace = vi.fn(async (_json: string) => undefined)
const reportSessionLifecycle = vi.fn(() => { counts.chronology.push('mutation') })
function Controller({ legacy = false }: { legacy?: boolean }) {
  // Control arm recreates the old root subscription while leaving everything
  // else identical. Counts compare real committed renders, not a synthetic
  // selector microbenchmark or guessed CPU savings.
  useAppStore(state => legacy ? state.workspaceRuntimes : null)
  current = useWorkspace(false)
  useRenderedLeaseHygiene(current)
  counts.controller += 1
  return <>{current.runtimeServices}<TileTree tabId="tab" node={current.activeTab!.root}
    focusedSessionId="one" workspace={current} agentViewMode="agent" /></>
}

beforeEach(() => {
  vi.useFakeTimers()
  counts.controller = 0
  counts.panes = {}
  counts.chronology = []
  saveWorkspace.mockClear()
  reportSessionLifecycle.mockClear()
  const root: TileNode = { type: 'split', direction: 'vertical', ratio: 0.5,
    a: { type: 'leaf', sessionId: 'one' }, b: { type: 'leaf', sessionId: 'two' } }
  const state: WorkspaceState = { ...original.workspaceState,
    tabs: [{ id: 'tab', title: 'Test', focusedSessionId: 'one', root }], activeTabId: 'tab',
    sessions: { one: { kind: 'claude', cwd: '/repo' }, two: { kind: 'claude', cwd: '/repo' } },
  }
  useAppStore.setState({ workspaceState: state, workspaceRuntimes: { one: emptyRuntime(), two: emptyRuntime() } })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onOrchestrationRequest: () => () => undefined,
    onAgentManagementRequest: () => () => undefined,
    saveWorkspace,
    reportSessionLifecycle,
    appendFeedDebugLog: async () => undefined,
  } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(original, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

describe('runtime updates below the workspace controller', () => {
  it.each([false, true])('isolates unrelated panes; legacy control=%s', legacy => {
    const view = render(<Controller legacy={legacy} />)
    const before = { controller: counts.controller, one: counts.panes.one, two: counts.panes.two }
    for (let index = 0; index < 100; index += 1) {
      act(() => current.updateRuntime('one', { draftInput: `frame-${index}` }))
    }
    expect(counts.controller - before.controller).toBe(legacy ? 100 : 0)
    expect(counts.panes.two - before.two).toBe(legacy ? 100 : 0)
    expect(counts.panes.one - before.one).toBe(100)
    expect(view.getByTestId('one')).toHaveTextContent('frame-99')
    expect(current.getRuntime('one').draftInput).toBe('frame-99')
  })

  it('reads fresh drafts synchronously and saves them without rerendering the controller', async () => {
    render(<Controller />)
    const before = counts.controller
    const getRuntime = current.getRuntime
    act(() => {
      current.setDraftInput('one', 'unsent text')
      // Must work before a React commit, not just after act settles.
      expect(getRuntime('one').draftInput).toBe('unsent text')
    })
    expect(counts.controller).toBe(before)
    await act(async () => { await vi.advanceTimersByTimeAsync(401) })
    const saved = JSON.parse(saveWorkspace.mock.calls.at(-1)![0])
    expect(saved.workspace.drafts.one).toBe('unsent text')
    act(() => current.clearDraft('one'))
    expect(getRuntime('one').draftInput).toBe('')
    act(() => current.undoClearDraft('one'))
    expect(getRuntime('one').draftInput).toBe('unsent text')
    expect(counts.controller).toBe(before)
  })

  it('keeps layout actions fresh and moves subscriptions when a leaf changes session', () => {
    const view = render(<Controller />)
    fireEvent.click(view.getByTestId('two'))
    expect(current.activeTab?.focusedSessionId).toBe('two')
    act(() => {
      const store = useAppStore.getState()
      store.setWorkspaceRuntimes(prev => ({ ...prev, three: emptyRuntime() }))
      store.setWorkspaceState(prev => ({ ...prev,
        sessions: { ...prev.sessions, three: { kind: 'claude', cwd: '/repo' } },
        tabs: prev.tabs.map(tab => ({ ...tab, root: { type: 'leaf', sessionId: 'three' } })),
      }))
    })
    expect(view.queryByTestId('one')).toBeNull()
    const before = counts.panes.three
    act(() => current.updateRuntime('one', { draftInput: 'old pane output' }))
    expect(counts.panes.three).toBe(before)
    act(() => current.setDraftInput('three', 'new pane draft'))
    expect(view.getByTestId('three')).toHaveTextContent('new pane draft')
    fireEvent.click(view.getByTestId('three'))
    expect(current.activeTab?.focusedSessionId).toBe('three')
  })

  it('still clears a rendered-view lease acquired after terminal mode hid the feed', () => {
    useAppStore.setState({ settings: { ...original.settings, agentViewMode: 'terminal' } })
    render(<Controller />)
    act(() => current.acquireRenderedViewLease('one', 'copy-assistant-message'))
    expect(current.getRuntime('one').renderedViewLeases).toEqual({})
  })

  it('flushes committed lifecycle observations before passive visibility without duplicating them', () => {
    render(<Controller />)
    const retiredRun = '11111111-1111-4111-8111-111111111111'
    const successorRun = '22222222-2222-4222-8222-222222222222'
    act(() => current.updateRuntime('one', { sessionRunId: retiredRun }))
    counts.chronology = []
    act(() => {
      useAppStore.getState().setWorkspaceRuntimes(prev => ({ ...prev, one: {
        ...appendCodexTranscriptObservation(prev.one, 'submit.release', { cause: 'session-exit' }),
        sessionRunId: successorRun,
      } }))
    })
    expect(counts.chronology).toEqual(['mutation', 'visible:one'])
    expect(reportSessionLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      correlationIds: expect.objectContaining({ sessionRunId: retiredRun }),
    }))
    act(() => current.updateRuntime('two', { draftInput: 'unrelated' }))
    act(() => current.updateRuntime('one', { draftInput: 'later output' }))
    expect(reportSessionLifecycle).toHaveBeenCalledTimes(1)
  })
})
