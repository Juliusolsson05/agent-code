import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { useSessionActions } from '@renderer/workspace/hook/actions/session'
import { useProviderActions } from '@renderer/workspace/hook/actions/provider'
import { makeRefs, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { SessionSpawnOptions } from '@preload/api/types'
import type { TldrRecord } from '@shared/types/tldr'
import { TldrPane } from './TldrOverlay'
import { dismissTldr, toggleTldr } from './viewState'

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); dismissTldr(); window.api = originalApi; vi.useRealTimers() })

describe('TLDR identity through real session actions', () => {
  it.each(['rewind', 'remove cyber block'] as const)('restores the saved summary after undoing %s', async operation => {
    vi.useFakeTimers()
    const state = {
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'source' }, focusedSessionId: 'source' }],
      activeTabId: 'project', sessions: {
        source: { cwd: '/project', kind: 'codex', providerSessionId: 'native-source', tldrIdentity: 'summary-source', builtInMcpDomains: ['tldr'] },
      }, detachedSessions: {}, buried: [], pinnedSessionIds: [], dispatchMode: null,
    } as WorkspaceState
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    refs.latestRuntimesRef.current = { source: emptyRuntime() }
    const setRuntimes = (next: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
      refs.latestRuntimesRef.current = typeof next === 'function' ? next(refs.latestRuntimesRef.current) : next
    }
    let sequence = 0
    const spawnSession = vi.fn(async (options: SessionSpawnOptions) => ({ sessionId: `replacement-${++sequence}`, providerSessionId: options.resumeSessionId }))
    const saved = { text: 'The original work is complete. PR #123 is merged.', revision: 1, updatedAt: '2026-09-11T00:00:00.000Z' }
    window.api = {
      ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), ghostRead: vi.fn(async () => []),
      rewindToPrompt: vi.fn(async () => ({ provider: 'codex' as const, newProviderSessionId: 'native-rewound', newFilePath: '/recorded/rewound.jsonl', promptText: 'Earlier prompt', promptTimestamp: null, promptMode: 'prompt' as const, promptImages: [] })),
      stripCodexCyberPolicy: vi.fn(async () => ({ provider: 'codex' as const, newProviderSessionId: 'native-rewound', newFilePath: '/recorded/rewound.jsonl' })),
      readTldrs: vi.fn(async (ids: string[]): Promise<Record<string, TldrRecord>> => ids.includes('summary-source') ? { 'summary-source': saved } : {}),
      onTldrChanged: () => () => {},
    }
    // Keep both action owners real. Mocking replaceSession would assert the
    // undo argument while missing the replacement owner's identity decision.
    const hook = renderHook(() => {
      const sessions = useSessionActions(state, writer.setState, setRuntimes, refs)
      return useProviderActions(refs, setRuntimes, vi.fn(), sessions)
    })
    await act(async () => {
      const result = operation === 'rewind'
        ? await hook.result.current.rewindSessionToPrompt('source', { provider: 'codex', sessionId: 'native-source', line: 1 })
        : await hook.result.current.removeCodexCyberPolicyBlock('source')
      expect(result.status).toBe('completed')
      await vi.runAllTimersAsync()
    })
    const rewoundIdentity = writer.getState().sessions['replacement-1']?.tldrIdentity
    expect(rewoundIdentity).toEqual(expect.any(String))
    expect(rewoundIdentity).not.toBe('summary-source')
    await act(async () => {
      expect((await hook.result.current.undoSessionRewind('replacement-1')).status).toBe('completed')
      await vi.runAllTimersAsync()
    })
    const restored = writer.getState().sessions['replacement-2']!
    expect(restored.providerSessionId).toBe('native-source')
    expect(spawnSession.mock.calls[1]![0].tldrIdentity).toBe('summary-source')
    expect(restored.tldrIdentity).toBe('summary-source')
    act(toggleTldr)
    await act(async () => { render(<TldrPane identity={restored.tldrIdentity!} enabled><div /></TldrPane>) })
    expect(screen.getByText(saved.text)).toBeTruthy()
  })

  it.each([
    { operation: 'reload', kind: 'claude', resumeSessionId: 'native-source', carry: true },
    { operation: 'provider translation', kind: 'codex', resumeSessionId: 'native-translated', preserveTldr: true, carry: true },
    { operation: 'rewind', kind: 'claude', resumeSessionId: 'native-rewound', carry: false },
    { operation: 'unrelated resume', kind: 'codex', resumeSessionId: 'native-other', carry: false },
    { operation: 'Goal-only reload', kind: 'claude', resumeSessionId: 'native-source', carry: true, domains: ['goal'] },
    { operation: 'Goal-only rewind', kind: 'claude', resumeSessionId: 'native-rewound', carry: false, domains: ['goal'] },
  ] as const)('persists the correct summary identity after $operation', async scenario => {
    vi.useFakeTimers()
    // Goal shares the conversation identity, so a Goal-only agent must carry,
    // mint and refuse to donate it exactly like a TLDR agent.
    const domains = 'domains' in scenario && scenario.domains ? [...scenario.domains] : ['tldr' as const]
    const state = {
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'source' }, focusedSessionId: 'source' }],
      activeTabId: 'project', sessions: {
        source: { cwd: '/project', kind: 'claude', providerSessionId: 'native-source', tldrIdentity: 'summary-source', builtInMcpDomains: domains },
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
      await hook.result.current.spawn('/project', { kind: scenario.kind, resumeSessionId: 'native-clone', builtInMcpDomains: domains })
      await vi.runAllTimersAsync()
    })
    const duplicateIdentity = writer.getState().sessions.duplicate?.tldrIdentity
    expect(duplicateIdentity).toEqual(expect.any(String))
    expect(duplicateIdentity).not.toBe(spawnedIdentity)
    expect(duplicateIdentity).not.toBe('summary-source')
  })
})
