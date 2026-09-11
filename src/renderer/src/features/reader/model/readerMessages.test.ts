import { describe, expect, it, vi } from 'vitest'

import type { Entry } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'
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

// Folds through the given provider's reducer policy with Date.now pinned: the
// reducer stamps turn times with Date.now() and the ledger orders turns against
// committed entries by them, so an unpinned clock would make ordering depend on
// the machine running the test.
function fold(
  runtime: SessionRuntime,
  events: Record<string, unknown>[],
  options: { kind?: AgentProviderKind; nowMs?: number } = {},
): SessionRuntime {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(options.nowMs ?? T + 1_000)
  try {
    let semantic = runtime.semantic
    for (const event of events) semantic = foldSemanticEvent(semantic, event, options.kind ?? 'claude')
    return { ...runtime, semantic }
  } finally {
    clock.mockRestore()
  }
}

function foldClaude(runtime: SessionRuntime, events: Record<string, unknown>[]): SessionRuntime {
  return fold(runtime, events, { kind: 'claude' })
}

function readerMessages(runtime: SessionRuntime, provider: AgentProviderKind = 'claude') {
  const ledger = createSessionLedger()(createLedgerInputAdapter()({
    provider,
    sessionId: 's1',
    entries: runtime.entries,
    semanticCurrent: runtime.semantic.currentTurn,
    semanticHistory: runtime.semantic.history,
    ghosts: runtime.ghosts,
    streamPhase: runtime.streamPhase,
    lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
  }).input)
  const { context } = providerLedgerFeedContextFromRuntime(runtime, provider)
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

// ---------------------------------------------------------------------------
// Non-Claude producers and liveness. Reader has no provider branches of its
// own, so these pin that the one projection is right for every producer shape
// the ledger admits (review of PR #861: the first two tests were Claude-only).
// ---------------------------------------------------------------------------
describe('readerMessagesFromFeedItems across producers', () => {
  it('reads a Codex rollout blockless turn live, then as its committed entry', () => {
    // CodexHeadless publishes rollout agent messages as turn-level text with an
    // empty block map, then clears the turn text once the response_item entry
    // is committed (the rollout entry is emitted before the '' clear).
    const base: SessionRuntime = { ...emptyRuntime(), entries: [userEntry('u1', T, 'q')], lastJsonlEntryAt: T }
    const live = fold(base, [
      { type: 'turn_started', turnId: 'turn-1', role: 'assistant', source: 'rollout' },
      { type: 'turn_delta', turnId: 'turn-1', fullText: 'Codex answer', source: 'rollout' },
    ], { kind: 'codex', nowMs: T + 1_000 })
    expect(readerMessages(live, 'codex')).toEqual([
      { id: 'semantic-text:turn-1', text: 'Codex answer', live: true },
    ])

    const committed = fold({
      ...live,
      entries: [...live.entries, assistantEntry('codex-a1', 'resp_1', T + 1_200, [{ type: 'text', text: 'Codex answer' }])],
      lastJsonlEntryAt: T + 1_200,
    }, [
      { type: 'turn_delta', turnId: 'turn-1', fullText: '', source: 'rollout' },
      { type: 'turn_completed', turnId: 'turn-1', source: 'rollout' },
    ], { kind: 'codex', nowMs: T + 1_200 })
    expect(readerMessages(committed, 'codex')).toEqual([
      { id: 'entry:codex-a1', text: 'Codex answer', live: false },
    ])
  })

  it('keeps Codex proxy message text and drops its reasoning and tool calls', () => {
    const base: SessionRuntime = { ...emptyRuntime(), entries: [userEntry('u1', T, 'q')], lastJsonlEntryAt: T }
    const runtime = fold(base, [
      { type: 'turn_started', turnId: 'resp_1', role: 'assistant', source: 'proxy' },
      { type: 'block_started', turnId: 'resp_1', blockIndex: 0, kind: 'reasoning', source: 'proxy' },
      {
        type: 'block_completed',
        turnId: 'resp_1',
        blockIndex: 0,
        kind: 'reasoning',
        reasoningSummary: 'private plan',
        status: 'completed',
        source: 'proxy',
      },
      {
        type: 'block_started',
        turnId: 'resp_1',
        blockIndex: 1,
        kind: 'message',
        messagePhase: 'commentary',
        source: 'proxy',
      },
      { type: 'text_delta', turnId: 'resp_1', blockIndex: 1, textSoFar: 'Looking at files', source: 'proxy' },
      {
        type: 'block_started',
        turnId: 'resp_1',
        blockIndex: 2,
        kind: 'function_call',
        toolName: 'shell',
        callId: 'call_1',
        source: 'proxy',
      },
    ], { kind: 'codex' })

    expect(readerMessages(runtime, 'codex')).toEqual([
      { id: 'semantic-block:resp_1:1', text: 'Looking at files', live: true },
    ])
  })

  it('reads an OpenCode SSE blockless turn as live prose', () => {
    const base: SessionRuntime = { ...emptyRuntime(), entries: [userEntry('u1', T, 'q')], lastJsonlEntryAt: T }
    const runtime = fold(base, [
      { type: 'turn_started', turnId: 'msg_oc', role: 'assistant', source: 'opencode-sse' },
      { type: 'turn_delta', turnId: 'msg_oc', fullText: 'OpenCode answer', source: 'opencode-sse' },
    ], { kind: 'opencode' })

    expect(readerMessages(runtime, 'opencode')).toEqual([
      { id: 'semantic-text:msg_oc', text: 'OpenCode answer', live: true },
    ])
  })

  it('does not call finished text live while its turn stays open for a pending tool', () => {
    // The Claude fold keeps currentTurn after turn_completed while a tool
    // result is outstanding (hasPendingSemanticTools). The text block in it is
    // done; calling it live pinned Reader to the bottom of a message that
    // would never grow again.
    const base: SessionRuntime = { ...emptyRuntime(), entries: [userEntry('u1', T, 'q')], lastJsonlEntryAt: T }
    const runtime = foldClaude(base, [
      { type: 'turn_started', turnId: 'msg_t', role: 'assistant', source: 'proxy' },
      { type: 'block_started', turnId: 'msg_t', blockIndex: 0, kind: 'text', source: 'proxy' },
      { type: 'text_delta', turnId: 'msg_t', blockIndex: 0, textSoFar: 'Running the tests now.', source: 'proxy' },
      { type: 'block_completed', turnId: 'msg_t', blockIndex: 0, kind: 'text', text: 'Running the tests now.', source: 'proxy' },
      {
        type: 'block_started',
        turnId: 'msg_t',
        blockIndex: 1,
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'toolu_tests',
        source: 'proxy',
      },
      { type: 'turn_completed', turnId: 'msg_t', source: 'proxy' },
    ])
    expect(runtime.semantic.currentTurn?.turnId).toBe('msg_t')

    expect(readerMessages(runtime)).toEqual([
      { id: 'semantic-block:msg_t:0', text: 'Running the tests now.', live: false },
    ])
  })
})
