import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { OrchestrationRendererRequest, OrchestrationRendererResponse } from '@mcp/shared/orchestrationTypes'
import { useWorkspace } from './index'

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
      activeTabId: 'project', dispatchMode: null, pinnedSessionIds: [], buried: [],
      tabs: [{ id: 'project', title: 'Project', focusedSessionId: 'root', root: { type: 'leaf', sessionId: 'root' } }],
      sessions: {
        root: { kind: 'claude', cwd: '/repo' },
        parent: { kind: 'opencode', providerRuntime: 'terminal', cwd: '/repo/subdir', orchestrationParentId: 'root', orchestrationRootId: 'root' },
      },
      detachedSessions: { parent: { sessionId: 'parent', surface: 'dispatch', projectTabId: 'project', projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 1 } },
    },
    workspaceRuntimes: { root: emptyRuntime(), parent: emptyRuntime() },
  })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onOrchestrationRequest: (callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
    onAgentManagementRequest: () => () => undefined,
    resolveOrchestrationRequest: resolved,
    spawnSession,
    ghostRead: async () => [],
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
    await dispatch({
      requestId: 'create', type: 'create-agent', parentSessionId: 'parent', kind: 'opencode',
      ...(terminal ? { providerRuntime: 'terminal' as const } : {}),
      cwd: '/repo/child', title: 'Parser review', runId: 'run-review', role: 'reviewer', builtInMcpDomains: ['orchestration'],
    })
    expect(spawnSession).toHaveBeenCalledExactlyOnceWith({
      kind: 'opencode', providerRuntime: terminal ? 'terminal' : undefined, cwd: '/repo/child', resumeSessionId: undefined,
      dangerousMode: false, useProxy: false, recoverTmuxName: undefined, builtInMcpDomains: ['orchestration'],
    })
    const ownership = {
      orchestrationParentId: 'parent', orchestrationRootId: 'root', orchestrationRunId: 'run-review', orchestrationRole: 'reviewer',
    }
    const state = useAppStore.getState().workspaceState
    expect(state.sessions.child).toMatchObject({ kind: 'opencode', providerRuntime: terminal ? 'terminal' : undefined, cwd: '/repo/child', title: 'Parser review', ...ownership })
    expect(state.detachedSessions.child).toMatchObject({ sessionId: 'child', surface: 'dispatch', projectTabId: 'project' })
    expect(state.tabs[0]!.focusedSessionId).toBe('root')
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

  it('refuses unsupported Claude terminal before spawn even without the main bridge', async () => {
    renderHook(() => useWorkspace())
    await dispatch({ requestId: 'unsupported', type: 'create-agent', parentSessionId: 'parent', kind: 'claude', providerRuntime: 'terminal' })
    expect(spawnSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaceState.sessions.child).toBeUndefined()
    expect(resolved).toHaveBeenCalledExactlyOnceWith({ requestId: 'unsupported', type: 'create-agent', ok: false, message: 'claude does not support the requested terminal runtime' })
  })
})
