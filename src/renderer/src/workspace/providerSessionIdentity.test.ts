import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { applyJsonlProviderSessionId, applyProviderSessionSwitch, decideJsonlProviderBurst, resumableProviderSessionId, seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'
import type { SessionMeta } from '@renderer/workspace/types'

describe('decideJsonlProviderBurst', () => {
  it('accepts an observed provider id that matches the durable pane identity', () => {
    const decision = decideJsonlProviderBurst({
      previous: undefined,
      expectedProviderSessionId: 'clone-provider',
      observedProviderSessionId: 'clone-provider',
    })

    expect(decision.accept).toBe(true)
    expect(decision.state).toEqual({
      expectedProviderSessionId: 'clone-provider',
      lastObservedProviderSessionId: 'clone-provider',
      blockedAfterConflict: false,
    })
  })

  it('rejects a burst that proves it belongs to another provider transcript', () => {
    const decision = decideJsonlProviderBurst({
      previous: undefined,
      expectedProviderSessionId: 'clone-provider',
      observedProviderSessionId: 'source-provider',
    })

    expect(decision.accept).toBe(false)
    if (!decision.accept) {
      expect(decision.reason).toBe('conflicting-provider-session')
      expect(decision.expectedProviderSessionId).toBe('clone-provider')
      expect(decision.observedProviderSessionId).toBe('source-provider')
    }
    expect(decision.state.blockedAfterConflict).toBe(true)
  })

  it('keeps ambiguous follow-up bursts blocked after a proven conflict', () => {
    const conflict = decideJsonlProviderBurst({
      previous: undefined,
      expectedProviderSessionId: 'clone-provider',
      observedProviderSessionId: 'source-provider',
    })

    const followUp = decideJsonlProviderBurst({
      previous: conflict.state,
      expectedProviderSessionId: 'clone-provider',
      observedProviderSessionId: null,
    })

    expect(followUp.accept).toBe(false)
    if (!followUp.accept) {
      expect(followUp.reason).toBe('blocked-after-conflict')
      expect(followUp.expectedProviderSessionId).toBe('clone-provider')
      expect(followUp.observedProviderSessionId).toBe('source-provider')
    }
  })

  it('unblocks when a later burst proves the expected provider identity', () => {
    const conflict = decideJsonlProviderBurst({
      previous: undefined,
      expectedProviderSessionId: 'clone-provider',
      observedProviderSessionId: 'source-provider',
    })

    const recovered = decideJsonlProviderBurst({
      previous: conflict.state,
      expectedProviderSessionId: 'clone-provider',
      observedProviderSessionId: 'clone-provider',
    })

    expect(recovered.accept).toBe(true)
    expect(recovered.state).toEqual({
      expectedProviderSessionId: 'clone-provider',
      lastObservedProviderSessionId: 'clone-provider',
      blockedAfterConflict: false,
    })
  })

  it('does not block fresh sessions before a durable provider id is known', () => {
    const decision = decideJsonlProviderBurst({
      previous: undefined,
      expectedProviderSessionId: null,
      observedProviderSessionId: 'first-provider',
    })

    expect(decision.accept).toBe(true)
    expect(decision.state).toEqual({
      expectedProviderSessionId: null,
      lastObservedProviderSessionId: 'first-provider',
      blockedAfterConflict: false,
    })
  })
})


it('retains a channel failure published before resume bookkeeping finishes', () => {
  const existing = { ...emptyRuntime(), transcriptStatus: 'error' as const, transcriptError: 'reader stopped', transcriptChannelError: 'reader stopped' }
  expect(seedResumedRuntimeFields(existing, { providerSessionId: 'ses_saved' })).toMatchObject({
    transcriptStatus: 'error', transcriptError: 'reader stopped', transcriptChannelError: 'reader stopped',
  })
})

describe('applyProviderSessionSwitch (a runtime following an in-TUI session switch)', () => {
  const pane = { id: 'pane', kind: 'pi', cwd: '/w', providerSessionId: 'old', providerSessionIdSource: 'jsonl-entry' } as unknown as SessionMeta

  it('replaces a durable identity that a transcript row could never replace', () => {
    // The #290 rule still holds for rows: a different id inside a burst is a conflict.
    expect(applyJsonlProviderSessionId(pane, 'new').status).toBe('conflict')
    // The runtime's explicit switch is not a row: the pane follows it, and the
    // new id is durable (reload and resume use it).
    const next = applyProviderSessionSwitch(pane, 'new')
    expect(next).toMatchObject({ providerSessionId: 'new', providerSessionIdSource: 'provider-follow' })
    expect(resumableProviderSessionId(next)).toBe('new')
  })

  it('is a no-op for a repeat of the same switch and for an empty id', () => {
    const next = applyProviderSessionSwitch(pane, 'new')!
    expect(applyProviderSessionSwitch(next, 'new')).toBeNull()
    expect(applyProviderSessionSwitch(pane, '')).toBeNull()
  })
})
