import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import type { ProviderSwitchBatch } from '@renderer/workspace/types'
import { useBulkProviderSwitchActions } from '@renderer/workspace/hook/actions/bulkProviderSwitch'

const { switchAgentProvider } = vi.hoisted(() => ({ switchAgentProvider: vi.fn() }))
vi.mock('@renderer/workspace/hook/actions/providerSwitchCore', () => ({ switchAgentProvider }))

// This module had NO test file, which is how a two-click data-loss bug shipped
// in it. These cases pin the return path's batch bookkeeping specifically:
// the modal is the ONLY return affordance in the app, so a batch dropped here
// cannot be recovered by any other route.

type Agent = ProviderSwitchBatch['agents'][number]

function agent(sessionId: string): Agent {
  return {
    sessionId,
    originalKind: 'claude',
    switchedToKind: 'codex',
  } as unknown as Agent
}

function harness(batch: ProviderSwitchBatch | null) {
  const state = {
    lastProviderSwitchBatch: batch,
    sessions: Object.fromEntries(
      (batch?.agents ?? []).map(a => [a.sessionId, { cwd: '/recorded', kind: 'codex' }]),
    ),
  }
  const refs = { stateRef: { current: state } } as unknown as WorkspaceRefs
  const setState = vi.fn((updater: unknown) => {
    state.lastProviderSwitchBatch = (
      typeof updater === 'function'
        ? (updater as (p: typeof state) => typeof state)(state)
        : (updater as typeof state)
    ).lastProviderSwitchBatch
  }) as unknown as WorkspaceSetState
  const toasts: string[] = []
  const { result } = renderHook(() => useBulkProviderSwitchActions(
    refs,
    setState,
    vi.fn() as unknown as WorkspaceSetRuntimes,
    (message: string) => { toasts.push(message) },
    {} as SessionActions,
  ))
  return { result, state, toasts }
}

function batchOf(...ids: string[]): ProviderSwitchBatch {
  return {
    id: 'batch-1',
    switchedAt: 0,
    sourceKind: 'claude',
    targetKind: 'codex',
    agents: ids.map(agent),
    compactOnArrival: false,
  } as unknown as ProviderSwitchBatch
}

afterEach(() => { switchAgentProvider.mockReset() })

describe('returnLastProviderSwitchBatch', () => {
  it('keeps the batch when every agent refuses to return', async () => {
    // The realistic case, not an edge case: arrival compaction is on by
    // default for large conversations and holds `providerSwitch` set for
    // minutes per pane, so every agent in a batch returned during that window
    // reports 'skipped' with "still finishing a provider switch". The old code
    // nulled the batch anyway, and the user lost the only way to get those
    // agents home by pressing the button meant to bring them home.
    switchAgentProvider.mockResolvedValue({ status: 'skipped' })
    const { result, state, toasts } = harness(batchOf('a', 'b', 'c'))

    await result.current.returnLastProviderSwitchBatch()

    expect(state.lastProviderSwitchBatch).not.toBeNull()
    expect(state.lastProviderSwitchBatch?.agents.map(a => a.sessionId)).toEqual(['a', 'b', 'c'])
    expect(toasts[0]).toContain('Returned 0 agents')
  })

  it('keeps only the agents that did not make it home', async () => {
    switchAgentProvider
      .mockResolvedValueOnce({ status: 'switched' })
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'skipped' })
    const { result, state } = harness(batchOf('a', 'b', 'c'))

    await result.current.returnLastProviderSwitchBatch()

    // 'a' is home and must not be retried; 'b' and 'c' are still parked on the
    // target provider and are still returnable.
    expect(state.lastProviderSwitchBatch?.agents.map(a => a.sessionId)).toEqual(['b', 'c'])
  })

  it('clears the batch once every agent has returned', async () => {
    switchAgentProvider.mockResolvedValue({ status: 'switched' })
    const { result, state } = harness(batchOf('a', 'b'))

    await result.current.returnLastProviderSwitchBatch()

    expect(state.lastProviderSwitchBatch).toBeNull()
  })

  it('clears the batch when its agents are all gone from the workspace', async () => {
    // Closed or manually-moved agents are skipped WITHOUT being retained:
    // there is nothing left to return, so holding the record would leave a
    // Return affordance that can never do anything.
    const batch = batchOf('a')
    const { result, state } = harness(batch)
    state.sessions = {}

    await result.current.returnLastProviderSwitchBatch()

    expect(state.lastProviderSwitchBatch).toBeNull()
    expect(switchAgentProvider).not.toHaveBeenCalled()
  })

  it('does not clobber a newer batch recorded while the return was running', async () => {
    switchAgentProvider.mockResolvedValue({ status: 'switched' })
    const { result, state } = harness(batchOf('a'))
    // A forward switch during the await replaces the remembered batch. The
    // return must not delete a record it never operated on.
    switchAgentProvider.mockImplementation(async () => {
      state.lastProviderSwitchBatch = batchOf('z')
      state.lastProviderSwitchBatch.id = 'batch-2'
      return { status: 'switched' }
    })

    await result.current.returnLastProviderSwitchBatch()

    expect(state.lastProviderSwitchBatch?.id).toBe('batch-2')
  })
})

