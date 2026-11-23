import { describe, expect, it } from 'vitest'
// The assembler is imported by its own path, not the package root: the root
// also re-exports the ACP session (node:events, node:stream), and this file is
// type-checked by the web project, which must not drag Node-only modules in.
import { TurnAssembler, type AntigravityRow } from 'antigravity-acp-headless/transcript/assembler'

import {
  ANTIGRAVITY_IDENTITY_ENVELOPE_TYPE,
  createAntigravityTranscriptEntryMapper,
  extractAntigravityProviderSessionId,
  mapAntigravityRowToFeedEntries,
} from './mapper'

// The Antigravity row mapper. Rows are produced by the REAL TurnAssembler
// (the package's producer for live turns, history pages and replays) from
// ACP session/update shapes recorded against agy 1.5.15, so a drift in the
// row shape breaks these tests instead of hiding behind hand-written rows.
//
// What is pinned, and why it matters downstream:
//   - uuid = row key (and `<key>:result` for a tool's result): the feed
//     ledger dedupes by uuid, and a renderer reload / replay serves the same
//     keys back — a different uuid scheme would duplicate every bubble;
//   - historyMarker = row key: antigravityHistory.ts pages by that marker;
//   - a tool that has not finished shows its call but no result box yet;
//   - agy replays reads without output, which must not render as an empty box.

const T0 = Date.UTC(2026, 10, 23, 9, 30, 0)

/** Fold ACP updates the way a session/load replay does, into committed rows. */
function replayRows(sessionId: string, updates: Array<Record<string, unknown>>): AntigravityRow[] {
  const rows: AntigravityRow[] = []
  const assembler = new TurnAssembler(sessionId, { row: row => rows.push(row), semantic: () => {} }, () => T0)
  for (const update of updates) assembler.apply(update)
  assembler.flush()
  return rows.sort((a, b) => a.ordinal - b.ordinal)
}

const text = (sessionUpdate: string, value: string) => ({ sessionUpdate, content: { type: 'text', text: value } })

// One conversation: prompt, a thought, a replayed read (no output — agy does
// not replay read results), a command whose result arrives on a later
// tool_call_update, and the answer.
const REPLAY = [
  text('user_message_chunk', 'list the files'),
  text('agent_thought_chunk', 'I should look at the directory.'),
  { sessionUpdate: 'tool_call', toolCallId: 'call-read', name: 'list_dir', kind: 'read', title: 'List /work', status: 'completed', rawInput: { DirectoryPath: '/work' } },
  { sessionUpdate: 'tool_call', toolCallId: 'call-run', name: 'run_command', kind: 'execute', title: 'ls', status: 'pending', rawInput: { CommandLine: 'ls' } },
  { sessionUpdate: 'tool_call_update', toolCallId: 'call-run', status: 'completed', rawOutput: { output: 'a.txt\nb.txt' } },
  text('agent_message_chunk', 'There are '),
  text('agent_message_chunk', 'two files.'),
]

// Entry is a union over every provider's row types; these tests read the
// message-shaped members only.
type MessageEntry = { type: string; uuid: string; message: { role: string; content: Array<Record<string, unknown>> } }
const entriesOf = (row: AntigravityRow) => mapAntigravityRowToFeedEntries(row as unknown as Record<string, unknown>).entries as unknown as MessageEntry[]

