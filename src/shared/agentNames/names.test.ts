import { describe, expect, it } from 'vitest'

import { AGENT_NAMES, agentNameAt, normalizeAgentName } from '@shared/agentNames/names'

// WHY this file is worth its length for a constant array: these strings are
// spoken addresses. Reordering the list re-points every NEW allocation, and
// deleting an entry shifts every rank behind it, re-pointing more of them at
// once. Neither edit strands a name already assigned — search compares the name
// recorded on the agent, never this list. The test pins the properties the rest
// of the feature is allowed to assume: the exact ranking in its exact order, no
// two names that sound the same, and a deterministic overflow rule.
describe('agent name vocabulary', () => {
  it('is the approved ranked list of one hundred distinct names', () => {
    expect(AGENT_NAMES).toHaveLength(100)
    expect(AGENT_NAMES.slice(0, 3)).toEqual(['Apollo', 'Jasper', 'Beatrix'])
    expect(new Set(AGENT_NAMES.map(normalizeAgentName)).size).toBe(100)
    for (const name of AGENT_NAMES) expect(name).toMatch(/^[A-Z][a-z]{1,11}$/)
  })

  // THE ORDERING LOCK. Every property above is order-insensitive: swapping two
  // entries, substituting one name for another, or deleting one and appending a
  // replacement all keep the length, the first three and the uniqueness intact
  // — and every one of those edits silently re-points future allocations, which
  // is precisely what `names.ts:3-10` declares must never happen (the registry
  // stores the assigned STRING but picks new names by walking this ranking, so
  // an edit renames nobody and re-addresses everybody who comes next). Only a
  // full literal comparison can fail on them, which is what makes "ordered and
  // append-only" enforceable rather than aspirational. Appending a 101st name
  // is the one edit the contract allows and it lands here as a one-line
  // addition; anything else failing here is this test doing its job.
  it('is exactly this ranking, in exactly this order', () => {
    expect(AGENT_NAMES).toEqual([
      'Apollo', 'Jasper', 'Beatrix', 'Duncan', 'Felix', 'Gloria', 'Hugo', 'Ingrid', 'Oscar', 'Sasha',
      'Trevor', 'Violet', 'Xander', 'Morgan', 'Hazel', 'Cedric', 'Bruno', 'Esther', 'Daphne', 'Orion',
      'Athena', 'Tobias', 'Matilda', 'Dominic', 'Octavia', 'Sebastian', 'Penelope', 'Gabriel', 'Miranda', 'Frederick',
      'Savannah', 'Julian', 'Natalie', 'Benjamin', 'Valerie', 'Artemis', 'Vanessa', 'Gideon', 'Cosmo', 'Sabrina',
      'Franklin', 'Veronica', 'Malcolm', 'Ramona', 'Leonardo', 'Camilla', 'Donovan', 'Helena', 'Solomon', 'Clementine',
      'Oliver', 'Cassandra', 'Dexter', 'Phoebe', 'Winston', 'Delilah', 'Marcus', 'Naomi', 'Arthur', 'Fiona',
      'Vincent', 'Tabitha', 'Edward', 'Monica', 'Simon', 'Greta', 'Patrick', 'Zelda', 'Calvin', 'Ruby',
      'Amber', 'Petra', 'Jonah', 'Willow', 'Flora', 'Yuki', 'Iris', 'Cora', 'Lena', 'Nora',
      'Lucy', 'Rory', 'Theo', 'Ada', 'Eli', 'Uma', 'Zane', 'Milo', 'Leo', 'Finn',
      'Max', 'Gus', 'Blake', 'Quinn', 'Sage', 'Knox', 'Reese', 'Wes', 'Kit', 'Kai',
    ])
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
