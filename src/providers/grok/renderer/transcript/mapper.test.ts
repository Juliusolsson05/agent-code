import { describe, expect, it } from 'vitest'

import {
  createGrokTranscriptEntryMapper,
  extractGrokProviderSessionId,
  isGrokTypedUserPrompt,
  mapGrokEntryToFeedEntries,
} from './mapper.js'

// The fan-out and filtering rules, tested directly on the durable-row shapes
// the headless package emits (its own recorded tests prove those shapes
// against the corpus). Every expectation here mirrors a decision the mapper
// header documents.

/** Entry.message is a union across the app's entry kinds; the tests only read content. */
function contentOf(entry: unknown): unknown[] {
  return (entry as { message: { content: unknown[] } }).message.content
}

const entry = (item: unknown, overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session-1',
  item,
  raw: JSON.stringify(item),
  generation: 0,
  lineStartOffset: 42,
  inRewriteSnapshot: false,
  ...overrides,
})

describe('mapGrokEntryToFeedEntries', () => {
  it('maps a genuine user row to a user entry with its text parts', () => {
    const { entries } = mapGrokEntryToFeedEntries(entry({ type: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }))
    expect(entries).toEqual([{
      type: 'user',
      uuid: 'grok:0:42',
      parentUuid: null,
      timestamp: undefined,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
    }])
  })

  it('drops synthetic user rows entirely (native insertions, not typed input)', () => {
    const { entries } = mapGrokEntryToFeedEntries(entry({ type: 'user', content: [{ type: 'text', text: 'reminder' }], synthetic_reason: 'context_window_reminder' }))
    expect(entries).toEqual([])
  })

  it('splits an assistant row into text and tool_use blocks, parsing arguments JSON', () => {
    const { entries } = mapGrokEntryToFeedEntries(entry({
      type: 'assistant',
      content: 'running it',
      tool_calls: [
        { id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
        { id: 'call-2', name: 'weird', arguments: 'not-json' },
      ],
    }))
    expect(entries).toHaveLength(1)
    expect(contentOf(entries[0])).toEqual([
      { type: 'text', text: 'running it' },
      { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'call-2', name: 'weird', input: 'not-json' },
    ])
  })

  it('keeps a tool-only assistant row (no invented text block) and maps a tool_result to its own user entry', () => {
    const assistant = mapGrokEntryToFeedEntries(entry({ type: 'assistant', content: '  ', tool_calls: [{ id: 'call-1', name: 'bash', arguments: '{}' }] }))
    expect(contentOf(assistant.entries[0])).toEqual([{ type: 'tool_use', id: 'call-1', name: 'bash', input: {} }])
    const result = mapGrokEntryToFeedEntries(entry({ type: 'tool_result', tool_call_id: 'call-1', content: 'exit: 0' }, { lineStartOffset: 90 }))
    expect(result.entries).toEqual([{
      type: 'user',
      uuid: 'grok:0:90',
      parentUuid: null,
      timestamp: undefined,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'exit: 0', is_error: false }] },
    }])
  })

  it('maps a reasoning sibling row to a thinking-only assistant entry, and drops system/backend rows', () => {
    const reasoning = mapGrokEntryToFeedEntries(entry({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking hard' }] }))
    expect(contentOf(reasoning.entries[0])).toEqual([{ type: 'thinking', thinking: 'thinking hard' }])
    expect(mapGrokEntryToFeedEntries(entry({ type: 'system', content: 'instructions' })).entries).toEqual([])
    expect(mapGrokEntryToFeedEntries(entry({ type: 'backend_tool_call', kind: { tool_type: 'web_search' } })).entries).toEqual([])
  })

  it('scopes uuids to a generation: the same row re-delivered after a rewrite is a NEW uuid (the reset wipes the window first)', () => {
    const row = { type: 'user', content: [{ type: 'text', text: 'hello' }] }
    const before = mapGrokEntryToFeedEntries(entry(row, { generation: 1, lineStartOffset: 10 }))
    const after = mapGrokEntryToFeedEntries(entry(row, { generation: 2, lineStartOffset: 12 }))
    expect(before.entries[0]!.uuid).toBe('grok:1:10')
    expect(after.entries[0]!.uuid).toBe('grok:2:12')
    expect(before.entries[0]!.uuid).not.toBe(after.entries[0]!.uuid)
    // Within one generation, re-delivery at the same offset IS the same row.
    const redelivered = mapGrokEntryToFeedEntries(entry(row, { generation: 1, lineStartOffset: 10 }))
    expect(redelivered.entries[0]!.uuid).toBe(before.entries[0]!.uuid)
  })

  it('unwraps <user_query> rows and drops the untagged <user_info> bootstrap preamble (the corpus shapes)', () => {
    // 46 of 50 genuine corpus prompts arrive wrapped; the first session row
    // is the workspace preamble. Optimistic echoes reconcile by exact text,
    // so the mapper must emit EXACTLY what the user typed (parser decode
    // predicates, mirrored).
    const wrapped = mapGrokEntryToFeedEntries(entry({ type: 'user', content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }], prompt_index: 0 }))
    expect(contentOf(wrapped.entries[0])).toEqual([{ type: 'text', text: 'hello' }])
    const preamble = mapGrokEntryToFeedEntries(entry({ type: 'user', content: [{ type: 'text', text: '<user_info>\nworkspace details\n</user_info>' }] }))
    expect(preamble.entries).toEqual([])
    // A quoted tag INSIDE a real prompt stays ordinary text (decode's rule).
    const inner = mapGrokEntryToFeedEntries(entry({ type: 'user', content: [{ type: 'text', text: 'use <user_query> literally' }], prompt_index: 3 }))
    expect(contentOf(inner.entries[0])).toEqual([{ type: 'text', text: 'use <user_query> literally' }])
  })

  it('renders no row for the identity envelope but extracts its id, with stable markers', () => {
    expect(mapGrokEntryToFeedEntries({ sessionID: 'session-1' })).toEqual({ entries: [], historyMarker: null })
    expect(extractGrokProviderSessionId({ sessionID: 'session-1' })).toBe('session-1')
    expect(extractGrokProviderSessionId(entry({ type: 'user', content: [] }))).toBe('session-1')
    expect(isGrokTypedUserPrompt()).toBe(true)
    expect(mapGrokEntryToFeedEntries(entry({ type: 'system', content: 'x' }, { generation: 2, lineStartOffset: 7 })).historyMarker).toBe('2:7')
    expect(createGrokTranscriptEntryMapper().getTurnCursor()).toBeNull()
  })
})
