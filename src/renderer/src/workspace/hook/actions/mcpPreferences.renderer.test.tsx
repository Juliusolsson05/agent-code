import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIGURABLE_BUILT_IN_MCP_DOMAINS } from '@mcp/shared/types'
import type { SessionSpawnOptions } from '@preload/api/types'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { useSessionActions } from './session'
import { useProviderActions } from './provider'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

vi.mock('./initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi; vi.useRealTimers() })

function setup(meta: Partial<SessionMeta> = { builtInMcpDomains: [], builtInMcpOverrides: {} }) {
  vi.useFakeTimers()
  const state = {
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'original' }, focusedSessionId: 'original' }],
    activeTabId: 'project', sessions: { original: { cwd: '/project', kind: 'codex', providerSessionId: 'native-original', ...meta } },
    detachedSessions: {}, buried: [], pinnedSessionIds: [], dispatchMode: null,
  } as WorkspaceState
  const refs = makeRefs(state), writer = stateWriter(state, refs)
  refs.latestRuntimesRef.current = { original: emptyRuntime() }
  const setRuntimes = (update: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
    refs.latestRuntimesRef.current = typeof update === 'function' ? update(refs.latestRuntimesRef.current) : update
  }
  let sequence = 0
  const spawnSession = vi.fn(async (options: SessionSpawnOptions) => ({ sessionId: `new-${++sequence}`, providerSessionId: options.resumeSessionId }))
  window.api = { ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), ghostRead: vi.fn(async () => []) }
  const hook = renderHook(() => {
    const sessions = useSessionActions(state, writer.setState, setRuntimes, refs)
    return { sessions, provider: useProviderActions(refs, setRuntimes, vi.fn(), sessions) }
  })
  const focused = () => writer.getState().tabs[0]!.focusedSessionId!
  const command = async (id: string) => {
    const run = sessionCommands.find(item => item.id === id)!.run
    await run({ workspace: {
      state: writer.getState(), replaceSession: hook.result.current.sessions.replaceSession,
      showPaneToast: vi.fn(),
    }, ui: { closePalette: vi.fn() } } as unknown as CommandContext)
  }
  return { refs, writer, hook, spawnSession, focused, command }
}

async function perform(operation: () => Promise<unknown>) {
  await act(async () => { await operation(); await vi.runAllTimersAsync() })
}

