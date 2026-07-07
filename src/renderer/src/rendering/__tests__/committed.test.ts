import { describe, expect, it } from 'vitest'

import {
  buildCommittedOwnership,
  decideLiveCandidate,
  SUPPRESSION_POLICY,
} from '@renderer/rendering/model/ownership'
import type { RenderCandidate } from '@renderer/rendering/model/types'

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

describe('block-grain tool ownership mining (corpus new-bug fix)', () => {
  it('mines tool_use ids from assistant entries and tool_result ids from user entries', () => {
    const { candidates } = collectCommittedCandidates(
      [
        {
          uuid: 'a-tools',
          type: 'assistant',
          timestamp: TS,
          message: {
            id: 'msg_t',
            role: 'assistant',
            content: [
              { type: 'text', text: 'running two tools' },
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
              { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} },
            ],
          },
        },
        {
          uuid: 'u-result',
          type: 'user',
          timestamp: TS,
          permissionMode: 'default',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
          },
        },
      ],
      'claude',
      's1',
    )
    expect(candidates.find(c => c.id === 'entry:a-tools')?.ownedToolUseIds).toEqual(['toolu_1', 'toolu_2'])
    expect(candidates.find(c => c.id === 'entry:u-result')?.ownedToolResultIds).toEqual(['toolu_1'])
  })

  it('mined evidence populates ownership sets so live tool blocks yield (the duplicate-tool-card class)', () => {
    const { candidates } = collectCommittedCandidates(
      [
        {
          uuid: 'a-tools',
          type: 'assistant',
          timestamp: TS,
          message: {
            id: 'msg_t',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
          },
        },
      ],
      'claude',
      's1',
    )
    const ownership = buildCommittedOwnership(candidates)
    expect(ownership.toolUseIds.has('toolu_1')).toBe(true)

    // The live twin of that tool block must now be rejected — before this
    // fix, claude committed candidates never exposed tool ids and this
    // decision came back selected (duplicate AskUserQuestion capture).
    const live: RenderCandidate = {
      id: 'sem:msg_t:1',
      owner: 'semantic-current',
      provider: 'claude',
      sourcePlane: 'semantic',
      sessionId: 's1',
      turnId: 'msg_t',
      blockIndex: 1,
      toolUseId: 'toolu_1',
      contentKind: 'tool-use',
      timestampMs: TS_MS,
      sequence: 0,
    }
    const d = decideLiveCandidate(live, ownership, SUPPRESSION_POLICY.claude)
    expect(d.selected).toBe(false)
    expect(d.reason).toBe('committed-tool-use-owned')
  })
})
