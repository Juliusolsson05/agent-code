import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { applyFeedEvent, createReplayFoldState } from '@renderer/rendering/replay/reconstructSlices.js'

// Replay of the checked-in grok session-feed recording (produced by the
// node-side capture test through the real forwarder). This is the Stage 5
// proof that the recorded wire form, applied through the shared fold, leaves
// the window exactly in the state the pure owner prescribes: the reset wipes
// the superseded generation, the snapshot re-appends the conversation, the new
// answer lands after caught-up, and the stale duplicate boundary (the
// reconnect case recorded at the tail) changes nothing.
//
// Stage 6 registered the kind, so the fold state is the real factory's —
// the same construction the recorded-session harness uses for every provider.

const fixture = new URL('../../../../../testing/fixtures/grok-session-feed/rewrite-reorder.events.jsonl', import.meta.url)

describe('grok session-feed recording replay', () => {
  it('applies the recorded rewrite: wipe, snapshot re-append, caught-up, stale duplicates', () => {
    const frames = readFileSync(fixture, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as { channel: string; payload: unknown })
    expect(frames.length).toBeGreaterThan(0)
    const state = createReplayFoldState('grok', 'grok-feed-1')
    for (const frame of frames) {
      if (frame.channel.startsWith('session:')) applyFeedEvent(state as never, frame.channel as never, frame.payload)
    }
    const texts = (state.entries as Array<{ message: { content: Array<{ type: string; text?: string }> } }>)
      .map(entry => entry.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .filter(text => text.length > 0)
    expect(texts).toEqual(['hello', 'old answer', 'new answer'])
    expect(state.historyWindow.generation).toBe(1)
    expect(state.historyWindow.awaitingCaughtUp).toBe(false)
  })
})
