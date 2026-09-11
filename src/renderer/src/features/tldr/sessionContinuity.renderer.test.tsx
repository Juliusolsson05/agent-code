import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { useSessionActions } from '@renderer/workspace/hook/actions/session'
import { makeRefs, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { SessionSpawnOptions } from '@preload/api/types'

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi; vi.useRealTimers() })

describe('TLDR identity through real session actions', () => {
  it.each([
    { operation: 'reload', kind: 'claude', resumeSessionId: 'native-source', carry: true },
    { operation: 'provider translation', kind: 'codex', resumeSessionId: 'native-translated', preserveTldr: true, carry: true },
    { operation: 'rewind', kind: 'claude', resumeSessionId: 'native-rewound', carry: false },
    { operation: 'unrelated resume', kind: 'codex', resumeSessionId: 'native-other', carry: false },
  ] as const)('persists the correct summary identity after $operation', async scenario => {
    vi.useFakeTimers()
    const state = {
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'source' }, focusedSessionId: 'source' }],
      activeTabId: 'project', sessions: {
        source: { cwd: '/project', kind: 'claude', providerSessionId: 'native-source', tldrIdentity: 'summary-source', builtInMcpDomains: ['tldr'] },
      }, detachedSessions: {}, buried: [], pinnedSessionIds: [], dispatchMode: null,
    } as WorkspaceState
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    refs.latestRuntimesRef.current = { source: emptyRuntime() }
    const setRuntimes = (next: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
      refs.latestRuntimesRef.current = typeof next === 'function' ? next(refs.latestRuntimesRef.current) : next
    }
    const spawnSession = vi.fn(async (_options: SessionSpawnOptions) => ({ sessionId: 'successor' }))
    window.api = { ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), ghostRead: vi.fn(async () => []) }
    const hook = renderHook(() => useSessionActions(state, writer.setState, setRuntimes, refs))
    await act(async () => {
      await hook.result.current.replaceSession('/project', {
        kind: scenario.kind, resumeSessionId: scenario.resumeSessionId,
        ...('preserveTldr' in scenario ? { preserveTldr: scenario.preserveTldr } : {}),
      })
      await vi.runAllTimersAsync()
    })
    const spawnedIdentity = spawnSession.mock.calls[0]![0].tldrIdentity
    expect(spawnedIdentity).toEqual(expect.any(String))
    expect(spawnedIdentity === 'summary-source').toBe(scenario.carry)
    expect(writer.getState().sessions.successor?.tldrIdentity).toBe(spawnedIdentity)
    expect(writer.getState().tabs[0]?.focusedSessionId).toBe('successor')

    // A duplicate uses spawn with a cloned transcript. Neither the source's
    // metadata nor the last replacement may donate its completion statement.
    spawnSession.mockResolvedValueOnce({ sessionId: 'duplicate' })
    await act(async () => {
      await hook.result.current.spawn('/project', { kind: scenario.kind, resumeSessionId: 'native-clone', builtInMcpDomains: ['tldr'] })
      await vi.runAllTimersAsync()
    })
    const duplicateIdentity = writer.getState().sessions.duplicate?.tldrIdentity
    expect(duplicateIdentity).toEqual(expect.any(String))
    expect(duplicateIdentity).not.toBe(spawnedIdentity)
    expect(duplicateIdentity).not.toBe('summary-source')
  })
})
