import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
// The 17-field WorkspaceRefs literal is exactly what this shared harness exists
// to stop each spec re-typing; its own header asks callers to use it rather
// than drift a private copy when either signature moves.
import { makeRefs, mountUndoCloseAction, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { withoutProvisionalProviderSession } from '@renderer/workspace/providerSessionIdentity'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession: vi.fn(async () => undefined),
}))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

const predecessorId = 'local-predecessor'

function initialState(meta: Record<string, unknown>): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-a',
      title: 'recorded',
      root: { type: 'leaf' as const, sessionId: predecessorId },
      focusedSessionId: predecessorId,
    }],
    activeTabId: 'tab-a',
    sessions: { [predecessorId]: meta },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState
}

describe('spoken name identity across the agent lifecycle', () => {
  it('carries an existing identity through a provider switch and mints none on a fresh spawn', async () => {
    vi.useFakeTimers()
    const state = initialState({
      cwd: '/recorded/worktree',
      kind: 'codex',
      agentNameId: 'identity-one',
      providerSessionId: 'recorded-provider-session',
      providerSessionIdSource: 'resume-request',
      builtInMcpDomains: [],
    })
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    let runtimes: Record<SessionId, SessionRuntime> = { [predecessorId]: emptyRuntime() }
    const setRuntimes = (
      next: Record<SessionId, SessionRuntime> | ((p: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ): void => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession: vi.fn()
          .mockResolvedValueOnce({ sessionId: 'local-successor' })
          .mockResolvedValueOnce({ sessionId: 'brand-new' }),
        killOwnedSession: vi.fn(async () => false),
        ghostRead: vi.fn(async () => []),
      },
    })

    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState,
      setRuntimes,
      refs,
    ))

    await act(async () => {
      await result.current.replaceSession('/recorded/worktree', {
        kind: 'claude',
        resumeSessionId: 'recorded-provider-session',
      })
      await vi.runAllTimersAsync()
    })

    // WHY this is the sharpest assertion in the feature: replaceSession spawns
    // through the SAME spawn() the create path uses, so anything that mints an
    // identity inside spawn wins the object spread in the replacement commit
    // and the pane silently becomes a different spoken agent after a reload or
    // a provider switch.
    expect(writer.getState().sessions['local-successor']?.agentNameId).toBe('identity-one')
    expect(writer.getState().sessions[predecessorId]).toBeUndefined()

    await act(async () => {
      await result.current.spawn('/recorded/worktree', { kind: 'codex' })
      await vi.runAllTimersAsync()
    })

    // A genuinely new agent leaves identity to the reconciler, which is the one
    // place that knows the difference between "new" and "restored".
    expect(writer.getState().sessions['brand-new']?.agentNameId).toBeUndefined()
  })

  it('does not invent an identity when replacing a pane that never had one', async () => {
    // The disabled-then-enabled path: with the setting off nothing is ever
    // claimed, so a provider switch must not become a back-door minting site.
    // The successor stays unidentified and the reconciler claims it — under the
    // successor's own id — the moment the user turns names on.
    vi.useFakeTimers()
    const state = initialState({ cwd: '/recorded/worktree', kind: 'codex', builtInMcpDomains: [] })
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    let runtimes: Record<SessionId, SessionRuntime> = { [predecessorId]: emptyRuntime() }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession: vi.fn().mockResolvedValue({ sessionId: 'local-successor' }),
        killOwnedSession: vi.fn(async () => false),
        ghostRead: vi.fn(async () => []),
      },
    })

    const { result } = renderHook(() => useSessionActions(
      { activeTabId: state.activeTabId, sessions: state.sessions, tabs: state.tabs },
      writer.setState,
      next => { runtimes = typeof next === 'function' ? next(runtimes) : next; refs.latestRuntimesRef.current = runtimes },
      refs,
    ))

    await act(async () => {
      await result.current.replaceSession('/recorded/worktree', { kind: 'claude' })
      await vi.runAllTimersAsync()
    })

    expect(writer.getState().sessions['local-successor']).toBeDefined()
    expect(writer.getState().sessions['local-successor']?.agentNameId).toBeUndefined()
  })

  it('preserves the identity through the metadata rebuild that bulk reload uses', () => {
    // The rehydration path (site C) carries the identity by plain spread of
    // `withoutProvisionalProviderSession(meta)` and adds no line of its own.
    // That is only correct while this helper is field-preserving, so pin the
    // property the spread depends on rather than the spread itself.
    const meta = {
      cwd: '/recorded/worktree',
      kind: 'codex' as const,
      agentNameId: 'identity-one',
      providerSessionId: 'from-proxy',
      providerSessionIdSource: 'proxy-header' as const,
    }
    const restored = withoutProvisionalProviderSession(meta)
    expect(restored.agentNameId).toBe('identity-one')
    expect(restored.providerSessionId).toBeUndefined()
  })
})

