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
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'source' }, focusedSessionId: 'source' }],
    sessions: { source: { kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-source' } }, detachedSessions: {}, buried: [],
  }, workspaceRuntimes: { source: { ...emptyRuntime(), draftInput: 'human draft' } } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const spawnSession = vi.fn(async () => { if (stage === 'spawn') await gate; return { sessionId: 'successor' } })
  const killOwnedSession = vi.fn(async ({ sessionId }: { sessionId: string }) => { if (sessionId === 'source' && stage === 'retirement') await gate; return true })
  window.api = { ...originalApi, spawnSession, killOwnedSession, ghostRead: vi.fn(async () => []) }
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  let replacement: Promise<string | undefined>
  await act(async () => { replacement = mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'source', kind: 'claude', resumeSessionId: 'native-source' }); await Promise.resolve(); await Promise.resolve() })
  if (stage === 'retirement') await vi.waitFor(() => expect(killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'source' })))
  useAppStore.getState().setWorkspaceState(previous => ({ ...previous, tabs: [], sessions: Object.fromEntries(Object.entries(previous.sessions).filter(([id]) => id !== 'source')) }))
  useAppStore.getState().setWorkspaceRuntimes(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== 'source')))
  await act(async () => { finish(); expect(await replacement!).toBeUndefined(); await vi.runAllTimersAsync() })
  expect(killOwnedSession).toHaveBeenCalledWith({ sessionId: 'successor', cwd: '/recorded/project', kind: 'claude', providerRuntime: undefined })
  expect(useAppStore.getState().workspaceState.tabs).toEqual([])
  expect(useAppStore.getState().workspaceState.sessions).toEqual({})
  expect(useAppStore.getState().workspaceRuntimes.successor).toBeUndefined()
})
