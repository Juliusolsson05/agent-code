import { afterEach, describe, expect, it } from 'vitest'

import { claimMissingIdentities } from './reconcile'
import {
  identityCarryIsPending,
  releaseIdentityCarry,
  reserveIdentityCarry,
  resetIdentityCarryForTests,
} from './pendingIdentityCarry'
import type { WorkspaceState } from '@renderer/workspace/types'

// The leak this closes, restated because it is not obvious from the code:
//
// `spawn` deliberately does not mint an identity, so a replacement successor
// is committed to state with none. `replaceSession` then awaits
// `killSessionBackendIfOwned` — a full IPC round trip — and React flushes in
// that gap. The reconciler sees an identity-less agent, claims one, and main
// allocates a name and commits it to disk, advancing nextIndex. The
// replacement commit then overwrites the identity, orphaning that name
// forever, because the registry never recycles. The 100-name vocabulary
// therefore drained at the rate of RELOADS, not new agents.

afterEach(resetIdentityCarryForTests)

function workspace(sessions: Record<string, unknown>): WorkspaceState {
  return { sessions, buried: [] } as unknown as WorkspaceState
}

describe('identity carry reservation', () => {
  it('claims an identity for an ordinary unnamed agent', () => {
    const next = claimMissingIdentities(workspace({
      'agent-one': { cwd: '/recorded', kind: 'claude' },
    }))
    expect(next.sessions['agent-one'].agentNameId).toBe('agent-one')
  })

  it('does not claim one for a successor whose identity is already in flight', () => {
    reserveIdentityCarry('successor')
    const state = workspace({ successor: { cwd: '/recorded', kind: 'claude' } })

    const next = claimMissingIdentities(state)

    expect(next.sessions.successor.agentNameId).toBeUndefined()
    // Identity-preserving, so no downstream memo in the workspace tree is
    // invalidated by a pass that decided to do nothing.
    expect(next).toBe(state)
  })

  it('claims again as soon as the reservation is released', () => {
    // The release must genuinely re-open the claim: a stranded reservation
    // would leave that pane permanently unnamed, which is the mirror-image bug
    // and just as bad as the leak.
    reserveIdentityCarry('successor')
    releaseIdentityCarry('successor')

    const next = claimMissingIdentities(workspace({
      successor: { cwd: '/recorded', kind: 'claude' },
    }))

    expect(next.sessions.successor.agentNameId).toBe('successor')
  })

  it('reserves only the named session, never its neighbours', () => {
    reserveIdentityCarry('successor')

    const next = claimMissingIdentities(workspace({
      successor: { cwd: '/recorded', kind: 'claude' },
      bystander: { cwd: '/recorded', kind: 'codex' },
    }))

    expect(next.sessions.successor.agentNameId).toBeUndefined()
    expect(next.sessions.bystander.agentNameId).toBe('bystander')
  })

  it('treats releasing an unreserved id as a no-op', () => {
    // replaceSession releases in a `finally` that also covers paths where no
    // reservation was ever taken (an ordinary spawn carries no identity).
    expect(() => releaseIdentityCarry('never-reserved')).not.toThrow()
    expect(identityCarryIsPending('never-reserved')).toBe(false)
  })
})
