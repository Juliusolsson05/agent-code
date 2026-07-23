import { describe, expect, it } from 'vitest'

import {
  normalizeSessionBuiltInMcpDomains,
  resolveSessionBuiltInMcpDomains,
  withNormalizedBuiltInMcpDomains,
} from '@renderer/workspace/mcpDomains'

describe('session built-in MCP domain resolution', () => {
  it('preserves an explicit empty array through normalization and persistence', () => {
    expect(normalizeSessionBuiltInMcpDomains([])).toEqual([])
    expect(withNormalizedBuiltInMcpDomains({
      cwd: '/tmp/project',
      builtInMcpDomains: [],
    })).toEqual({
      cwd: '/tmp/project',
      builtInMcpDomains: [],
    })
  })

  it('uses defaults only when the session has no array-shaped choice', () => {
    expect(resolveSessionBuiltInMcpDomains({
      provider: 'codex',
      sessionDomains: undefined,
      defaultDomains: ['orchestration', 'workflows'],
    })).toEqual(['orchestration', 'workflows'])

    expect(resolveSessionBuiltInMcpDomains({
      provider: 'codex',
      sessionDomains: [],
      defaultDomains: ['orchestration', 'workflows'],
    })).toEqual([])

    expect(resolveSessionBuiltInMcpDomains({
      provider: 'codex',
      sessionDomains: ['agent_transcripts'],
      defaultDomains: ['orchestration'],
    })).toEqual(['agent_transcripts'])
  })

  it('applies provider restrictions after resolving explicit/default precedence', () => {
    expect(resolveSessionBuiltInMcpDomains({
      provider: 'claude',
      sessionDomains: ['workflows', 'orchestration'],
      defaultDomains: [],
    })).toEqual(['orchestration'])
    expect(resolveSessionBuiltInMcpDomains({
      provider: 'opencode',
      sessionDomains: undefined,
      defaultDomains: ['orchestration'],
    })).toEqual([])
  })
})
