import { describe, expect, it, vi } from 'vitest'

import {
  closeOrchestrationAgent,
  closeOrchestrationRun,
} from '@renderer/workspace/orchestrationMcp'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// These two functions decide what an orchestrating agent is TOLD about a close,
// and that report is acted on — a parent that believes a child closed will stop
// waiting on it. The reporting was previously unconditional: every id went into
// `closedSessionIds` whether or not the close took. So the contract worth
// pinning is not "does it call closeSession" but "does it tell the truth".
//
// The unconditional confirmation these calls used to raise is gone, replaced by
// `silentIfSoleTarget` (see the WHY on OrchestrationCloseSession). That option
// is the whole safety argument: it stays silent when the close kills exactly
// the named agent, and asks when it would reach further — a linked agent the
// user attached, or a tab's sole leaf taking every detached session with it.
//
// So the option itself is part of the contract in both directions: a regression
// that swapped it for `preConfirmed: true` would destroy user-created sessions
// silently, and one that dropped it entirely would put a dialog back in front of
// routine fleet cleanup.

const PARENT = 'parent-1' as SessionId

const child = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  cwd: '/tmp/project',
  kind: 'claude',
  orchestrationParentId: PARENT,
  orchestrationRootId: PARENT,
  ...overrides,
}) as SessionMeta

/**
 * Narrow harness: both functions under test read ONLY `state.sessions`, so a
 * bare sessions map is the whole input surface.
 *
 * WHY the `unknown` cast (which docs/testing/standard.md otherwise forbids):
 * `WorkspaceState` carries a dozen fields — tabs, detachedSessions, dispatch
 * mode, tile tree — that neither function touches, and building them would be
 * a fixture that lies about what is being exercised.
 *
 * WHAT WOULD REMOVE IT: if either function starts reading `state.tabs` or
 * `state.detachedSessions`, this cast will keep compiling while the fixture
 * silently supplies `undefined`. That is exactly where `closeSession`'s own
 * true/false answer comes from, so if these functions ever reach for it, build
 * a real state factory instead of widening this one.
 */
const stateWith = (sessions: Record<string, SessionMeta>): WorkspaceState =>
  ({ sessions } as unknown as WorkspaceState)

describe('closeOrchestrationAgent', () => {
  it('closes without raising a confirmation', async () => {
    const closeSession = vi.fn().mockResolvedValue(true)
    await closeOrchestrationAgent({
      state: stateWith({ 'child-1': child() }),
      parentSessionId: PARENT,
      sessionId: 'child-1',
      closeSession,
    })
    // NOT preConfirmed: the ownership gate scopes which session may be NAMED,
    // not which sessions die, so the decision has to be made where the full
    // expanded target set is computable.
    expect(closeSession).toHaveBeenCalledWith('child-1', {
      silentIfSoleTarget: { headline: expect.stringContaining('asking to close') },
    })
  })

  it('reports the id as closed when the close took', async () => {
    const result = await closeOrchestrationAgent({
      state: stateWith({ 'child-1': child() }),
      parentSessionId: PARENT,
      sessionId: 'child-1',
      closeSession: vi.fn().mockResolvedValue(true),
    })
    expect(result).toEqual({ closedSessionIds: ['child-1'] })
  })

  it('reports the id as SKIPPED when the close did not take', async () => {
    // The regression this exists for: the old code returned the id in
    // closedSessionIds unconditionally, so an already-gone agent was reported
    // as closed and the parent proceeded on that.
    const result = await closeOrchestrationAgent({
      state: stateWith({ 'child-1': child() }),
      parentSessionId: PARENT,
      sessionId: 'child-1',
      closeSession: vi.fn().mockResolvedValue(false),
    })
    expect(result).toEqual({ closedSessionIds: [], skippedSessionIds: ['child-1'] })
  })

  it('reports a thrown close as skipped rather than failing the tool call', async () => {
    // close_agent had no catch: killSessionBackendIfOwned is IPC and can
    // reject, and it runs AFTER closeLinkedChildren — so a bare throw could
    // surface as a tool error while children were already gone, reported as
    // neither closed nor skipped.
    const result = await closeOrchestrationAgent({
      state: stateWith({ 'child-1': child() }),
      parentSessionId: PARENT,
      sessionId: 'child-1',
      closeSession: vi.fn().mockRejectedValue(new Error('backend kill failed')),
    })
    expect(result).toEqual({ closedSessionIds: [], skippedSessionIds: ['child-1'] })
  })

  it('refuses a session the caller does not own', async () => {
    // The ownership gate is the safety property that removing the dialog rests
    // on, so it is pinned here rather than assumed.
    const closeSession = vi.fn().mockResolvedValue(true)
    await expect(
      closeOrchestrationAgent({
        state: stateWith({
          stranger: child({ orchestrationParentId: 'someone-else' as SessionId, orchestrationRootId: 'someone-else' as SessionId }),
        }),
        parentSessionId: PARENT,
        sessionId: 'stranger',
        closeSession,
      }),
    ).rejects.toThrow(/not found/i)
    expect(closeSession).not.toHaveBeenCalled()
  })
})

