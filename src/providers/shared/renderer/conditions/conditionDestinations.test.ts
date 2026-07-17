import { describe, expect, it } from 'vitest'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'

describe('provider condition destinations', () => {
  it('gives every registered view and attention kind an explicit owner', () => {
    for (const provider of AGENT_PROVIDER_KINDS) {
      const capabilities = getRendererProviderCapabilities(provider)
      const destinations = capabilities.conditionPolicy.destinations

      for (const kind of Object.keys(capabilities.conditionViews)) {
        expect(destinations[kind], `${provider}:${kind}`).toBe('condition-outlet')
      }
      for (const kind of capabilities.conditionPolicy.attentionKinds) {
        expect(destinations[kind], `${provider}:${kind}`).toBeDefined()
      }
    }
  })

  it('keeps non-outlet Claude ownership explicit instead of inferring it', () => {
    const policy = getRendererProviderCapabilities('claude').conditionPolicy

    expect(policy.destinations['claude.ask-user-question']).toBe('feed-inline')
    expect(policy.destinations['claude.slash-picker']).toBe('composer')
    expect(policy.composerPickerKind).toBe('claude.slash-picker')
  })
})
