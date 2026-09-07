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

// WHY a real component with real useState instead of renderHook with a manual
// setState closure: the hook's whole job is to write into workspace state and
// then react to the state it just wrote. A hand-rolled setter that does not
// re-render would make the second effect read the pre-claim state forever, and
// the test would pass while the app allocated nothing. React's own setter has
// exactly the WorkspaceSetState shape (value or updater), so this is also a
// type-level check that the hook can be wired into the real composer.
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
  it('claims identities for agents only, resolves them once, and stores the names', async () => {
    const resolveAgentNames = vi.fn(async (identities: string[]) =>
      Object.fromEntries(identities.map(identity => [identity, identity === 'agent-one' ? 'Apollo' : 'Jasper'])))
    const mounted = mount({ enabled: true, resolveAgentNames })

    await waitFor(() => expect(resolveAgentNames).toHaveBeenCalled())

    expect(mounted.seen.current.sessions['agent-one'].agentNameId).toBe('agent-one')
    // A shell has no conversation to address; naming it would advertise an
    // unroutable target to a voice operator.
    expect(mounted.seen.current.sessions['shell-one'].agentNameId).toBeUndefined()
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
    expect([...resolveAgentNames.mock.calls[0][0]].sort()).toEqual(['agent-one', 'identity-buried'])
    expect(resolveAgentNames).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(useAppStore.getState().workspaceAgentNames)
      .toEqual({ 'agent-one': 'Apollo', 'identity-buried': 'Jasper' }))

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
})
