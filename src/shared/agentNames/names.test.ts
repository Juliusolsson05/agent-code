import { describe, expect, it } from 'vitest'

import { AGENT_NAMES, agentNameAt, normalizeAgentName } from '@shared/agentNames/names'

// WHY this file is worth its length for a constant array: these strings are
// spoken addresses. Reordering the list re-points every NEW allocation, and
// deleting an entry can make a stored assignment unreachable by name search
// while the registry still returns it. The test pins the properties the rest of
// the feature is allowed to assume: a fixed length, a fixed ranked prefix, no
// two names that sound the same, and a deterministic overflow rule.
describe('agent name vocabulary', () => {
  it('is the approved ranked list of one hundred distinct names', () => {
    expect(AGENT_NAMES).toHaveLength(100)
    expect(AGENT_NAMES.slice(0, 3)).toEqual(['Apollo', 'Jasper', 'Beatrix'])
    expect(new Set(AGENT_NAMES.map(normalizeAgentName)).size).toBe(100)
    for (const name of AGENT_NAMES) expect(name).toMatch(/^[A-Z][a-z]{1,11}$/)
  })

  it('walks the ranking in order and then adds explicit numeric suffixes', () => {
    expect([0, 1, 2].map(agentNameAt)).toEqual(['Apollo', 'Jasper', 'Beatrix'])
    expect(agentNameAt(99)).toBe(AGENT_NAMES[99])
    expect(agentNameAt(100)).toBe('Apollo 2')
    expect(agentNameAt(199)).toBe(`${AGENT_NAMES[99]} 2`)
    expect(agentNameAt(200)).toBe('Apollo 3')
  })

  it('treats spacing and case as the same spoken address but never joins the suffix', () => {
    expect(normalizeAgentName('  Apollo  ')).toBe('apollo')
    expect(normalizeAgentName('Apollo   2')).toBe('apollo 2')
    // "Apollo2" is a different token to a speech-to-text pipeline than
    // "Apollo 2"; collapsing them would let one utterance match two agents.
    expect(normalizeAgentName('Apollo2')).not.toBe(normalizeAgentName('Apollo 2'))
  })
})