describe('global MCP preferences at actual provider replacement', () => {
  it('picks up every configurable domain on reload and drops inherited domains on the next reload', async () => {
    const h = setup()
    h.refs.defaultBuiltInMcpDomainsRef.current = [...CONFIGURABLE_BUILT_IN_MCP_DOMAINS]
    // A preference change does not claim the still-running model has new tools.
    expect(h.writer.getState().sessions.original!.builtInMcpDomains).toEqual([])
    await perform(() => h.hook.result.current.provider.reloadSessionAgent(h.focused()))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual([...CONFIGURABLE_BUILT_IN_MCP_DOMAINS])
    const first = h.writer.getState().sessions[h.focused()]!
    expect(first.builtInMcpOverrides).toEqual({})
    expect(first.tldrIdentity).toEqual(expect.any(String))
    h.refs.defaultBuiltInMcpDomainsRef.current = []
    await perform(() => h.hook.result.current.provider.reloadSessionAgent(h.focused()))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual([])
    expect(h.writer.getState().sessions[h.focused()]!.tldrIdentity).toBe(first.tldrIdentity)
  })

  it('preserves a per-agent off override and lets the reset command restore inheritance', async () => {
    const h = setup({ builtInMcpDomains: ['tldr'], builtInMcpOverrides: {} })
    h.refs.defaultBuiltInMcpDomainsRef.current = ['tldr']
    await perform(() => h.command('enable-tldr-mcp'))
    expect(h.writer.getState().sessions[h.focused()]!.builtInMcpOverrides).toEqual({ tldr: false })
    h.refs.defaultBuiltInMcpDomainsRef.current = ['tldr', 'orchestration']
    await perform(() => h.hook.result.current.provider.reloadSessionAgent(h.focused()))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual(['orchestration'])
    await perform(() => h.command('use-global-mcp-settings'))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual(['tldr', 'orchestration'])
    expect(h.writer.getState().sessions[h.focused()]!.builtInMcpOverrides).toEqual({})
  })

  it('migrates a legacy agent and resolves bulk reload through the same preference policy', async () => {
    const h = setup({ builtInMcpDomains: ['agent_transcripts'] })
    h.refs.defaultBuiltInMcpDomainsRef.current = ['tldr']
    await perform(() => h.hook.result.current.sessions.reloadAgentSessions())
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual(['tldr', 'agent_transcripts'])
    expect(h.writer.getState().sessions[h.focused()]!.builtInMcpOverrides).toEqual({ agent_transcripts: true })
  })

  it('preserves the metadata identity across an unchanged wake and replaces it when backend capabilities change', async () => {
    const h = setup({ builtInMcpDomains: ['orchestration'], builtInMcpOverrides: { tldr: false } })
    let domains = ['orchestration']
    window.api.recoverSession = vi.fn(async () => ({ ok: true, disposition: 'adopted', snapshot: {
      sessionId: 'original', kind: 'codex', cwd: '/project', lifecycle: 'live',
      input: { ready: true, revision: 1 }, builtInMcpDomains: domains,
    } })) as typeof window.api.recoverSession
    await perform(() => h.hook.result.current.sessions.ensureSessionLive('original', 'provider-switch.wake-source'))
    const first = h.writer.getState().sessions.original!
    await perform(() => h.hook.result.current.sessions.ensureSessionLive('original', 'provider-switch.wake-source'))
    // WHY object identity is correctness, not an optimisation: callers that
    // survive an await across a wake (deliverTextToSession's isCurrent, both
    // prompt-template insertion paths) compare `sessions[id] === original` to
    // ask "is my target still the same pane?". A wake that changed nothing but
    // returned a new object reads to them as "the pane was replaced", which is
    // the "insert failed the first time, worked on the retry" bug.
    //
    // This pins it through the REAL wake rather than a copy of the comparison
    // helper: the wake rebuilds the domain array AND the override map every
    // time, so any future metadata field whose value is freshly allocated has
    // to teach that comparison its shape or this test goes red.
    expect(h.writer.getState().sessions.original).toBe(first)
    domains = []
    await perform(() => h.hook.result.current.sessions.ensureSessionLive('original', 'provider-switch.wake-source'))
    expect(h.writer.getState().sessions.original).not.toBe(first)
    expect(h.writer.getState().sessions.original!.builtInMcpDomains).toEqual([])
    expect(h.writer.getState().sessions.original!.builtInMcpOverrides).toEqual({ tldr: false })
  })

  it('re-resolves a provider-filtered capability instead of recording it as refused', async () => {
    const h = setup()
    h.refs.defaultBuiltInMcpDomainsRef.current = ['workflows', 'orchestration']
    // Claude owns workflows natively, so Agent Code never injects Workflow MCP
    // into a Claude process.
    await perform(() => h.hook.result.current.sessions.replaceSession('/project', {
      kind: 'claude', targetSessionId: h.focused(), resumeSessionId: 'native-original',
    }))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual(['orchestration'])
    const narrowed = h.writer.getState().sessions[h.focused()]!
    expect(narrowed.builtInMcpDomains).toEqual(['orchestration'])
    // The narrowed list is an observation of what Claude could run, never a
    // decision to turn Workflow MCP off, so switching back must restore it.
    expect(narrowed.builtInMcpOverrides).toEqual({})
    await perform(() => h.hook.result.current.sessions.replaceSession('/project', {
      kind: 'codex', targetSessionId: h.focused(), resumeSessionId: 'native-original',
    }))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual(['workflows', 'orchestration'])
  })

  it('keeps explicit creation lists all-off even when global settings are on', async () => {
    const h = setup()
    h.refs.defaultBuiltInMcpDomainsRef.current = ['tldr', 'workflows']
    await perform(() => h.hook.result.current.sessions.spawn('/project', { kind: 'codex', builtInMcpDomains: [] }))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual([])
    const explicit = h.writer.getState().sessions['new-1']!
    for (const domain of CONFIGURABLE_BUILT_IN_MCP_DOMAINS) expect(explicit.builtInMcpOverrides?.[domain]).toBe(false)
  })
})
