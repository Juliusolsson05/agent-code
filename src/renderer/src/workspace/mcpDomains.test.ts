import { describe, expect, it } from 'vitest'

import {
  clonedMcpOverrides,
  normalizeBuiltInMcpOverrides,
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

describe('user MCP server choices in the override map (#1143)', () => {
  it('keeps well-formed user: keys through normalization and drops malformed ones', () => {
    expect(normalizeBuiltInMcpOverrides({
      tldr: false,
      'user:srv-beeper': true,
      'user:bad id': true,
      'user:': true,
      somethingElse: true,
    })).toEqual({ tldr: false, 'user:srv-beeper': true })
  })

  it('carries user-server choices into a duplicate, like built-in ones', () => {
    // A clone that silently lost its servers would not be a duplicate; only
    // the confirmation-gated root grant is withheld.
    expect(clonedMcpOverrides({
      builtInMcpOverrides: { 'user:srv-beeper': true, root_management: true },
    })).toEqual({ 'user:srv-beeper': true })
  })

  it('resolves built-in domains from the per-provider Settings map', () => {
    const defaults = { claude: ['tldr' as const], codex: ['workflows' as const], opencode: [], grok: [], pi: [] }
    expect(resolveSessionBuiltInMcpDomains({ provider: 'claude', sessionOverrides: {}, defaultDomains: defaults }))
      .toEqual(['tldr'])
    expect(resolveSessionBuiltInMcpDomains({ provider: 'codex', sessionOverrides: {}, defaultDomains: defaults }))
      .toEqual(['workflows'])
  })
})
