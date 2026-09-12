import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectAgentTranscriptFile, readAgentTranscriptFile, searchAgentTranscriptFile } from './AgentTranscriptReader.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reader-characterization-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
type Provider = 'claude' | 'codex'
function jsonl(records: unknown[]): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  return path
}
function message(provider: Provider, role: 'user' | 'assistant', text: string, timestamp: number, phase?: string) {
  return provider === 'claude'
    ? { type: role, uuid: `${role}-${timestamp}`, timestamp, message: { role, content: [{ type: 'text', text }] } }
    : { type: 'response_item', timestamp, payload: { type: 'message', role, phase, content: [{ type: 'text', text }] } }
}
function call(provider: Provider, name: string, input: Record<string, unknown>, timestamp: number) {
  return provider === 'claude'
    ? { type: 'assistant', uuid: `tool-${timestamp}`, timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } }
    : { type: 'response_item', timestamp, payload: { type: 'function_call', name, arguments: JSON.stringify(input) } }
}
const emptyStats = { totalEvents: 0, returnedItems: 0, userMessages: 0, assistantMessages: 0, toolReads: 0, toolWrites: 0, shellCommands: 0, patches: 0, testRuns: 0, parseErrors: 0 }

// These are permanent hand-authored characterizations of the R6 scratch
// baseline. Some historical choices are surprising (notably duplicate phase
// handling and tail caps); changing OpenCode must not silently repair them.
describe.each(['claude', 'codex'] as const)('%s JSONL compatibility', provider => {
  it('reports read failures with an explicit provider instead of attempting detection', async () => {
    const missing = join(dir, 'missing.jsonl')
    for (const read of [
      (path: string) => readAgentTranscriptFile({ path, provider, projection: 'timeline' }),
      (path: string) => searchAgentTranscriptFile({ path, provider, query: 'x' }),
      (path: string) => inspectAgentTranscriptFile({ path, provider }),
    ]) {
      await expect(read(missing)).resolves.toEqual({ ok: false, error: 'file_not_readable', message: `Transcript file is missing or not readable: ${missing}` })
      // access(R_OK) succeeds for a directory; opening it as JSONL is a
      // reducer read failure. This proves explicit-provider reads catch I/O
      // errors after preparation as well as rejecting missing paths.
      await expect(read(dir)).resolves.toMatchObject({ ok: false, error: 'transcript_read_failed', message: expect.stringContaining('EISDIR') })
    }
  })

  it.each([
    { line: '', events: 0, errors: 0 },
    { line: '  ', events: 0, errors: 0 },
    { line: '{broken', events: 1, errors: 1 },
    { line: 'null', events: 1, errors: 1 },
    { line: '[]', events: 1, errors: 0 },
    { line: '[{"type":"assistant"}]', events: 1, errors: 0 },
    { line: '42', events: 1, errors: 0 },
    { line: 'true', events: 1, errors: 0 },
    { line: '"text"', events: 1, errors: 0 },
    { line: '{}', events: 1, errors: 0 },
    { line: '{"message":[],"payload":false}', events: 1, errors: 0 },
  ])('counts malformed/non-record input $line without inventing items', async ({ line, events, errors }) => {
    const path = jsonl([])
    writeFileSync(path, line + '\n' + JSON.stringify(message(provider, 'user', 'survivor', 1)) + '\n')
    const stats = { ...emptyStats, totalEvents: events + 1, userMessages: 1, parseErrors: errors }
    const read = await readAgentTranscriptFile({ path, provider, projection: 'timeline' })
    expect(read).toMatchObject({ ok: true, stats: { ...stats, returnedItems: 1 } })
    expect(read.ok && read.items).toEqual([{ kind: 'user_message', timestamp: 1, text: 'survivor' }])
    const search = await searchAgentTranscriptFile({ path, provider, query: 'survivor', contextItems: 0 })
    expect(search).toMatchObject({ ok: true, stats: { ...stats, returnedItems: 1 } })
    expect(search.ok && search.matches.map(match => match.item)).toEqual([{ kind: 'user_message', timestamp: 1, text: 'survivor' }])
    await expect(inspectAgentTranscriptFile({ path, provider })).resolves.toMatchObject({ ok: true, stats, firstTimestamp: 1, lastTimestamp: 1 })
  })

  it('collapses adjacent duplicates but preserves the same record after another item', async () => {
    const repeated = message(provider, 'user', 'again', 1)
    const path = jsonl([repeated, repeated, message(provider, 'user', 'between', 2), repeated])
    const expected = [
      { kind: 'user_message', timestamp: 1, text: 'again' },
      { kind: 'user_message', timestamp: 2, text: 'between' },
      { kind: 'user_message', timestamp: 1, text: 'again' },
    ]
    const read = await readAgentTranscriptFile({ path, projection: 'conversation' })
    expect(read.ok && read.items).toEqual(expected)
    const search = await searchAgentTranscriptFile({ path, query: 'again', contextItems: 0 })
    expect(search.ok && search.matches.map(match => match.item)).toEqual([expected[0], expected[2]])
    await expect(inspectAgentTranscriptFile({ path })).resolves.toMatchObject({ ok: true, stats: { totalEvents: 4, userMessages: 3 } })
  })

  it('preserves true/false include overrides, including the historical final fallback', async () => {
    const path = jsonl([
      message(provider, 'user', 'prompt', 1),
      call(provider, 'Read', { file_path: '/r' }, 2),
      call(provider, 'Edit', { file_path: '/w' }, 3),
      call(provider, 'Bash', { command: 'echo ok' }, 4),
      message(provider, 'assistant', 'done', 5),
    ])
    const answer = { kind: 'assistant_message', timestamp: 5, text: 'done', final: true }
    const included = await readAgentTranscriptFile({ path, projection: 'final', include: { assistantMessages: true, userMessages: true, toolReads: true, toolWrites: true, shellCommands: true } })
    expect(included.ok && included.items).toEqual([
      { kind: 'user_message', timestamp: 1, text: 'prompt' },
      { kind: 'tool_read', timestamp: 2, tool: 'Read', target: '/r', excerpt: 'Read: /r' },
      { kind: 'tool_write', timestamp: 3, tool: 'Edit', target: '/w', summary: 'Edit: /w' },
      { kind: 'shell_command', timestamp: 4, command: 'echo ok' }, answer,
    ])
    const excluded = await readAgentTranscriptFile({ path, projection: 'timeline', include: { assistantMessages: false, userMessages: false, toolReads: false, toolWrites: false, shellCommands: false } })
    expect(excluded.ok && excluded.items).toEqual([])
    // The existing fallback bypasses assistantMessages:false only for final.
    // Pin it here rather than changing Claude/Codex in an OpenCode fix.
    const fallback = await readAgentTranscriptFile({ path, projection: 'final', include: { assistantMessages: false } })
    expect(fallback.ok && fallback.items).toEqual([answer])
  })

  it('pins tail eviction and exact item/character caps', async () => {
    const path = jsonl(['aaaa', 'bbbb', 'cccc', 'dddd'].map((text, i) => message(provider, 'user', text, i + 1)))
    const first = { kind: 'user_message', timestamp: 1, text: 'aaaa' }
    const second = { kind: 'user_message', timestamp: 2, text: 'bbbb' }
    const third = { kind: 'user_message', timestamp: 3, text: 'cccc' }
    for (const [bounds, expected, truncated] of [
      [{ maxItems: 4, maxChars: 16 }, [first, second, third, { kind: 'user_message', timestamp: 4, text: 'dddd' }], false],
      [{ maxItems: 2 }, [first, second], true],
      [{ maxChars: 8 }, [first, second], true],
      [{ maxChars: 7 }, [first], true],
      [{ tail: 2, maxItems: 1 }, [third], true],
      [{ tail: 2, maxChars: 4 }, [third], true],
    ] as const) {
      const read = await readAgentTranscriptFile({ path, projection: 'conversation', ...bounds })
      expect(read).toMatchObject({ ok: true, truncated, stats: { totalEvents: 4, userMessages: 4, returnedItems: expected.length } })
      expect(read.ok && read.items).toEqual(expected)
    }
    const long = jsonl([message(provider, 'user', '012345678901234567890123456789012345678901234567890123456789', 1)])
    const bounded = await readAgentTranscriptFile({ path: long, projection: 'conversation', maxCharsPerItem: 50 })
    expect(bounded.ok && bounded.items).toEqual([{ kind: 'user_message', timestamp: 1, text: '01234567890123456789012345\n[truncated]' }])
    expect(bounded).toMatchObject({ truncated: false })
    const search = await searchAgentTranscriptFile({ path: long, query: '0123', maxCharsPerMatch: 50, contextItems: 0 })
    expect(search.ok && search.matches.map(match => match.item)).toEqual([{ kind: 'user_message', timestamp: 1, text: '01234567890123456789012345\n[truncated]' }])
    const exact = jsonl([message(provider, 'user', '01234567890123456789012345678901234567890123456789', 1)])
    const uncut = await readAgentTranscriptFile({ path: exact, projection: 'conversation', maxCharsPerItem: 50, maxChars: 50 })
    expect(uncut.ok && uncut.items).toEqual([{ kind: 'user_message', timestamp: 1, text: '01234567890123456789012345678901234567890123456789' }])
  })

  it('filters search kinds while retaining before/after context of other kinds', async () => {
    const path = jsonl([
      message(provider, 'user', 'needle prompt', 1),
      call(provider, 'Read', { path: '/needle' }, 2),
      message(provider, 'assistant', 'needle answer', 3, 'final_answer'),
      message(provider, 'user', 'after', 4),
    ])
    const search = await searchAgentTranscriptFile({ path, query: 'NEEDLE', kinds: ['assistant_message'], contextItems: 1 })
    expect(search.ok && search.matches).toEqual([{
      item: { kind: 'assistant_message', timestamp: 3, text: 'needle answer', ...(provider === 'codex' ? { final: true } : {}) },
      before: [{ kind: 'tool_read', timestamp: 2, tool: 'Read', target: '/needle', excerpt: 'Read: /needle' }],
      after: [{ kind: 'user_message', timestamp: 4, text: 'after' }],
    }])
    const capped = await searchAgentTranscriptFile({ path, query: 'needle', contextItems: 0, maxMatches: 1 })
    expect(capped).toMatchObject({ ok: true, truncated: true, stats: { totalEvents: 4, assistantMessages: 1, userMessages: 2, toolReads: 1 } })
    expect(capped.ok && capped.matches).toEqual([{ item: { kind: 'user_message', timestamp: 1, text: 'needle prompt' }, before: undefined, after: undefined }])
  })
})

