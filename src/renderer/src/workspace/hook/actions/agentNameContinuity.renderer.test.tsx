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
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

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
    }],
    activeTabId: 'tab-a',
    sessions: { [predecessorId]: { ...meta, projectId: 'tab-a', joinedAt: 0 }},
    pinnedSessionIds: [],
    stage: oneLaneStage(predecessorId),
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
    }],
    activeTabId: 'tab-a',
    sessions: { survivor: { cwd: '/recorded/worktree', kind: 'codex', projectId: 'tab-a', joinedAt: 0 } },
    pinnedSessionIds: [],
    stage: oneLaneStage('survivor'),
  } as unknown as WorkspaceState)

  // Until #992 there were three restore paths (a split pane re-inserted beside
  // its sibling, a Dispatch row re-filed from its record, a tab remapped leaf
  // by leaf) and each had lost this metadata in its own way: the pane path
  // committed only `tabs`, the row path used a hand-written allowlist that
  // predated naming, and the tab path built a `freshSessions` map nothing ever
  // read. There are two paths now, and both go through carryDurableMeta.

  it('restores a closed session under its own identity, title and place', async () => {
    const state = anchoredState()
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'session',
      closedAt: Date.now(),
      sessionId: 'old-session',
      sessionMeta: { ...closedAgent('identity-one'), projectId: 'tab-a', joinedAt: 10 },
    })
    const undo = mountUndoCloseAction(state, refs, vi.fn().mockResolvedValue('restored-session'))

    await act(async () => { await undo.actions.undoClose() })

    const restored = undo.getState().sessions['restored-session']
    expect(restored?.agentNameId).toBe('identity-one')
    expect(restored?.title).toBe('the queue race')
    // Membership is durable metadata `spawn` never sees, exactly like the
    // identity: without it the restored agent would be unowned and pruned.
    expect(restored).toMatchObject({ projectId: 'tab-a', joinedAt: 10 })
    undo.mounted.unmount()
  })

  it('restores a whole project under its sessions own identities', async () => {
    const state = { ...anchoredState(), tabs: [], sessions: {} } as unknown as WorkspaceState
    const refs = makeRefs(state)
    refs.undoStackRef.current.push({
      type: 'tab',
      closedAt: Date.now(),
      tab: { id: 'closed-tab', title: 'closed' },
      tabIndex: 0,
      sessions: [
        { sessionId: 'old-first', meta: { ...closedAgent('identity-grid'), projectId: 'closed-tab', joinedAt: 0 } },
        { sessionId: 'old-child', meta: { ...closedAgent('identity-child'), projectId: 'closed-tab', joinedAt: 10 } },
      ],
    })
    const spawn = vi.fn()
      .mockResolvedValueOnce('restored-first')
      .mockResolvedValueOnce('restored-child')
    const undo = mountUndoCloseAction(state, refs, spawn)

    await act(async () => { await undo.actions.undoClose() })

    const after = undo.getState()
    expect(after.sessions['restored-first']?.agentNameId).toBe('identity-grid')
    expect(after.sessions['restored-child']?.agentNameId).toBe('identity-child')
    // The project came back under a NEW id, and its sessions name that id.
    expect(after.tabs).toHaveLength(1)
    expect(after.tabs[0]!.id).not.toBe('closed-tab')
    expect(after.sessions['restored-first']).toMatchObject({ projectId: after.tabs[0]!.id, joinedAt: 0 })
    expect(after.sessions['restored-child']).toMatchObject({ projectId: after.tabs[0]!.id, joinedAt: 10 })
    undo.mounted.unmount()
  })
})
