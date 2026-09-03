import { describe, expect, it } from 'vitest'

import {
  filterBuiltInMcpDomainsForProvider,
  normalizeConfigurableBuiltInMcpDomains,
  providerSupportsBuiltInMcpDomain,
} from '@mcp/shared/types.js'

describe('built-in MCP provider policy', () => {
  it('coerces persisted defaults without admitting ping or garbage', () => {
    expect(normalizeConfigurableBuiltInMcpDomains([
      'orchestration',
      'ping',
      'orchestration',
      42,
      'unknown',
      'workflows',
      'agent_management',
    ])).toEqual(['orchestration', 'workflows', 'agent_management'])
    expect(normalizeConfigurableBuiltInMcpDomains('orchestration')).toEqual([])
  })

  it('keeps Workflow MCP out of Claude while making OpenCode support explicit', () => {
    expect(providerSupportsBuiltInMcpDomain('codex', 'workflows')).toBe(true)
    expect(providerSupportsBuiltInMcpDomain('claude', 'workflows')).toBe(false)
    expect(providerSupportsBuiltInMcpDomain('claude', 'orchestration')).toBe(true)
    expect(providerSupportsBuiltInMcpDomain('claude', 'agent_management')).toBe(true)
    expect(providerSupportsBuiltInMcpDomain('codex', 'agent_management')).toBe(true)
    expect(providerSupportsBuiltInMcpDomain('opencode', 'orchestration')).toBe(true)
    expect(providerSupportsBuiltInMcpDomain('opencode', 'workflows')).toBe(true)
  })

  it('filters untrusted domain lists while preserving supported input order', () => {
    expect(filterBuiltInMcpDomainsForProvider('claude', [
      'workflows',
      'orchestration',
      'agent_transcripts',
    ])).toEqual(['orchestration', 'agent_transcripts'])
    expect(filterBuiltInMcpDomainsForProvider('codex', [
      'workflows',
      'orchestration',
    ])).toEqual(['workflows', 'orchestration'])
    expect(filterBuiltInMcpDomainsForProvider('opencode', [
      'orchestration',
      'workflows',
    ])).toEqual(['orchestration', 'workflows'])
  })
})
