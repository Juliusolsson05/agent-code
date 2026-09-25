import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useSessionActions } from './session'
import { makeRefs } from './testing/paneActionsHarness'
vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => { cleanup(); useAppStore.setState(original, true); window.api = originalApi; vi.useRealTimers() })

// Recorded review reproduction: close the source while replacement spawn is
// deferred. Keep React refs stale deliberately; the real store owns the close.
// Also inject the same close at predecessor retirement, the second await.
it.each(['spawn', 'retirement'] as const)('retires an uncommittable successor when source closes during %s', async stage => {
  vi.useFakeTimers()
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    sessions: { source: { kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-source', projectId: 'project', joinedAt: 0 } },  
  }, workspaceRuntimes: { source: { ...emptyRuntime(), draftInput: 'human draft' } } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const spawnSession = vi.fn(async () => { if (stage === 'spawn') await gate; return { sessionId: 'successor' } })
  const killOwnedSession = vi.fn(async ({ sessionId }: { sessionId: string }) => { if (sessionId === 'source' && stage === 'retirement') await gate; return true })
  window.api = { ...originalApi, spawnSession, killOwnedSession }
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  let replacement: Promise<string | undefined>
  await act(async () => { replacement = mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'source', kind: 'claude', resumeSessionId: 'native-source' }); await Promise.resolve(); await Promise.resolve() })
  if (stage === 'retirement') await vi.waitFor(() => expect(killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'source' })))
  useAppStore.getState().setWorkspaceState(previous => ({ ...previous, tabs: [], sessions: Object.fromEntries(Object.entries(previous.sessions).filter(([id]) => id !== 'source')) }))
  useAppStore.getState().setWorkspaceRuntimes(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== 'source')))
  await act(async () => { finish(); expect(await replacement!).toBeUndefined(); await vi.runAllTimersAsync() })
  expect(killOwnedSession).toHaveBeenCalledWith({ sessionId: 'successor', cwd: '/recorded/project', kind: 'claude', providerRuntime: undefined, caller: 'replace.orphaned-successor' })
  expect(useAppStore.getState().workspaceState.tabs).toEqual([])
  expect(useAppStore.getState().workspaceState.sessions).toEqual({})
  expect(useAppStore.getState().workspaceRuntimes.successor).toBeUndefined()
})

// #1279: the goal loop is keyed by session id in main, which cannot see the
// swap. A committed replacement that continues the same conversation with
// Goal Loop tools must hand it over; nothing else may (#1287 review A).
function replaceHarness(defaults: string[]) {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    sessions: { source: { kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-source', projectId: 'project', joinedAt: 0 } },
  }, workspaceRuntimes: { source: emptyRuntime() } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.defaultBuiltInMcpDomainsRef.current = defaults as never
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const carryGoalLoop = vi.fn(async (_from: string, _to: string) => null)
  const controlGoalLoop = vi.fn(async (_request: { sessionId: string; action: string }) => null)
  window.api = { ...originalApi, spawnSession: vi.fn(async () => ({ sessionId: 'successor' })), killOwnedSession: vi.fn(async () => true), carryGoalLoop, controlGoalLoop }
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  return { mounted, carryGoalLoop, controlGoalLoop }
}

it('hands the pane\'s goal loop to the successor when the replacement commits', async () => {
  const { mounted, carryGoalLoop } = replaceHarness(['goal_loop'])
  await act(async () => {
    expect(await mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'source', kind: 'claude', resumeSessionId: 'native-source' })).toBe('successor')
  })
  expect(carryGoalLoop).toHaveBeenCalledWith('source', 'successor')
})

it('does not hand a loop to a different conversation swapped into the pane', async () => {
  const { mounted, carryGoalLoop, controlGoalLoop } = replaceHarness(['goal_loop'])
  await act(async () => {
    await mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'source', kind: 'claude', resumeSessionId: 'other-conversation', newConversation: true })
  })
  expect(carryGoalLoop).not.toHaveBeenCalled()
  // Nothing could reach it again: it is ended, not orphaned (review A2).
  expect(controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'source', action: 'stop' })
})

it('does not hand a loop to a successor without Goal Loop tools', async () => {
  const { mounted, carryGoalLoop, controlGoalLoop } = replaceHarness([])
  await act(async () => {
    await mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'source', kind: 'claude', resumeSessionId: 'native-source' })
  })
  expect(carryGoalLoop).not.toHaveBeenCalled()
  expect(controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'source', action: 'stop' })
})

it('Reload Agents hands each capable successor its loop', async () => {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    stage: { lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }], rows: [{ length: 2 }], focusedLane: 0 } as never,
    sessions: {
      a: { kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-a', projectId: 'project', joinedAt: 0 },
      b: { kind: 'codex', cwd: '/recorded/project', providerSessionId: 'native-b', projectId: 'project', joinedAt: 1 },
    },
  }, workspaceRuntimes: { a: { ...emptyRuntime(), processStatus: 'started' }, b: { ...emptyRuntime(), processStatus: 'started' } } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.defaultBuiltInMcpDomainsRef.current = ['goal_loop'] as never
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const carryGoalLoop = vi.fn(async (_from: string, _to: string) => null)
  let n = 0
  window.api = { ...originalApi, spawnSession: vi.fn(async () => ({ sessionId: `restarted-${++n}` })), killOwnedSession: vi.fn(async () => true), controlGoalLoop: vi.fn(async () => null), carryGoalLoop }
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  await act(async () => { await mounted.result.current.reloadAgentSessions(true) })
  expect(carryGoalLoop.mock.calls.map(call => call[0]).sort()).toEqual(['a', 'b'])
})

// #1287 round 2 (A1, B1): Reload Agents resolves each successor's domains
// separately. Only the one that keeps goal_loop gets its loop; the other's
// loop is ended.
it('Reload Agents carries only to successors that keep Goal Loop tools', async () => {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    stage: { lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }], rows: [{ length: 2 }], focusedLane: 0 } as never,
    sessions: {
      a: { kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-a', projectId: 'project', joinedAt: 0 },
      b: { kind: 'codex', cwd: '/recorded/project', providerSessionId: 'native-b', projectId: 'project', joinedAt: 1 },
    },
  }, workspaceRuntimes: { a: { ...emptyRuntime(), processStatus: 'started' }, b: { ...emptyRuntime(), processStatus: 'started' } } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  // Current defaults give Claude goal_loop and Codex nothing.
  refs.defaultBuiltInMcpDomainsRef.current = { claude: ['goal_loop'], codex: [] } as never
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const carryGoalLoop = vi.fn(async (_from: string, _to: string) => null)
  const controlGoalLoop = vi.fn(async (_request: { sessionId: string; action: string }) => null)
  let n = 0
  window.api = { ...originalApi, spawnSession: vi.fn(async () => ({ sessionId: `restarted-${++n}` })), killOwnedSession: vi.fn(async () => true), controlGoalLoop, carryGoalLoop }
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  await act(async () => { await mounted.result.current.reloadAgentSessions(true) })
  expect(carryGoalLoop.mock.calls.map(call => call[0])).toEqual(['a'])
  expect(controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'b', action: 'stop' })
})

