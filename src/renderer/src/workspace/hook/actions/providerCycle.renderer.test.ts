import { describe, expect, it } from 'vitest'

import { nextSwitchTarget } from './provider'

describe('focused provider switch cycle', () => {
  it('makes OpenCode a distinct stop in the registry cycle', () => {
    expect(nextSwitchTarget('claude')).toBe('codex')
    expect(nextSwitchTarget('codex')).toBe('opencode')
    expect(nextSwitchTarget('opencode')).toBe('claude')
  })
})
