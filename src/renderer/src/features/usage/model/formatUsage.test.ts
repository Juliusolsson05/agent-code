import { describe, expect, it } from 'vitest'

import { providerLabel } from './formatUsage'

describe('providerLabel', () => {
  it('labels every usage source — an unknown id must fail typecheck, not render as a sibling', () => {
    expect(providerLabel('claude')).toBe('Claude')
    expect(providerLabel('codex')).toBe('Codex')
    expect(providerLabel('grok')).toBe('Grok')
    expect(providerLabel('opencode:zai')).toBe('z.ai')
  })
})
