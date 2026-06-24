import { describe, it, expect } from 'vitest'

import {
  AGENT_PROVIDER_KINDS,
  SESSION_KINDS,
  isAgentProviderKind,
  isSessionKind,
} from '@shared/types/providerKind'

// Guards for the provider/session-kind source of truth. These protect the
// boundary contract: untrusted strings (IPC args, persisted SessionMeta.kind,
// MCP input) MUST be narrowed before indexing the `Record<AgentProviderKind,…>`
// registries. If a guard ever accepted a value the registries can't key, a spawn
// would crash deep in a provider factory instead of failing loudly at the edge.

describe('provider kind source of truth', () => {
  it('lists exactly the wired agent providers', () => {
    expect([...AGENT_PROVIDER_KINDS]).toEqual(['claude', 'codex'])
  })

  it('SESSION_KINDS is the agent kinds plus terminal, derived (never hand-listed)', () => {
    expect([...SESSION_KINDS]).toEqual(['claude', 'codex', 'terminal'])
  })

  it('isAgentProviderKind accepts wired providers and rejects everything else', () => {
    expect(isAgentProviderKind('claude')).toBe(true)
    expect(isAgentProviderKind('codex')).toBe(true)
    // terminal is a SessionKind but NOT an agent provider — it must be rejected
    // here so agent-only code paths can't be handed it.
    expect(isAgentProviderKind('terminal')).toBe(false)
    expect(isAgentProviderKind('opencode')).toBe(false)
    expect(isAgentProviderKind('')).toBe(false)
    expect(isAgentProviderKind(undefined)).toBe(false)
    expect(isAgentProviderKind(null)).toBe(false)
    expect(isAgentProviderKind(42)).toBe(false)
  })

  it('isSessionKind accepts agent kinds plus terminal', () => {
    expect(isSessionKind('claude')).toBe(true)
    expect(isSessionKind('codex')).toBe(true)
    expect(isSessionKind('terminal')).toBe(true)
    expect(isSessionKind('opencode')).toBe(false)
    expect(isSessionKind(undefined)).toBe(false)
  })
})
