import { describe, expect, it } from 'vitest'

import fixture from '../../../../testing/fixtures/rendering-shapes/codex/compaction/committed-compacted.json'

import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { visibleMessageSummary } from '@renderer/workspace/orchestrationMcp'
import type { SessionMeta } from '@renderer/workspace/types'

// #1386 review a (P2): a readable Codex compaction summary is a synthetic
// `type: 'user'` entry. The agent read API counted it as a message, so a
// coordinator reading the child's one-message tail got the summary back as the
// child's latest user instruction. The input is the fixture's REAL older
// `compacted` line (readable `message`) through the real Codex mapper, with no
// actual prompt anywhere in the transcript.
const legacy = (fixture.records as Array<Record<string, unknown>>)[1]!
const meta = { kind: 'codex', cwd: '/repo' } as SessionMeta

function runtimeWith(entries: SessionRuntime['entries']): SessionRuntime {
  return { ...emptyRuntime(), entries }
}

describe('agent read API and compaction summaries', () => {
  it('does not report a compaction summary as a user message', () => {
    const entries = mapCodexRolloutToFeedEntries(legacy)
    // Guard the premise: the mapper really emits a user-typed summary row.
    expect(entries.some(entry => entry.type === 'user')).toBe(true)

    const summary = visibleMessageSummary(runtimeWith(entries), meta, 1, 4_000, 16_000)
    expect(summary.messageCount).toBe(0)
    expect(summary.messages).toEqual([])
  })

  it('still reports a real prompt next to the summary', () => {
    const prompt = {
      type: 'user',
      uuid: 'prompt-1',
      parentUuid: null,
      timestamp: '2026-09-25T06:08:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'continue with the plan' }] },
    } as SessionRuntime['entries'][number]
    const entries = [...mapCodexRolloutToFeedEntries(legacy), prompt]

    const summary = visibleMessageSummary(runtimeWith(entries), meta, 5, 4_000, 16_000)
    expect(summary.messageCount).toBe(1)
    expect(summary.messages.map(message => message.text)).toEqual(['continue with the plan'])
  })
})