describe('closeOrchestrationRun', () => {
  it('closes every child without a confirmation on any of them', async () => {
    const closeSession = vi.fn().mockResolvedValue(true)
    const result = await closeOrchestrationRun({
      state: stateWith({ 'c1': child(), 'c2': child(), 'c3': child() }),
      parentSessionId: PARENT,
      closeSession,
    })
    expect(result.closedSessionIds.sort()).toEqual(['c1', 'c2', 'c3'])
    // Previously the FIRST call carried requireConfirmation and the rest rode
    // that answer, which meant one decline silently mis-reported the rest.
    // Now every call carries the same sole-target mode and is judged on its own
    // blast radius.
    for (const call of closeSession.mock.calls) {
      expect(call[1]).toEqual({
        silentIfSoleTarget: { headline: expect.stringContaining('asking to close') },
        // A run close is a fleet reaping its own children, often a dozen at
        // once. Capturing an undo entry each would evict the user's own close
        // history from the 10-entry stack in favour of rows they never opened
        // by hand (#672 review). Asserted as an exact object on purpose: this
        // is a deliberate opt-out, and it should have to be re-stated here if
        // anyone changes it.
        captureUndo: false,
      })
    }
  })

  it('separates the ones that did not close', async () => {
    const closeSession = vi.fn(async (id: string) => id !== 'c2')
    const result = await closeOrchestrationRun({
      state: stateWith({ 'c1': child(), 'c2': child(), 'c3': child() }),
      parentSessionId: PARENT,
      closeSession,
    })
    expect(result.closedSessionIds.sort()).toEqual(['c1', 'c3'])
    expect(result.skippedSessionIds).toEqual(['c2'])
  })

  it('names the requesting agent in the fallback headline', async () => {
    // The headline is only ever shown when the close reaches past the named
    // agent — a dialog the user did not summon. It has to say who asked.
    const closeSession = vi.fn().mockResolvedValue(true)
    await closeOrchestrationRun({
      state: stateWith({
        [PARENT]: { cwd: '/tmp/p', kind: 'claude', title: 'Reviewer' } as SessionMeta,
        c1: child(),
      }),
      parentSessionId: PARENT,
      closeSession,
    })
    expect(closeSession.mock.calls[0][1].silentIfSoleTarget.headline).toContain('Reviewer')
  })

  it('treats a thrown close as a skip and keeps going', async () => {
    // One agent whose backend kill fails must not abort the rest of the run.
    const closeSession = vi.fn(async (id: string) => {
      if (id === 'c1') throw new Error('backend kill failed')
      return true
    })
    const result = await closeOrchestrationRun({
      state: stateWith({ 'c1': child(), 'c2': child() }),
      parentSessionId: PARENT,
      closeSession,
    })
    expect(result.skippedSessionIds).toEqual(['c1'])
    expect(result.closedSessionIds).toEqual(['c2'])
  })

  it('omits skippedSessionIds entirely when nothing was skipped', async () => {
    // The field is optional in the result contract; emitting an empty array
    // would make a caller that checks presence think something went wrong.
    const result = await closeOrchestrationRun({
      state: stateWith({ 'c1': child() }),
      parentSessionId: PARENT,
      closeSession: vi.fn().mockResolvedValue(true),
    })
    // `in`, not toBeUndefined: the latter also passes for an explicitly-present
    // `undefined`, which is not what "omits entirely" claims.
    expect('skippedSessionIds' in result).toBe(false)
  })

  it('closes only the named run when a runId is given', async () => {
    // With the unconditional dialog gone, this filter is the only thing
    // separating "close this run" from "close every child I have ever
    // started". It had no coverage at all before.
    const closeSession = vi.fn().mockResolvedValue(true)
    await closeOrchestrationRun({
      state: stateWith({
        a1: child({ orchestrationRunId: 'run-a' } as Partial<SessionMeta>),
        a2: child({ orchestrationRunId: 'run-a' } as Partial<SessionMeta>),
        b1: child({ orchestrationRunId: 'run-b' } as Partial<SessionMeta>),
      }),
      parentSessionId: PARENT,
      runId: 'run-a',
      closeSession,
    })
    expect(closeSession.mock.calls.map(c => c[0]).sort()).toEqual(['a1', 'a2'])
  })

  it('excludes non-agent sessions such as terminals', async () => {
    // A terminal parked in the same run is not an orchestration child and must
    // not be swept up by a run close.
    const closeSession = vi.fn().mockResolvedValue(true)
    await closeOrchestrationRun({
      state: stateWith({ agent: child(), shell: child({ kind: 'terminal' }) }),
      parentSessionId: PARENT,
      closeSession,
    })
    expect(closeSession.mock.calls.map(c => c[0])).toEqual(['agent'])
  })

  it('returns an empty result when the caller has no children', async () => {
    const result = await closeOrchestrationRun({
      state: stateWith({}),
      parentSessionId: PARENT,
      closeSession: vi.fn().mockResolvedValue(true),
    })
    expect(result.closedSessionIds).toEqual([])
    expect('skippedSessionIds' in result).toBe(false)
  })

  it('only touches the caller’s own children', async () => {
    const closeSession = vi.fn().mockResolvedValue(true)
    await closeOrchestrationRun({
      state: stateWith({
        mine: child(),
        theirs: child({ orchestrationParentId: 'other' as SessionId, orchestrationRootId: 'other' as SessionId }),
      }),
      parentSessionId: PARENT,
      closeSession,
    })
    expect(closeSession.mock.calls.map(c => c[0])).toEqual(['mine'])
  })
})
