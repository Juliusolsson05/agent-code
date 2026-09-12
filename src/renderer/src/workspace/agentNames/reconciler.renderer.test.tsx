import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { resolveAgentName } from '@renderer/workspace/agentNames/selectors'
import { useAgentNameReconciler } from '@renderer/workspace/agentNames/useAgentNameReconciler'
import type { WorkspaceState } from '@renderer/workspace/types'

const initialStore = useAppStore.getState()
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  useAppStore.setState(initialStore, true)
  if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'api')
})

function workspace(): WorkspaceState {
  return {
    tabs: [{ id: 'tab-a', title: 'recorded', root: { type: 'leaf', sessionId: 'agent-one' }, focusedSessionId: 'agent-one' }],
    activeTabId: 'tab-a',
    sessions: {
      'agent-one': { cwd: '/recorded', kind: 'claude' },
      'shell-one': { cwd: '/recorded', kind: 'terminal' },
    },
    detachedSessions: {},
    buried: [{
      id: 'buried-one',
      sessionId: 'buried-one',
      sessionMeta: { cwd: '/recorded', kind: 'codex', agentNameId: 'identity-buried' },
      buriedAt: 0,
      sourceTabId: 'tab-a',
      sourceTabTitle: 'recorded',
      sourceTabIndex: 0,
    }],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState
}

// One agent whose durable identity is the string "__proto__" — reachable by
// hand-editing workspace.json, and the shape every own-property guard in this
// feature exists for.
function hostileWorkspace(): WorkspaceState {
  return {
    ...workspace(),
    sessions: { 'agent-one': { cwd: '/recorded', kind: 'claude', agentNameId: '__proto__' } },
    buried: [],
  } as unknown as WorkspaceState
}

// A workspace whose identities are the WRONG TYPE rather than a hostile string:
// a number on a live session and an object on a buried record, both reachable
// from a hand-edited or migration-damaged workspace.json.
function malformedWorkspace(): WorkspaceState {
  const base = workspace()
  return {
    ...base,
    sessions: {
      'agent-one': { cwd: '/recorded', kind: 'claude', agentNameId: 42 },
      'shell-one': base.sessions['shell-one'],
    },
    buried: [{ ...base.buried[0], sessionMeta: { cwd: '/recorded', kind: 'codex', agentNameId: { id: 'nope' } } }],
  } as unknown as WorkspaceState
}

// WHY a real component with real useState instead of renderHook with a manual
// setState closure: the hook's whole job is to write into workspace state and
// then react to the state it just wrote. A hand-rolled setter that does not
// re-render would make the second effect read the pre-claim state forever, and
// the test would pass while the app allocated nothing. React's own setter has
// exactly the WorkspaceSetState shape (value or updater), so this is also a
// type-level check that the hook can be wired into the real composer.
function mount(options: {
  enabled: boolean
  resolveAgentNames: ReturnType<typeof vi.fn>
  initial?: WorkspaceState
}) {
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, agentNamesEnabled: options.enabled } })
  Object.defineProperty(window, 'api', { configurable: true, value: { resolveAgentNames: options.resolveAgentNames } })

  const seen: { current: WorkspaceState } = { current: options.initial ?? workspace() }
  // Lets a test move the workspace on while an allocation is still in flight.
  const control: { current: Dispatch<SetStateAction<WorkspaceState>> | null } = { current: null }
  function Harness() {
    const [state, setState] = useState<WorkspaceState>(seen.current)
    useEffect(() => { seen.current = state; control.current = setState }, [state])
    useAgentNameReconciler(state, setState, 'complete-restore')
    return null
  }
  const view = render(<Harness />)
  return { seen, control, rerender: () => view.rerender(<Harness />) }
}

