import { describe, expect, it } from 'vitest'

import type { AgentProviderKind } from '@shared/types/providerKind'

import {
  AGENT_PROVIDER_CHOICES,
  enabledProviderSwitchChoices,
  filterAgentProviderChoices,
  filterSessionSpawnChoices,
  SESSION_SPAWN_CHOICES,
} from './providerChoices'

const CLAUDE_CODEX: ReadonlySet<AgentProviderKind> = new Set(['claude', 'codex'])

describe('filterAgentProviderChoices', () => {
  it('removes choices whose kind is disabled, both OpenCode runtimes together', () => {
    const filtered = filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, CLAUDE_CODEX)
    expect(filtered.map(c => c.kind)).toEqual(['claude', 'codex'])
    // OpenCode Terminal must not survive when opencode is disabled: it is a
    // runtime flavor of the same provider identity (providerChoices.ts).
  })

  it('keeps both OpenCode runtime choices when opencode is enabled', () => {
    const filtered = filterAgentProviderChoices(
      AGENT_PROVIDER_CHOICES,
      new Set<AgentProviderKind>(['opencode']),
    )
    expect(filtered.map(c => c.kind)).toEqual(['opencode', 'opencode'])
    expect(filtered.map(c => c.label)).toEqual(['OpenCode', 'OpenCode Terminal'])
  })
})

describe('filterSessionSpawnChoices', () => {
  it('always keeps the plain Terminal choice', () => {
    const filtered = filterSessionSpawnChoices(SESSION_SPAWN_CHOICES, new Set<AgentProviderKind>())
    expect(filtered.map(c => c.kind)).toEqual(['terminal'])
  })
})

describe('enabledProviderSwitchChoices', () => {
  it('drops targets that are disabled even when the feature edge declares them', () => {
    const choices = enabledProviderSwitchChoices('claude', CLAUDE_CODEX)
    expect(choices.map(c => c.kind)).toEqual(['codex'])
  })

  it('returns nothing for a disabled source', () => {
    expect(enabledProviderSwitchChoices('grok', CLAUDE_CODEX)).toEqual([])
  })
})