describe('returnLastProviderSwitchBatch consent', () => {
  it('does not compact on arrival when the forward batch did not consent', async () => {
    // A Return click used to hard-code compaction on for any Claude
    // destination. That spends Claude quota once per agent and disables every
    // one of those composers for the arrival wait plus the compaction wait —
    // minutes each, no cancel — while the forward flow puts the same thing
    // behind an explicit checkbox and a quota disclosure.
    switchAgentProvider.mockResolvedValue({ status: 'switched' })
    const { result } = harness(batchOf('a'))

    await result.current.returnLastProviderSwitchBatch()

    expect(switchAgentProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPolicy: expect.objectContaining({ compactOnArrival: false }),
      }),
    )
  })

  it('compacts on arrival when the forward batch did consent', async () => {
    switchAgentProvider.mockResolvedValue({ status: 'switched' })
    const batch = batchOf('a')
    batch.compactOnArrival = true
    const { result } = harness(batch)

    await result.current.returnLastProviderSwitchBatch()

    expect(switchAgentProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPolicy: expect.objectContaining({ compactOnArrival: true }),
      }),
    )
  })

  it('never promises arrival compaction a non-Claude destination cannot do', async () => {
    // compactAfterSwitch reports every non-Claude kind as a no-op, so honouring
    // consent literally would advertise work that never happens.
    switchAgentProvider.mockResolvedValue({ status: 'switched' })
    const batch = batchOf('a')
    batch.compactOnArrival = true
    batch.agents[0].originalKind = 'codex'
    const { result } = harness(batch)

    await result.current.returnLastProviderSwitchBatch()

    expect(switchAgentProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPolicy: expect.objectContaining({ compactOnArrival: false }),
      }),
    )
  })
})

describe('bulk switch reporting', () => {
  it('carries the reason into the summary instead of only a count', async () => {
    // "Returned 0 agents to Claude (1 failed)" is unactionable. The core writes
    // messages that name the remedy; bulk used to discard every one of them.
    switchAgentProvider.mockResolvedValue({
      status: 'failed',
      message: 'Poisoned carrier — clear the rate-limit message first',
    })
    const { result, toasts } = harness(batchOf('a'))

    await result.current.returnLastProviderSwitchBatch()

    expect(toasts[0]).toContain('1 failed')
    expect(toasts[0]).toContain('Poisoned carrier')
  })

  it('reports skipped agents separately from failed ones', async () => {
    switchAgentProvider
      .mockResolvedValueOnce({ status: 'skipped', reason: 'Still finishing a provider switch' })
      .mockResolvedValueOnce({ status: 'failed', message: 'Replacement failed' })
    const { result, toasts } = harness(batchOf('a', 'b'))

    await result.current.returnLastProviderSwitchBatch()

    expect(toasts[0]).toContain('1 skipped')
    expect(toasts[0]).toContain('1 failed')
  })

  it('dedupes shared reasons and caps the list', async () => {
    // Twenty agents usually fail for one reason, and PaneToast clamps to three
    // lines — an uncapped list would push the counts out of view.
    switchAgentProvider.mockResolvedValue({ status: 'failed', message: 'Same reason' })
    const { result, toasts } = harness(batchOf('a', 'b', 'c'))

    await result.current.returnLastProviderSwitchBatch()

    expect(toasts[0].match(/Same reason/g)).toHaveLength(1)
    expect(toasts[0]).not.toContain('more')
  })

  it('surfaces the shrink summary a successful but lossy return produced', async () => {
    // The shrink ladder's summary exists specifically so no lossy step is
    // silent. Counting it as "1 shrunk" and dropping the text defeats that.
    switchAgentProvider.mockResolvedValue({
      status: 'switched',
      shrinkSummary: 'dropped 12 tool results',
    })
    const { result, toasts } = harness(batchOf('a'))

    await result.current.returnLastProviderSwitchBatch()

    expect(toasts[0]).toContain('dropped 12 tool results')
  })
})
