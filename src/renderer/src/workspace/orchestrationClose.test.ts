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
// The confirmation dialog these calls used to raise is gone (see the WHY on
// OrchestrationCloseSession), so `preConfirmed: true` is now part of the
// contract too — a regression that re-armed the dialog would make a fleet's
// routine cleanup interrupt the user several times per run.

const PARENT = 'parent-1' as SessionId

const child = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  cwd: '/tmp/project',
  kind: 'claude',
  orchestrationParentId: PARENT,
  orchestrationRootId: PARENT,
  ...overrides,
}) as SessionMeta

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
    // preConfirmed is the whole point: these are the caller's own children and
    // the ownership gate already scoped them.
    expect(closeSession).toHaveBeenCalledWith('child-1', { preConfirmed: true })
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
    // that answer. Now none of them do.
    for (const call of closeSession.mock.calls) {
      expect(call[1]).toEqual({ preConfirmed: true })
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
    expect(result.skippedSessionIds).toBeUndefined()
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
