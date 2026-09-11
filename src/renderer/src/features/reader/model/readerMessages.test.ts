import { describe, expect, it } from 'vitest'

import type { Entry } from '@shared/types/transcript'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'
import { readerMessagesFromFeedItems } from './readerMessages'

// ---------------------------------------------------------------------------
// Reader's projection, exercised on the REAL feed pipeline output.
//
// WHY not hand-built FeedRenderItems: the contract Reader depends on is "what
// the ledger decides Feed paints". Fabricated items would let this test pass
// while the ledger emits a different shape (e.g. a history turn it keeps next
// to its committed twin). So the runtime goes through the same adapter →
// ledger → provider-correlated bridge that useLedgerFeedItems runs, and the
// semantic turns are built by the production reducer from the event vocabulary
// the headless SemanticChannel emits.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const userEntry = (uuid: string, ms: number, text: string) =>
  ({
    uuid,
    type: 'user',
    timestamp: iso(ms),
    message: { role: 'user', content: text },
  }) as unknown as Entry

const assistantEntry = (uuid: string, msgId: string, ms: number, content: unknown) =>
  ({
    uuid,
    type: 'assistant',
    timestamp: iso(ms),
    message: { id: msgId, role: 'assistant', content },
  }) as unknown as Entry

function foldClaude(runtime: SessionRuntime, events: Record<string, unknown>[]): SessionRuntime {
  let semantic = runtime.semantic
  for (const event of events) semantic = foldSemanticEvent(semantic, event, 'claude')
  return { ...runtime, semantic }
}

function readerMessages(runtime: SessionRuntime) {
  const ledger = createSessionLedger()(createLedgerInputAdapter()({
    provider: 'claude',
    sessionId: 's1',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }).input)
  const { context } = providerLedgerFeedContextFromRuntime(runtime, 'claude')
  const { items, dropped } = ledgerToFeedItems(ledger, context)
  // A dropped candidate would mean the scenario itself is malformed, and the
  // assertions below would be about a broken pipeline instead of Reader.
  expect(dropped).toEqual([])
  return readerMessagesFromFeedItems(items)
}

describe('readerMessagesFromFeedItems', () => {
  it('keeps committed and live assistant prose in feed order and drops thinking and tool blocks', () => {
    const base: SessionRuntime = {
      ...emptyRuntime(),
      entries: [
        userEntry('u1', T, 'fix the reader'),
        assistantEntry('a1', 'msg_1', T + 100, 'Committed answer'),
        // A tool-only carrier: painted by Feed as a tool row, never prose.
        assistantEntry('a2', 'msg_2', T + 200, [
          { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } },
        ]),
      ],
      lastJsonlEntryAt: T + 200,
    }
    const runtime = foldClaude(base, [
      { type: 'turn_started', turnId: 'msg_live', role: 'assistant', source: 'proxy' },
      { type: 'block_started', turnId: 'msg_live', blockIndex: 0, kind: 'thinking', source: 'proxy' },
      {
        type: 'thinking_delta',
        turnId: 'msg_live',
        blockIndex: 0,
        thinkingDelta: 'Weighing the options',
        thinkingSoFar: 'Weighing the options',
        source: 'proxy',
      },
      // ClaudeProxyAdapter completes a thinking block with `text: block.thinking`
      // (ClaudeProxyAdapter.ts, the kind:'thinking' publishBlockCompleted), and
      // the reducer copies ev.text into block.text. So a finished thinking
      // block DOES carry its reasoning in `text`; only the kind classifier
      // keeps it out of Reader.
      {
        type: 'block_completed',
        turnId: 'msg_live',
        blockIndex: 0,
        kind: 'thinking',
        text: 'Weighing the options',
        source: 'proxy',
      },
      {
        type: 'block_started',
        turnId: 'msg_live',
        blockIndex: 1,
        kind: 'tool_use',
        toolName: 'Edit',
        toolUseId: 'toolu_edit',
        source: 'proxy',
      },
      { type: 'block_started', turnId: 'msg_live', blockIndex: 2, kind: 'text', source: 'proxy' },
      {
        type: 'text_delta',
        turnId: 'msg_live',
        blockIndex: 2,
        textDelta: 'Streaming answer so far',
        textSoFar: 'Streaming answer so far',
        source: 'proxy',
      },
    ])

    expect(readerMessages(runtime)).toEqual([
      { id: 'entry:a1', text: 'Committed answer', live: false },
      { id: 'semantic-block:msg_live:2', text: 'Streaming answer so far', live: true },
    ])
  })

  it('does not repeat text the transcript has already committed', () => {
    // The live → committed handoff: the proxy finished the turn (it moved to
    // semantic history) and Claude's JSONL now carries the same message. The
    // ledger gives the text to the committed entry; Reader must show it once,
    // not once per source. The old whole-string compare only looked at the
    // current turn and missed this window entirely.
    const answer = 'Here is the final plan.'
    const base: SessionRuntime = {
      ...emptyRuntime(),
      entries: [
        userEntry('u1', T, 'plan it'),
        assistantEntry('a1', 'msg_final', T + 100, answer),
      ],
      lastJsonlEntryAt: T + 100,
    }
    const runtime = foldClaude(base, [
      { type: 'turn_started', turnId: 'msg_final', role: 'assistant', source: 'proxy' },
      { type: 'block_started', turnId: 'msg_final', blockIndex: 0, kind: 'text', source: 'proxy' },
      {
        type: 'text_delta',
        turnId: 'msg_final',
        blockIndex: 0,
        textDelta: answer,
        textSoFar: answer,
        source: 'proxy',
      },
      {
        type: 'block_completed',
        turnId: 'msg_final',
        blockIndex: 0,
        kind: 'text',
        text: answer,
        source: 'proxy',
      },
      { type: 'turn_completed', turnId: 'msg_final', fullText: answer, source: 'proxy' },
    ])
    expect(runtime.semantic.currentTurn).toBeNull()
    expect(runtime.semantic.history).toHaveLength(1)

    expect(readerMessages(runtime)).toEqual([
      { id: 'entry:a1', text: answer, live: false },
    ])
  })
})