describe('mapAntigravityRowToFeedEntries', () => {
  const rows = replayRows('sess-1', REPLAY)
  const byRole = (role: AntigravityRow['role']) => rows.filter(row => row.role === role)

  it('the replay produced the rows these tests reason about', () => {
    expect(rows.map(row => `${row.key}:${row.role}`)).toEqual([
      'ag:sess-1:0:user',
      'ag:sess-1:1:thought',
      'ag:sess-1:2:tool',
      'ag:sess-1:3:tool',
      'ag:sess-1:4:assistant',
    ])
  })

  it('every row keeps its key as the history marker and as the uuid of its first entry', () => {
    for (const row of rows) {
      const mapped = mapAntigravityRowToFeedEntries(row as unknown as Record<string, unknown>)
      expect(mapped.historyMarker).toBe(row.key)
      expect(mapped.entries[0]?.uuid).toBe(row.key)
    }
  })

  it('a user row is a user text entry carrying the session id and the row time', () => {
    const [user] = byRole('user')
    expect(mapAntigravityRowToFeedEntries(user as unknown as Record<string, unknown>).entries).toEqual([{
      type: 'user',
      uuid: 'ag:sess-1:0',
      parentUuid: null,
      // The row's own time (when its content started), whatever clock made it.
      timestamp: new Date((user as AntigravityRow).timestamp).toISOString(),
      sessionId: 'sess-1',
      message: { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
    }])
  })

  it('an assistant row is one text block with the whole segment (chunks joined)', () => {
    const [assistant] = byRole('assistant')
    const entries = entriesOf(assistant!)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'assistant', uuid: 'ag:sess-1:4', message: { role: 'assistant', content: [{ type: 'text', text: 'There are two files.' }] } })
  })

  it('a thought row is an assistant thinking block, not text', () => {
    const [thought] = byRole('thought')
    expect(entriesOf(thought!)).toEqual([expect.objectContaining({
      type: 'assistant',
      uuid: 'ag:sess-1:1',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'I should look at the directory.' }] },
    })])
  })

  it('a finished tool is a tool_use entry plus a `<key>:result` tool_result threaded by the call id', () => {
    const run = byRole('tool').find(row => row.tool?.toolCallId === 'call-run')!
    const entries = entriesOf(run)
    expect(entries.map(entry => `${entry.type}:${entry.uuid}`)).toEqual([`assistant:${run.key}`, `user:${run.key}:result`])
    expect(entries[0]!.message.content).toEqual([{ type: 'tool_use', id: 'call-run', name: 'run_command', input: { CommandLine: 'ls' } }])
    expect(entries[1]!.message).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-run', content: 'a.txt\nb.txt', is_error: false }] })
  })

  it("a replayed read with no output says 'Done.' instead of an empty result box", () => {
    const read = byRole('tool').find(row => row.tool?.toolCallId === 'call-read')!
    expect(read.tool).toMatchObject({ status: 'completed', output: null })
    const result = entriesOf(read)[1]!
    expect(result.uuid).toBe(`${read.key}:result`)
    expect(result.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-read', content: 'Done.', is_error: false })
  })

  it('a failed tool with no output names its status and is an error result', () => {
    const [failed] = replayRows('sess-2', [
      { sessionUpdate: 'tool_call', toolCallId: 'call-x', name: 'write_to_file', kind: 'edit', status: 'failed', rawInput: { TargetFile: '/ro/file' } },
    ])
    expect(entriesOf(failed!)[1]!.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-x', content: 'failed', is_error: true })
  })

  it('a tool cut off by a cancelled turn is closed as cancelled, with a result entry saying so', () => {
    // A live turn that ends while the tool is still pending: the assembler
    // closes it as cancelled, so the feed does not show it running forever.
    const rows: AntigravityRow[] = []
    const assembler = new TurnAssembler('sess-3', { row: row => rows.push(row), semantic: () => {} }, () => T0)
    assembler.setLive(true)
    assembler.beginTurn('sleep for a while')
    assembler.apply({ sessionUpdate: 'tool_call', toolCallId: 'call-sleep', name: 'run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'sleep 100' } })
    assembler.endTurn('cancelled')
    const tool = rows.find(row => row.role === 'tool')!
    expect(tool.tool).toMatchObject({ status: 'cancelled', output: null, isError: false })
    const entries = entriesOf(tool)
    expect(entries.map(entry => entry.uuid)).toEqual([tool.key, `${tool.key}:result`])
    expect(entries[0]!.message.content[0]).toMatchObject({ type: 'tool_use', id: 'call-sleep' })
    expect(entries[1]!.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-sleep', content: 'cancelled', is_error: false })
  })

  it('a live turn and its later replay map to the same uuids, so a reload dedupes instead of duplicating', () => {
    // Live: ACP does not echo the prompt (beginTurn cuts the user row) and the
    // read carries its output; the replay echoes the prompt and has no output.
    const live: AntigravityRow[] = []
    const assembler = new TurnAssembler('sess-1', { row: row => live.push(row), semantic: () => {} }, () => T0)
    assembler.setLive(true)
    assembler.beginTurn('list the files')
    assembler.apply(REPLAY[1]!)
    assembler.apply({ ...REPLAY[2]!, rawOutput: { output: 'a.txt\nb.txt' } })
    for (const update of REPLAY.slice(3)) assembler.apply(update)
    assembler.endTurn('end_turn')
    const uuids = (source: AntigravityRow[]) => [...source].sort((a, b) => a.ordinal - b.ordinal).flatMap(row => entriesOf(row).map(entry => entry.uuid))
    expect(uuids(live)).toEqual(uuids(rows))
  })
})

describe('provider session identity', () => {
  it('the identity envelope renders nothing but names the session', () => {
    const envelope = { type: ANTIGRAVITY_IDENTITY_ENVELOPE_TYPE, sessionId: 'sess-1' }
    expect(mapAntigravityRowToFeedEntries(envelope)).toEqual({ entries: [], historyMarker: null })
    expect(extractAntigravityProviderSessionId(envelope)).toBe('sess-1')
  })

  it('every committed row names its session too (a resumed pane binds from its replayed rows)', () => {
    for (const row of replayRows('sess-9', REPLAY)) expect(extractAntigravityProviderSessionId(row as unknown as Record<string, unknown>)).toBe('sess-9')
  })

  it('foreign or malformed records name no session and render nothing', () => {
    const foreign: Array<Record<string, unknown>> = [
      { type: 'user', sessionId: 'claude-session', message: { role: 'user', content: 'hi' } },
      { type: 'agent-code-identity', sessionId: 'pi-session' },
      { type: 'hermes-row', sessionId: 'hermes-session' },
      { type: ANTIGRAVITY_IDENTITY_ENVELOPE_TYPE, sessionId: '' },
      { type: ANTIGRAVITY_IDENTITY_ENVELOPE_TYPE },
    ]
    for (const record of foreign) expect(extractAntigravityProviderSessionId(record)).toBeNull()
    for (const record of foreign) expect(mapAntigravityRowToFeedEntries(record)).toEqual({ entries: [], historyMarker: null })
    // A row-typed record without a key cannot be deduped or paged: dropped.
    expect(mapAntigravityRowToFeedEntries({ type: 'antigravity-row', sessionId: 's', role: 'user', text: 'x' })).toEqual({ entries: [], historyMarker: null })
  })
})

describe('createAntigravityTranscriptEntryMapper', () => {
  it('maps through the same function and keeps no turn cursor (rows self-describe)', () => {
    const mapper = createAntigravityTranscriptEntryMapper()
    const [user] = replayRows('sess-1', REPLAY)
    expect(mapper.map(user as unknown as Record<string, unknown>)).toEqual(mapAntigravityRowToFeedEntries(user as unknown as Record<string, unknown>))
    mapper.setTurnCursor('ag-turn-1')
    expect(mapper.getTurnCursor()).toBeNull()
  })
})
