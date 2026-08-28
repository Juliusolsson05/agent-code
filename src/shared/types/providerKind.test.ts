import { describe, it, expect } from 'vitest'

import {
  AGENT_PROVIDER_KINDS,
  SESSION_KINDS,
  isAgentProviderKind,
  isAgentSessionKind,
  isSessionKind,
} from '@shared/types/providerKind.js'

// Guards for the provider/session-kind source of truth. These protect the
// boundary contract: untrusted strings (IPC args, persisted SessionMeta.kind,
// MCP input) MUST be narrowed before indexing the `Record<AgentProviderKind,…>`
// registries. If a guard ever accepted a value the registries can't key, a spawn
// would crash deep in a provider factory instead of failing loudly at the edge.

describe('provider kind source of truth', () => {
  it('lists exactly the wired agent providers', () => {
    expect([...AGENT_PROVIDER_KINDS]).toEqual(['claude', 'codex', 'opencode'])
  })

  it('SESSION_KINDS is the agent kinds plus the non-agent pane kinds, derived', () => {
    // Asserted as a DERIVATION rather than a literal list, which is what the guard
    // was always for: hand-listing is exactly how the set silently drifts from
    // AGENT_PROVIDER_KINDS.
    expect([...SESSION_KINDS]).toEqual([...AGENT_PROVIDER_KINDS, 'terminal', 'extension-view'])
  })

  it('isAgentProviderKind accepts wired providers and rejects everything else', () => {
    expect(isAgentProviderKind('claude')).toBe(true)
    expect(isAgentProviderKind('codex')).toBe(true)
    expect(isAgentProviderKind('opencode')).toBe(true)
    // terminal and extension-view are SessionKinds but NOT agent providers — they
    // must be rejected here so agent-only code paths can't be handed one.
    expect(isAgentProviderKind('terminal')).toBe(false)
    expect(isAgentProviderKind('extension-view')).toBe(false)
    expect(isAgentProviderKind('')).toBe(false)
    expect(isAgentProviderKind(undefined)).toBe(false)
    expect(isAgentProviderKind(null)).toBe(false)
    expect(isAgentProviderKind(42)).toBe(false)
  })

  it('isSessionKind accepts every pane kind, agent or not', () => {
    for (const kind of SESSION_KINDS) expect(isSessionKind(kind)).toBe(true)
    expect(isSessionKind(undefined)).toBe(false)
    expect(isSessionKind('not-a-kind')).toBe(false)
  })
})

// ── The regression this file exists for ──
//
// Adding 'extension-view' to SessionKind silently reclassified ~30 renderer call
// sites that spelled "is an agent" as `kind !== 'terminal'`: pane command `when`
// guards, the Dispatch pin filter, Reader Mode's list, the activity modal, the
// related-agent tabs. Every one of those expressions stayed valid TypeScript and
// changed meaning, so no compiler and no existing test could see it.
//
// These assertions are deliberately written as a PARTITION over SESSION_KINDS
// rather than as a list of literals. A future non-agent pane kind added to
// SESSION_KINDS but forgotten in AGENT_PROVIDER_KINDS is then covered the moment
// it is declared — which is the only shape of test that could have caught the
// original defect, because the original defect WAS "we added a kind and forgot
// where it flows".
describe('isAgentSessionKind — the agent/non-agent partition', () => {
  it('is true for exactly the agent provider kinds', () => {
    for (const kind of SESSION_KINDS) {
      expect(isAgentSessionKind(kind)).toBe(isAgentProviderKind(kind))
    }
  })

  it('rejects every non-agent pane kind', () => {
    const nonAgents = SESSION_KINDS.filter(kind => !isAgentProviderKind(kind))
    // Guards the guard: if this ever empties, the partition assertion above
    // becomes vacuously true and would pass while testing nothing.
    expect(nonAgents.length).toBeGreaterThan(0)
    for (const kind of nonAgents) expect(isAgentSessionKind(kind)).toBe(false)
  })

  it('treats an absent kind as an agent, matching DEFAULT_PROVIDER back-compat', () => {
    // SessionMeta.kind postdates the workspace format; sessions persisted before
    // it existed genuinely were Claude. Every call site this predicate replaced
    // already read `undefined` as an agent (absent !== 'terminal'), so flipping
    // this to false would strand every pre-kind pane in a saved workspace.
    expect(isAgentSessionKind(undefined)).toBe(true)
  })
})
