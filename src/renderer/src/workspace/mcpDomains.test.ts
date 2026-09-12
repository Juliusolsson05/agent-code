import { describe, expect, it } from 'vitest'

import {
  clonedMcpOverrides,
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
      builtInMcpOverrides: {},
    })).toEqual({
      cwd: '/tmp/project',
      builtInMcpDomains: [],
      builtInMcpOverrides: {},
    })
  })

  it('uses defaults only when the session has no array-shaped choice', () => {
    expect(resolveSessionBuiltInMcpDomains({
      provider: 'codex',
      sessionDomains: undefined,
      defaultDomains: ['orchestration', 'workflows', 'agent_management'],
    })).toEqual(['orchestration', 'workflows', 'agent_management'])

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
      defaultDomains: ['orchestration', 'agent_management'],
    })).toEqual(['orchestration', 'agent_management'])
  })
})

describe('capability choices a clone may inherit', () => {
  it('carries ordinary choices but never a confirmation-gated grant', () => {
    // A duplicate that lost its tools would not be a duplicate, so ordinary
    // choices travel. Application-wide control does not: its confirmation
    // dialog names one agent, and the granting agent's own catalog includes
    // agents.duplicate — so inheriting it would let one confirmed grant
    // replicate itself.
    expect(clonedMcpOverrides({
      builtInMcpOverrides: { tldr: true, workflows: false, root_management: true },
    })).toEqual({ tldr: true, workflows: false })
  })

  it('does not let a legacy root-managed pane migrate the grant into a clone', () => {
    expect(clonedMcpOverrides({ builtInMcpDomains: ['tldr', 'root_management'] }))
      .toEqual({ tldr: true })
  })

  it("leaves the source pane's own choices untouched", () => {
    const source = { builtInMcpOverrides: { root_management: true, tldr: true } }
    clonedMcpOverrides(source)
    // The helper must not mutate the pane it copies from: the source keeps the
    // grant the user confirmed for it.
    expect(source.builtInMcpOverrides).toEqual({ root_management: true, tldr: true })
  })
})