describe('agent name reconciliation', () => {
  it('claims identities for every session, resolves them once, and stores the names', async () => {
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, identity === 'agent-one' ? 'Apollo' : 'Jasper'])))
    const mounted = mount({ enabled: true, resolveAgentNames })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())

    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBe('agent-one')
    // Shells are named too (#865): the claim covers every session kind.
    expect(mounted.seen.current.sessions['shell-one'].agentNameId).toBe('shell-one')
    // Buried agents keep their own metadata copy and must still resolve, or a
    // buried Apollo would come back unnamed and get a second address.
    //
    // WHY the FIRST call must already contain both: the hook derives its
    // identity list through `claimMissingIdentities(state)` rather than from
    // `state`, so on the very first render it sees `agent-one`'s
    // about-to-be-claimed identity alongside the buried agent's existing one.
    // Deriving from `state` would split this into two requests — and the
    // re-run triggered by the claim would then discard the first reply.
    // Asserting on call[0] rather than on the union is what pins that.
    expect([...resolveAgentNames.mock.calls[0][0]].sort()).toEqual(['agent-one', 'identity-buried', 'shell-one'])
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useAppStore.getState().workspaceAgentNames)
      .toEqual({ 'agent-one': 'Apollo', 'identity-buried': 'Jasper', 'shell-one': 'Jasper' }))

    // Stable membership must not re-ask: allocation is the expensive, durable
    // side effect and a re-render is not a membership change.
    const callCount = resolveAgentNames.mock.calls.length
    act(() => { mounted.rerender() })
    expect(resolveAgentNames).toHaveBeenCalledTimes(callCount)
  })

  it('claims nothing and asks for nothing while the setting is off', async () => {
    const resolveAgentNames = vi.fn(async () => ({}))
    const mounted = mount({ enabled: false, resolveAgentNames })

    await act(async () => { await Promise.resolve() })

    expect(resolveAgentNames).not.toHaveBeenCalled()
    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBeUndefined()
    expect(useAppStore.getState().workspaceAgentNames).toEqual({})
  })

  it('claims and resolves the agents that already exist when the setting is switched on', async () => {
    // The hook's own header promises this — "enabling is what assigns names to
    // the agents that already exist" — and nothing else in this spec exercises
    // it: every other case decides `enabled` before mount. The realistic
    // sequence is the opposite, because the setting ships OFF: the user has a
    // full workspace running and then discovers the toggle.
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, identity === 'agent-one' ? 'Apollo' : 'Jasper'])))
    const mounted = mount({ enabled: false, resolveAgentNames })

    await act(async () => { await Promise.resolve() })
    expect(resolveAgentNames).not.toHaveBeenCalled()
    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBeUndefined()

    // Flipping the real setting, not a remount: the reconciler subscribes to
    // the store, so this is the same re-render the Settings toggle causes.
    act(() => {
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, agentNamesEnabled: true } })
    })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await waitFor(() => expect(useAppStore.getState().workspaceAgentNames)
      .toEqual({ 'agent-one': 'Apollo', 'identity-buried': 'Jasper', 'shell-one': 'Jasper' }))

    // One claim and one request, not one per agent and not one per re-render:
    // enabling is a single membership event, and allocation is durable. Shells
    // are claimed on this same pass too (#865), same as every other kind.
    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBe('agent-one')
    expect(mounted.seen.current.sessions['shell-one'].agentNameId).toBe('shell-one')
    expect([...resolveAgentNames.mock.calls[0][0]].sort()).toEqual(['agent-one', 'identity-buried', 'shell-one'])
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)
  })

  it('re-claims a malformed identity instead of leaving the agent permanently unnamed', async () => {
    // A truthiness-only skip treats `agentNameId: 42` as "already identified",
    // while resolveAgentName — which needs an own STRING key of the name map —
    // reports null forever. The agent then has no name and no route to one.
    // The buried record is the other half: it never passes through the claim
    // at all, so a non-string there would reach the IPC allocator, whose
    // z.array(z.string().min(1)) rejects the WHOLE batch and blocks naming for
    // every agent in the window.
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, 'Apollo'])))
    const mounted = mount({ enabled: true, resolveAgentNames, initial: malformedWorkspace() })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBe('agent-one')
    // The fixture's shell also has no identity yet, so the same reclaim pass
    // picks it up alongside the malformed agent (#865): the claim no longer
    // distinguishes provider kind, only "already identified or not".
    expect(resolveAgentNames.mock.calls[0][0]).toEqual(['agent-one', 'shell-one'])
    expect(resolveAgentName({
      enabled: true,
      meta: mounted.seen.current.sessions['agent-one'],
      names: useAppStore.getState().workspaceAgentNames,
    })).toBe('Apollo')
  })

  it('leaves the map untouched when allocation fails', async () => {
    const resolveAgentNames = vi.fn(async () => { throw new Error('registry unreadable') })
    mount({ enabled: true, resolveAgentNames })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    // No fabrication, no placeholder, no partial write. A failed allocation is
    // simply an agent with no visible name until the next membership change.
    expect(useAppStore.getState().workspaceAgentNames).toEqual({})
  })

  it('applies a reply that arrives after the agent was replaced or closed', async () => {
    // The decomposition names this exact unknown: "assignment arriving after
    // close or replacement". Disk is slow and allocation is durable, so the
    // window between asking and answering is real, and both things that can
    // happen inside it are tested here at once.
    let release: (value: Record<string, string>) => void = () => {}
    // The parameter is declared even though the deferred body ignores it:
    // `mock.calls[0][0]` is typed from the mock's OWN signature, so a
    // zero-argument implementation gives an empty call tuple and the read
    // below is a tsc error — while the reconciler really does pass the
    // identity list this test then replies to.
    const resolveAgentNames = vi.fn((_identities: string[]) =>
      new Promise<Record<string, string>>(resolve => { release = resolve }))
    const mounted = mount({ enabled: true, resolveAgentNames })
    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    const requested = [...resolveAgentNames.mock.calls[0][0]] as string[]

    // While the allocation is in flight: the live agent is replaced by a new
    // local session id CARRYING the same identity, and the buried agent is
    // closed outright.
    act(() => {
      mounted.control.current!(previous => ({
        ...previous,
        sessions: {
          'agent-two': { ...previous.sessions['agent-one'], agentNameId: 'agent-one' },
          'shell-one': previous.sessions['shell-one'],
        },
        buried: [],
      } as WorkspaceState))
    })

    await act(async () => {
      release(Object.fromEntries(requested.map(identity =>
        [identity, identity === 'agent-one' ? 'Apollo' : 'Jasper'])))
      await Promise.resolve()
    })

    const stored = useAppStore.getState().workspaceAgentNames
    const settled = mounted.seen.current

    // Keyed by identity, never by session: the successor inherits the name
    // that was allocated before its local session id existed. This is the
    // whole reason SessionMeta carries an identity instead of the name.
    expect(stored['agent-one']).toBe('Apollo')
    expect(resolveAgentName({ enabled: true, meta: settled.sessions['agent-two'], names: stored })).toBe('Apollo')

    // The closed agent's reply is recorded against its identity — the name is
    // spent and must never be handed out again — but it does NOT put the
    // session back into the workspace.
    expect(stored['identity-buried']).toBe('Jasper')
    expect(settled.sessions['agent-one']).toBeUndefined()
    expect(settled.buried).toEqual([])

    // And the late reply did not trigger a second allocation for either.
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)
  })

  it('stores a name for a "__proto__" identity as an own property and asks exactly once', async () => {
    // The termination test for the merge. Writing this reply with
    // `merged[identity] = name` hits the prototype setter: the value vanishes,
    // the comparison against Object.prototype still reports a change, `names`
    // gets a new reference, the effect re-runs, the identity is STILL not an
    // own property, and it is requested again — forever. The assertion that
    // catches it is the call count after a settled reply, not the stored value.
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, 'Apollo'])))
    const mounted = mount({ enabled: true, resolveAgentNames, initial: hostileWorkspace() })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    const stored = useAppStore.getState().workspaceAgentNames
    expect(resolveAgentNames.mock.calls[0][0]).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(stored, '__proto__')?.value).toBe('Apollo')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)

    // requestedRef cleared on settle, so this re-render is the moment a
    // non-own-property merge would ask again.
    act(() => { mounted.rerender() })
    await act(async () => { await Promise.resolve() })
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)

    // And the selector reads it back through its own own-property guard.
    expect(resolveAgentName({
      enabled: true,
      meta: mounted.seen.current.sessions['agent-one'],
      names: stored,
    })).toBe('Apollo')
  })

  it('stops re-asking a broken registry after a few failures for the same set', async () => {
    // `identities` is a memo over workspace state and returns a fresh array on
    // every workspace change, and the request set is cleared on SETTLE. With an
    // unreadable agent-names.json — a state the registry deliberately never
    // caches — every focus change, title edit, pin, split and close therefore
    // fired another failing IPC round trip, forever, with nothing visible to
    // the user. The effect's own comment claimed that could not happen.
    const resolveAgentNames = vi.fn(async () => { throw new Error('registry unreadable') })
    const mounted = mount({ enabled: true, resolveAgentNames })
    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    // Nudge the workspace repeatedly without changing WHICH identities exist.
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        mounted.control.current?.(prev => ({ ...prev, activeTabId: `tab-${i}` }))
        await Promise.resolve()
      })
    }

    // Three attempts, not one: a rejection can be a transient collision on the
    // shared serialization tail, so giving up immediately would leave agents
    // unnamed for a condition that fixes itself.
    expect(resolveAgentNames.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('asks again once the identity set actually changes', async () => {
    // The breaker must not become a permanent mute: a new agent is a new
    // question, and the registry may have been repaired since.
    const resolveAgentNames = vi.fn(async () => { throw new Error('registry unreadable') })
    const mounted = mount({ enabled: true, resolveAgentNames })
    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        mounted.control.current?.(prev => ({ ...prev, activeTabId: `tab-${i}` }))
        await Promise.resolve()
      })
    }
    const beforeNewAgent = resolveAgentNames.mock.calls.length

    await act(async () => {
      mounted.control.current?.(prev => ({
        ...prev,
        sessions: { ...prev.sessions, 'agent-two': { cwd: '/recorded', kind: 'claude' } },
      }))
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(resolveAgentNames.mock.calls.length).toBeGreaterThan(beforeNewAgent))
  })

  it('treats an over-long identity as absent, so one bad record cannot mute the window', async () => {
    // main validates z.string().min(1).max(200) over the WHOLE array, so a
    // single hand-edited identity longer than that made requestSchema.parse
    // reject every identity in the batch — and the reconciler swallows that
    // silently, so no agent in the window ever received a name. The renderer's
    // own comment named main's schema verbatim but mirrored only its type half.
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, 'Apollo'])))
    const base = workspace()
    const initial = {
      ...base,
      sessions: {
        ...base.sessions,
        'agent-long': { cwd: '/recorded', kind: 'claude', agentNameId: 'x'.repeat(201) },
      },
    } as unknown as WorkspaceState
    mount({ enabled: true, resolveAgentNames, initial })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })

    const asked = resolveAgentNames.mock.calls.flatMap(call => call[0])
    expect(asked.some(identity => identity.length > 200)).toBe(false)
    // And the agent heals rather than staying stuck: an unusable identity is
    // re-claimed exactly like a malformed one.
    expect(asked).toContain('agent-long')
  })
})
