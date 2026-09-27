import { describe, expect, it } from 'vitest'

import fixture from '../../../../../testing/fixtures/rendering-shapes/codex/compaction/resumed-head-compacted.json'

import { createCodexTranscriptEntryMapper } from '@providers/codex/renderer/transcript/mapper'
import type { Entry } from '@shared/types/transcript'

// #1393: a resumed rollout that STARTS with `compacted` holds its earlier
// user prompts only in that line's replacement_history. The input is the
// REAL head of such a file (Codex 0.145.0; see the fixture's evidence):
// session_meta, compacted (8 retained user items, one of them Codex's
// AGENTS.md + environment bootstrap, 2 developer items, an encrypted
// compaction item), world_state, turn_context.
type Raw = Record<string, unknown> & { type: string; payload?: Record<string, unknown> & { replacement_history?: Array<{ role?: string }> } }
const records = fixture.records as Raw[]
const compacted = records.find(record => record.type === 'compacted')!
const retainedUserItems = compacted.payload!.replacement_history!.filter(item => item.role === 'user').length

function mapAll(lines: Raw[]): Entry[] {
  const mapper = createCodexTranscriptEntryMapper()
  return lines.flatMap(line => mapper.map(line).entries)
}
const kinds = (entries: Entry[]) => entries.map(entry => (entry as { subtype?: string }).subtype ?? entry.type)

describe('a resumed rollout that starts with compacted (#1393)', () => {
  it('shows the retained user prompts, without the bootstrap, before the boundary', () => {
    const entries = mapAll(records)
    // 8 retained user items; the AGENTS.md + environment bootstrap is dropped
    // by the same filter as on the ordinary response_item path.
    expect(retainedUserItems).toBe(8)
    expect(kinds(entries)).toEqual([...Array(7).fill('user'), 'compact_boundary'])
    // They carry the compacted line's time, so they sit where it happened.
    for (const entry of entries) expect(entry.timestamp).toBe(compacted.timestamp)
    // Stable identities, distinct from the boundary's.
    expect(new Set(entries.map(entry => entry.uuid)).size).toBe(entries.length)
  })

  it('shows only the boundary when the page does not start at the file head', () => {
    // An older-history page or a live burst can begin with a compacted line
    // whose predecessors are in the previous page: without a session_meta
    // there is no proof the retained prompts are not already in the feed.
    const withoutHead = records.filter(record => record.type !== 'session_meta')
    expect(kinds(mapAll(withoutHead))).toEqual(['compact_boundary'])
  })

  it('shows only the boundary for a compaction that follows conversation in the same file', () => {
    const prompt: Raw = { type: 'response_item', timestamp: '2026-07-23T16:33:17.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier prompt' }] } }
    const [meta, ...rest] = records
    expect(kinds(mapAll([meta!, prompt, ...rest]))).toEqual(['user', 'compact_boundary'])
  })
})