// WHY Undo Close is part of THIS spec and not only of the MCP-continuity one
// next door: every restore path respawns with `resumeSessionId`, so the agent
// that comes back is the SAME conversation the user closed. If the identity
// does not come back with it, the reconciler claims a fresh one and the
// registry hands out a second name — Cmd-Shift-T renames a live agent, and the
// old name is spent forever because allocation never recycles. That makes undo
// a re-addressing event, which is precisely what #816 forbids, and it is a
// property of the identity rather than of the MCP credentials.
describe('spoken name identity through Undo Close', () => {
  const closedAgent = (identity: string): SessionMeta => ({
    cwd: '/recorded/worktree',
    kind: 'codex',
    title: 'the queue race',
    agentNameId: identity,
    providerSessionId: 'recorded-provider-session',
    builtInMcpDomains: [],
  } as unknown as SessionMeta)

  const anchoredState = (): WorkspaceState => ({
    tabs: [{
      id: 'tab-a',
      title: 'recorded',
      root: { type: 'leaf', sessionId: 'survivor' },
      focusedSessionId: 'survivor',
    }],
    activeTabId: 'tab-a',
    sessions: { survivor: { cwd: '/recorded/worktree', kind: 'codex' } },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState)

  it('restores a grid pane under its own identity and title', async () => {
    // The pane path used to commit only `tabs`, so the successor's metadata was
    // whatever `spawn` could rebuild — identity gone, and (pre-existing) the
    // user's title with it.
    const state = anchoredState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'pane',
      closedAt: Date.now(),
      tabId: 'tab-a',
      sessionMeta: closedAgent('identity-one'),
      direction: 'vertical',
      ratio: 0.5,
      side: 'a',
      siblingLeafId: 'survivor',
    })
    const undo = mountUndoCloseAction(state, refs, vi.fn().mockResolvedValue('restored-pane'))

    await act(async () => { await undo.actions.undoClose() })

    expect(undo.getState().sessions['restored-pane']?.agentNameId).toBe('identity-one')
    expect(undo.getState().sessions['restored-pane']?.title).toBe('the queue race')
    undo.mounted.unmount()
  })

  it('restores a detached Dispatch row under its own identity', async () => {
    // This path did write a `sessions` patch, but as a hand-written allowlist
    // that predates naming and therefore omitted `agentNameId`.
    const state = anchoredState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'detached',
      closedAt: Date.now(),
      sessionMeta: closedAgent('identity-detached'),
      record: {
        sessionId: 'old-detached',
        surface: 'dispatch',
        projectTabId: 'tab-a',
        projectTabTitle: 'recorded',
        projectTabIndex: 0,
        detachedAt: 10,
      },
    })
    const undo = mountUndoCloseAction(state, refs, vi.fn().mockResolvedValue('restored-detached'))

    await act(async () => { await undo.actions.undoClose() })

    expect(undo.getState().sessions['restored-detached']?.agentNameId).toBe('identity-detached')
    expect(undo.getState().detachedSessions['restored-detached']?.detachedAt).toBe(10)
    undo.mounted.unmount()
  })

  it('restores a whole tab, grid leaves and detached children alike, under their own identities', async () => {
    // The tab path looked safe — it built a `freshSessions` map keyed by the
    // new ids — but nothing ever read that map, so it lost exactly what the
    // pane path lost. Both of a closed tab's populations are asserted here
    // because they are respawned by two different loops.
    const state = { ...anchoredState(), tabs: [], sessions: {} } as unknown as WorkspaceState
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'tab',
      closedAt: Date.now(),
      tab: {
        id: 'closed-tab',
        title: 'closed',
        root: { type: 'leaf', sessionId: 'old-grid' },
        focusedSessionId: 'old-grid',
      },
      tabIndex: 0,
      sessionMetas: { 'old-grid': closedAgent('identity-grid') },
      detachedEntries: [{ meta: closedAgent('identity-child'), detachedAt: 10 }],
    })
    const spawn = vi.fn()
      .mockResolvedValueOnce('restored-grid')
      .mockResolvedValueOnce('restored-child')
    const undo = mountUndoCloseAction(state, refs, spawn)

    await act(async () => { await undo.actions.undoClose() })

    expect(undo.getState().sessions['restored-grid']?.agentNameId).toBe('identity-grid')
    expect(undo.getState().sessions['restored-child']?.agentNameId).toBe('identity-child')
    undo.mounted.unmount()
  })
})