describe('Codex duplicate phases and raw-output overrides', () => {
  it.each([
    { first: 'commentary', second: 'final_answer', firstFinal: false, lastFinal: true, finalText: 'last' },
    { first: 'final_answer', second: 'commentary', firstFinal: true, lastFinal: false, finalText: 'duplicate' },
  ])('pins conflicting adjacent phases: $first then $second', async ({ first, second, firstFinal, lastFinal, finalText }) => {
    const path = jsonl([
      message('codex', 'assistant', 'duplicate', 1, first),
      message('codex', 'assistant', 'duplicate', 1, second),
      message('codex', 'assistant', 'last', 2, 'commentary'),
    ])
    const read = await readAgentTranscriptFile({ path, projection: 'assistant_messages' })
    expect(read.ok && read.items).toEqual([
      { kind: 'assistant_message', timestamp: 1, text: 'duplicate', final: firstFinal },
      { kind: 'assistant_message', timestamp: 2, text: 'last', final: lastFinal },
    ])
    const final = await readAgentTranscriptFile({ path, projection: 'final' })
    expect(final.ok && final.items).toEqual([{ kind: 'assistant_message', timestamp: finalText === 'last' ? 2 : 1, text: finalText, final: true }])
    const search = await searchAgentTranscriptFile({ path, query: 'duplicate', contextItems: 0 })
    expect(search.ok && search.matches[0]?.item).toEqual({ kind: 'assistant_message', timestamp: 1, text: 'duplicate', final: firstFinal })
    await expect(inspectAgentTranscriptFile({ path })).resolves.toMatchObject({ ok: true, stats: { totalEvents: 3, assistantMessages: 2 } })
  })

  it('requires rawToolOutputs:true and still honors toolReads:false', async () => {
    const path = jsonl([{ type: 'function_call_output', output: 'needle output' }])
    for (const include of [{ toolReads: true }, { rawToolOutputs: false }, { rawToolOutputs: true, toolReads: false }]) {
      const result = await readAgentTranscriptFile({ path, provider: 'codex', projection: 'timeline', include })
      expect(result.ok && result.items).toEqual([])
    }
    const raw = await readAgentTranscriptFile({ path, provider: 'codex', projection: 'tool_reads', include: { rawToolOutputs: true } })
    expect(raw.ok && raw.items).toEqual([{ kind: 'tool_read', timestamp: undefined, tool: 'function_call_output', excerpt: 'needle output' }])
    const search = await searchAgentTranscriptFile({ path, provider: 'codex', query: 'needle' })
    expect(search.ok && search.matches).toEqual([])
  })
})
