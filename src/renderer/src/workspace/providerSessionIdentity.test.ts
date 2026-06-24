import { describe, expect, it } from 'vitest'

import { decideJsonlProviderBurst } from '@renderer/workspace/providerSessionIdentity'

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
