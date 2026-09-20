import { describe, expect, it } from 'vitest'

import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind.js'
import type { UsageSourceId } from '@shared/types/usage.js'
import { USAGE_SOURCES, listActiveUsageSourceIds, listActiveUsageSources } from './sources.js'

describe('USAGE_SOURCES registry', () => {
  it('covers exactly the UsageSourceId union — no silent gaps', () => {
    expect([...Object.keys(USAGE_SOURCES)].sort()).toEqual(
      ['claude', 'codex', 'grok', 'opencode:zai'].sort(),
    )
    for (const descriptor of Object.values(USAGE_SOURCES)) {
      if (descriptor) {
        expect(descriptor.read).toBeTypeOf('function')
        expect(descriptor.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('every agent provider kind is a valid enablement key for usage composition', () => {
    // claude/codex/grok map 1:1; opencode maps through the usage-source
    // selection. A new provider kind without a usage story must still
    // compose (it simply has no source id until one is registered).
    for (const kind of AGENT_PROVIDER_KINDS) {
      expect(['claude', 'codex', 'grok', 'opencode'].includes(kind)).toBe(true)
    }
  })
})

describe('listActiveUsageSourceIds', () => {
  it('includes installed-provider sources that are enabled', () => {
    const ids = listActiveUsageSourceIds({
      enabledKinds: new Set<AgentProviderKind>(['claude', 'codex']),
      opencodeUsageSource: 'none',
    })
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('includes opencode:zai only when opencode is enabled AND the source is selected', () => {
    // The real descriptor lands with #1104; inject a stand-in so the
    // enablement gating below the null check is exercised NOW, not first
    // discovered broken when that issue fills it in.
    const saved = USAGE_SOURCES['opencode:zai']
    USAGE_SOURCES['opencode:zai'] = {
      id: 'opencode:zai',
      label: 'z.ai',
      sourceLabel: 'opencode auth.json',
      read: async () => {
        throw new Error('not under test')
      },
    }
    try {
      expect(
        listActiveUsageSourceIds({
          enabledKinds: new Set<AgentProviderKind>(['opencode']),
          opencodeUsageSource: 'zai',
        }),
      ).toEqual(['opencode:zai'])
      expect(
        listActiveUsageSourceIds({
          enabledKinds: new Set<AgentProviderKind>(['opencode']),
          opencodeUsageSource: 'none',
        }),
      ).toEqual([])
      // Disabled OpenCode wins over the selected source: the credential is
      // only reachable through a provider the user wants active.
      expect(
        listActiveUsageSourceIds({
          enabledKinds: new Set<AgentProviderKind>(),
          opencodeUsageSource: 'zai',
        }),
      ).toEqual([])
    } finally {
      USAGE_SOURCES['opencode:zai'] = saved
    }
  })

  it('never lists a source whose reader has not landed (null placeholder)', () => {
    const ids = listActiveUsageSourceIds({
      enabledKinds: new Set<AgentProviderKind>(['grok']),
      opencodeUsageSource: 'none',
    })
    expect(ids).toEqual([])
  })
})

describe('listActiveUsageSources', () => {
  it('returns id+label pairs for the skeleton rail', () => {
    const sources = listActiveUsageSources({
      enabledKinds: new Set<AgentProviderKind>(['claude']),
      opencodeUsageSource: 'none',
    })
    expect(sources).toEqual([{ id: 'claude' as UsageSourceId, label: 'Claude' }])
  })
})
