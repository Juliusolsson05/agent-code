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
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

vi.mock('./initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi; vi.useRealTimers() })

function setup(meta: Partial<SessionMeta> = { builtInMcpDomains: [], builtInMcpOverrides: {} }) {
  vi.useFakeTimers()
  const state = {
    tabs: [{ id: 'project', title: 'Project' }],
    activeTabId: 'project', sessions: { original: { cwd: '/project', kind: 'codex', providerSessionId: 'native-original', ...meta, projectId: 'project', joinedAt: 0 } },
      pinnedSessionIds: [], stage: oneLaneStage('original'),
  } as WorkspaceState
  const refs = makeRefs(state), writer = stateWriter(state, refs)
  // `started`: the agent HAS a backend. Reload-all restarts only sessions with
  // one (#992) — it asks the runtime, where it used to ask "is this a tile
  // leaf". An `idle` runtime is a parked agent, which a reload deliberately
  // leaves parked (that is the #258 fork-bomb guard), so with the default
  // runtime the bulk-reload case below spawned nothing and read `undefined`.
  refs.latestRuntimesRef.current = { original: { ...emptyRuntime(), processStatus: 'started' } }
  const setRuntimes = (update: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
    refs.latestRuntimesRef.current = typeof update === 'function' ? update(refs.latestRuntimesRef.current) : update
  }
  let sequence = 0
  const spawnSession = vi.fn(async (options: SessionSpawnOptions) => ({ sessionId: `new-${++sequence}`, providerSessionId: options.resumeSessionId }))
  window.api = { ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), ghostRead: vi.fn(async () => []), controlGoalLoop: vi.fn(async () => null) }
  const hook = renderHook(() => {
    const sessions = useSessionActions(state, writer.setState, setRuntimes, refs)
    return { sessions, provider: useProviderActions(refs, setRuntimes, vi.fn(), sessions) }
  })
  // The commanded session: the focused lane's occupant. (Tree era: the tab's focus.)
  const focused = () => writer.getState().stage.lanes[writer.getState().stage.focusedLane]!.selectedSessionId!
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

  it.each([
    { domain: 'tldr', commandId: 'enable-tldr-mcp' },
    { domain: 'goal', commandId: 'enable-goal-mcp' },
    // #1006: the sibling command goal_loop lacked.
    { domain: 'goal_loop', commandId: 'enable-goal-loop-mcp' },
  ] as const)('preserves a per-agent $domain off override and lets the reset command restore inheritance', async ({ domain, commandId }) => {
    const h = setup({ builtInMcpDomains: [domain], builtInMcpOverrides: {} })
    h.refs.defaultBuiltInMcpDomainsRef.current = [domain]
    await perform(() => h.command(commandId))
    expect(h.writer.getState().sessions[h.focused()]!.builtInMcpOverrides).toEqual({ [domain]: false })
    h.refs.defaultBuiltInMcpDomainsRef.current = [domain, 'orchestration']
    await perform(() => h.hook.result.current.provider.reloadSessionAgent(h.focused()))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual(['orchestration'])
    await perform(() => h.command('use-global-mcp-settings'))
    expect(h.spawnSession.mock.calls.at(-1)![0].builtInMcpDomains).toEqual([domain, 'orchestration'])
    expect(h.writer.getState().sessions[h.focused()]!.builtInMcpOverrides).toEqual({})
  })

  it('ends a running goal loop when its tools are turned off (#1045 review)', async () => {
    // The loop is harness-owned and survives the reload, but the reloaded
    // agent has no goal_loop_complete: it could never report success, and
    // every continuation would run to the cap. The stop names the session the
    // loop is filed under, before the replacement exists.
    const controlGoalLoop = vi.fn(async () => null)
    const h = setup({ builtInMcpDomains: ['goal_loop'], builtInMcpOverrides: {} })
    window.api = { ...window.api, controlGoalLoop }
    h.refs.defaultBuiltInMcpDomainsRef.current = ['goal_loop']
    await perform(() => h.command('enable-goal-loop-mcp'))
    expect(controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'original', action: 'stop' })
    // Turning them back ON must not touch the loop.
    controlGoalLoop.mockClear()
    await perform(() => h.command('enable-goal-loop-mcp'))
    expect(controlGoalLoop).not.toHaveBeenCalled()
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
