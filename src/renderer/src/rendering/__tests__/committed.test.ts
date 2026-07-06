import { describe, expect, it } from 'vitest'

import {
  collectCommittedCandidates,
  normalizeTextKey,
  type RawCommittedEntry,
} from '@renderer/rendering/observations/committed'

// Fixture times are explicit ISO strings — entry.timestamp is producer
// wall-clock and the collector must parse it, never substitute Date.now().
const TS = '2026-07-06T12:00:00.000Z'
const TS_MS = Date.parse(TS)

const user = (over: Partial<RawCommittedEntry> = {}): RawCommittedEntry => ({
  uuid: 'u1',
  type: 'user',
  timestamp: TS,
  permissionMode: 'default',
  message: { role: 'user', content: 'hello' },
  ...over,
})

describe('committed collector: visibility (#338, meta, non-conversation)', () => {
  it('ordinary conversation rows become candidates with producer timestamps', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [user(), { uuid: 'a1', type: 'assistant', timestamp: TS, message: { id: 'msg_1', role: 'assistant', content: 'hi' } }],
      'claude',
      's1',
    )
    expect(candidates.map(c => c.id)).toEqual(['entry:u1', 'entry:a1'])
    expect(candidates[0].timestampMs).toBe(TS_MS)
    expect(candidates[1].messageId).toBe('msg_1')
    expect(decisions.every(d => d.selected)).toBe(true)
  })

  it('meta rows and non-conversation rows are hidden WITH reasons, not dropped silently', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [
        user({ uuid: 'meta', isMeta: true }),
        { uuid: 'sys', type: 'system', timestamp: TS },
      ],
      'claude',
      's1',
    )
    expect(candidates).toHaveLength(0)
    expect(decisions.map(d => d.reason).sort()).toEqual(['meta-entry', 'not-conversation'])
  })

  it('#338: claude command scaffolding (<command-name>, <local-command-stdout>) filtered as synthetic-user', () => {
    const { candidates, decisions } = collectCommittedCandidates(
      [
        user({ uuid: 'cmd', permissionMode: undefined, message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
        user({ uuid: 'out', permissionMode: undefined, message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } }),
        user({ uuid: 'real' }), // has permissionMode → real prompt
      ],
      'claude',
      's1',
    )
    expect(candidates.map(c => c.id)).toEqual(['entry:real'])
    expect(decisions.filter(d => d.reason === 'synthetic-user-filtered')).toHaveLength(2)
  })

  it('#338 is claude-scoped: an opencode user message starting with "<" (pasted HTML) is NOT hidden', () => {
    const { candidates } = collectCommittedCandidates(
      [user({ uuid: 'html', permissionMode: undefined, message: { role: 'user', content: '<div>paste</div>' } })],
      'opencode',
      's1',
    )
    expect(candidates.map(c => c.id)).toEqual(['entry:html'])
  })

  it('compact boundary/summary rows are visible', () => {
    const { candidates } = collectCommittedCandidates(
      [
        { uuid: 'b', type: 'compact-boundary', timestamp: TS },
        { uuid: 's', type: 'compact-summary', timestamp: TS },
      ],
      'claude',
      's1',
    )
    expect(candidates.map(c => c.contentKind)).toEqual(['compact-boundary', 'compact-summary'])
  })

  it('assistant rows carry exact + normalized text keys; user rows carry neither', () => {
    const { candidates } = collectCommittedCandidates(
      [
        { uuid: 'a', type: 'assistant', timestamp: TS, message: { role: 'assistant', content: '  Same  answer ' } },
        user(),
      ],
      'codex',
      's1',
    )
    const assistant = candidates.find(c => c.id === 'entry:a')
    expect(assistant?.textKey).toBe('  Same  answer ')
    expect(assistant?.normalizedTextKey).toBe(normalizeTextKey('Same answer'))
    expect(candidates.find(c => c.id === 'entry:u1')?.textKey).toBeUndefined()
  })

  it('uuid-less entries get an INGEST-position id, never a visible-index id', () => {
    const { candidates } = collectCommittedCandidates(
      [{ type: 'user', timestamp: TS, permissionMode: 'default', message: { role: 'user', content: 'x' } }],
      'claude',
      's1',
    )
    expect(candidates[0].id).toBe('entry:ingest-0')
  })
})
