import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { OrchestrationRendererRequest, OrchestrationRendererResponse } from '@mcp/shared/orchestrationTypes'
import { useWorkspace } from './index'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// Mount the real renderer create handler, pane action, session spawn action,
// and workspace store. Boot/history subscriptions are unrelated ingress;
// suppress them so this deterministic create test cannot discover processes
// or read personal configuration. window.api.spawnSession is the main-process
// boundary, whose existing runtime factory selection is not reimplemented.
vi.mock('./ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('./ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('./persistence/useBootstrap', () => ({ useBootstrap: () => undefined }))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))

const originalStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
let listener: ((request: OrchestrationRendererRequest) => void) | undefined
const spawnSession = vi.fn(async () => ({ sessionId: 'child' }))
const resolved = vi.fn(async (_response: OrchestrationRendererResponse) => undefined)
beforeEach(() => {
  vi.useFakeTimers()
  spawnSession.mockClear()
  resolved.mockClear()
  listener = undefined
  useAppStore.setState({
    workspaceState: {
      ...originalStore.workspaceState,
      activeTabId: 'project', stage: oneLaneStage('root'), pinnedSessionIds: [], 
      tabs: [{ id: 'project', title: 'Project' }],
      sessions: {
        root: { kind: 'claude', cwd: '/repo', projectId: 'project', joinedAt: 0 },
        parent: { kind: 'opencode', providerRuntime: 'terminal', cwd: '/repo/subdir', orchestrationParentId: 'root', orchestrationRootId: 'root', projectId: 'project', joinedAt: 1 },
      },
    },
    workspaceRuntimes: { root: emptyRuntime(), parent: emptyRuntime() },
  })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onOrchestrationRequest: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
    onAgentManagementRequest: () => () => undefined,
    resolveOrchestrationRequest: resolved,
    spawnSession,
    reportSessionLifecycle: vi.fn(),
    appendFeedDebugLog: async () => undefined,
  } })
})
afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  useAppStore.setState(originalStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

async function dispatch(request: OrchestrationRendererRequest): Promise<void> {
  if (!listener) throw new Error('Workspace did not register orchestration ingress')
  await act(async () => { await listener!(request) })
  // Flush the existing deferred ghost bootstrap, without sleeping or leaving
  // a timer that can touch a restored window.api after the test ends.
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
}

describe('renderer orchestration runtime creation', () => {
  it.each([true, false])('carries the selected runtime and ownership through real spawn; terminal=%s', async terminal => {
    renderHook(() => useWorkspace())
    const stageBefore = useAppStore.getState().workspaceState.stage
    await dispatch({
      requestId: 'create', type: 'create-agent', parentSessionId: 'parent', kind: 'opencode',
      ...(terminal ? { providerRuntime: 'terminal' as const } : {}),
      cwd: '/repo/child', title: 'Parser review', runId: 'run-review', role: 'reviewer', builtInMcpDomains: ['orchestration'],
    })
    expect(spawnSession).toHaveBeenCalledExactlyOnceWith({
      kind: 'opencode', providerRuntime: terminal ? 'terminal' : undefined, cwd: '/repo/child', resumeSessionId: undefined,
      dangerousMode: false, useProxy: false, recoverTmuxName: undefined, builtInMcpDomains: ['orchestration'],
      userMcpOverrides: {},
    })
    const ownership = {
      orchestrationParentId: 'parent', orchestrationRootId: 'root', orchestrationRunId: 'run-review', orchestrationRole: 'reviewer',
    }
    const state = useAppStore.getState().workspaceState
    expect(state.sessions.child).toMatchObject({ kind: 'opencode', providerRuntime: terminal ? 'terminal' : undefined, cwd: '/repo/child', title: 'Parser review', ...ownership })
    // Filed in the root parent's project, and it does NOT steal the stage:
    // one prompt can create many workers, so no lane is re-aimed at it.
    expect(state.sessions.child).toMatchObject({ projectId: 'project', joinedAt: expect.any(Number) })
    expect(state.stage).toBe(stageBefore)
    expect(resolved).toHaveBeenCalledWith({ requestId: 'create', ok: true, type: 'create-agent', agent: {
      sessionId: 'child', kind: 'opencode', cwd: '/repo/child', title: 'Parser review', ...ownership,
    } })

    // Existing list/read operations must see the new child via its ownership,
    // not because this test manually installed a fabricated child record.
    await dispatch({ requestId: 'list', type: 'list-agents', parentSessionId: 'parent', runId: 'run-review' })
    expect(resolved).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'list', ok: true, agents: [expect.objectContaining({ sessionId: 'child', ...ownership })] }))
    await dispatch({ requestId: 'read', type: 'read-agent', parentSessionId: 'parent', sessionId: 'child' })
    expect(resolved).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'read', ok: true, output: expect.objectContaining({ agent: expect.objectContaining({ sessionId: 'child', ...ownership }) }) }))
  })

  // Astra review finding 3: MCP create_agent may name only the kind. Pi has
  // one runtime, so `{ kind: 'pi' }` must create a terminal Pi child instead
  // of being refused because the raw request carried no runtime.
  it('creates a Pi child from a kind-only request as the terminal runtime', async () => {
    renderHook(() => useWorkspace())
    await dispatch({ requestId: 'pi', type: 'create-agent', parentSessionId: 'parent', kind: 'pi', cwd: '/repo/child' })
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'pi', ok: true }))
    expect(spawnSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'pi', providerRuntime: 'terminal', cwd: '/repo/child' }))
  })

  // #1369 verification a and b: a create captures its parent, then awaits the
  // child's spawn; a replacement committed meanwhile remaps only children
  // already in the store, so the child was filed under the retired id and the
  // successor could not list, read or close it. Own ids: the successor map is
  // per-window module state and must not leak into the other cases.
  it('files a child whose parent was replaced during its spawn under the successor', async () => {
    const { carryOrchestrationParents } = await import('./actions/successorCarry')
    useAppStore.setState(state => ({ workspaceState: { ...state.workspaceState, sessions: {
      ...state.workspaceState.sessions,
      'swap-root': { kind: 'claude', cwd: '/repo', projectId: 'project', joinedAt: 2 },
      'swap-parent': { kind: 'claude', cwd: '/repo', orchestrationParentId: 'swap-root', orchestrationRootId: 'swap-root', projectId: 'project', joinedAt: 3 },
    } } }))
    let release!: () => void
    spawnSession.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ sessionId: 'child' }) }))
    renderHook(() => useWorkspace())
    const creating = dispatch({ requestId: 'swap', type: 'create-agent', parentSessionId: 'swap-parent', kind: 'claude', cwd: '/repo/child' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // Replacements commit while the spawn is pending (the parent's pane AND
    // the root's, e.g. Reload Agents), and each committed swap records its
    // lineage.
    act(() => {
      useAppStore.setState(state => {
        const { 'swap-parent': retired, 'swap-root': retiredRoot, ...rest } = state.workspaceState.sessions
        return { workspaceState: { ...state.workspaceState, sessions: { ...rest, 'swap-successor': retired!, 'swap-root-next': retiredRoot! } } }
      })
      carryOrchestrationParents(new Map([['swap-parent', 'swap-successor'], ['swap-root', 'swap-root-next']]))
    })
    release()
    await creating
    expect(useAppStore.getState().workspaceState.sessions.child).toMatchObject({ orchestrationParentId: 'swap-successor', orchestrationRootId: 'swap-root-next' })
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'swap', ok: true, agent: expect.objectContaining({ orchestrationParentId: 'swap-successor' }) }))
    await dispatch({ requestId: 'swap-list', type: 'list-agents', parentSessionId: 'swap-successor' })
    expect(resolved).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'swap-list', ok: true, agents: [expect.objectContaining({ sessionId: 'child' })] }))
  })

  it('refuses unsupported Claude terminal before spawn even without the main bridge', async () => {
    renderHook(() => useWorkspace())
    await dispatch({ requestId: 'unsupported', type: 'create-agent', parentSessionId: 'parent', kind: 'claude', providerRuntime: 'terminal' })
    expect(spawnSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaceState.sessions.child).toBeUndefined()
    expect(resolved).toHaveBeenCalledExactlyOnceWith({ requestId: 'unsupported', type: 'create-agent', ok: false, message: 'claude does not support the requested terminal runtime' })
  })
})
