import { describe, expect, it } from 'vitest'
import { BUILT_IN_MCP_DOMAINS, CONFIGURABLE_BUILT_IN_MCP_DOMAINS, providerSupportsBuiltInMcpDomain } from './types.js'

describe('goal_loop domain registration', () => {
  it('is a built-in, configurable domain on every provider', () => {
    expect(BUILT_IN_MCP_DOMAINS).toContain('goal_loop')
    expect(CONFIGURABLE_BUILT_IN_MCP_DOMAINS).toContain('goal_loop')
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      expect(providerSupportsBuiltInMcpDomain(provider, 'goal_loop')).toBe(true)
    }
  })
})
