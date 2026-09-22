import { describe, expect, it } from 'vitest'

import {
  coerceOpencodeUsageSource,
  coerceUserProviderOverrides,
  enabledKindsFromEntries,
  resolveProviderEnablement,
} from './providerEnablement.js'

describe('coerceUserProviderOverrides', () => {
  it('keeps boolean values keyed by valid provider kinds only', () => {
    expect(
      coerceUserProviderOverrides({ grok: false, claude: true, nonsense: true, codex: 'yes' }),
    ).toEqual({ claude: true, grok: false })
  })

  it('returns an empty map for non-object input', () => {
    expect(coerceUserProviderOverrides(null)).toEqual({})
    expect(coerceUserProviderOverrides('grok')).toEqual({})
    expect(coerceUserProviderOverrides([true])).toEqual({})
  })
})

describe('coerceOpencodeUsageSource', () => {
  it('accepts only the two known values and defaults to none', () => {
    expect(coerceOpencodeUsageSource('zai')).toBe('zai')
    expect(coerceOpencodeUsageSource('none')).toBe('none')
    expect(coerceOpencodeUsageSource(undefined)).toBe('none')
    expect(coerceOpencodeUsageSource('kimi')).toBe('none')
  })
})

describe('resolveProviderEnablement', () => {
  it('defaults to detected: installed providers on, missing providers off', () => {
    const entries = resolveProviderEnablement({}, new Set(['claude', 'codex']))
    expect(entries).toEqual([
      { kind: 'claude', enabled: true, because: 'detected', installed: true },
      { kind: 'codex', enabled: true, because: 'detected', installed: true },
      { kind: 'opencode', enabled: false, because: 'not-detected', installed: false },
      { kind: 'grok', enabled: false, because: 'not-detected', installed: false },
    ])
  })

  it('a user override wins over detection in both directions', () => {
    const entries = resolveProviderEnablement(
      { grok: true, claude: false },
      new Set(['claude']),
    )
    const byKind = new Map(entries.map(e => [e.kind, e]))
    // Enabled-by-user even though nothing was detected: the user's explicit
    // word survives an uninstall/reinstall cycle (#1102 spec §Contracts).
    expect(byKind.get('grok')).toMatchObject({ enabled: true, because: 'user', installed: false })
    expect(byKind.get('claude')).toMatchObject({ enabled: false, because: 'user', installed: true })
  })
})

describe('enabledKindsFromEntries', () => {
  it('collects exactly the enabled entries', () => {
    const entries = resolveProviderEnablement({ grok: true }, new Set(['claude']))
    expect([...enabledKindsFromEntries(entries)].sort()).toEqual(['claude', 'grok'])
  })
})
