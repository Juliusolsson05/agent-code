// Recorded against agy 1.5.15 (`agy acp`, personal Google account): the live
// update sequence of a two-turn conversation and the replay session/load sent
// for the same conversation, paths replaced by /work. The property under test
// is the one history and reloads depend on: a live turn and its replay cut
// the same rows under the same keys.

import { describe, expect, it } from 'vitest'

import { TurnAssembler, type AntigravityRow, type AntigravitySemanticEvent } from './assembler.js'

const read = { toolCallId: 'call_1', name: 'read_file', args: { Path: '/work/a.txt' }, kind: 'read', title: 'File a.txt', rawInput: { Path: '/work/a.txt' } }
const shell = { toolCallId: 'call_2', name: 'run_command', kind: 'execute', title: 'cat b.txt', rawInput: { CommandLine: 'cat b.txt' } }

const LIVE_TURNS: Array<{ prompt: string; updates: Record<string, unknown>[] }> = [
  { prompt: 'Reply with exactly the word: pong', updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } }] },
  {
    prompt: 'Read a.txt and reply with its contents.',
    updates: [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the file.' } },
      { sessionUpdate: 'tool_call', ...read, status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', ...read, status: 'completed' },
      { sessionUpdate: 'tool_call', ...shell, status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', ...shell, status: 'completed', rawOutput: { output: 'Command output:\nok\r\n', exit_code: 0 } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from a.txt' } },
    ],
  },
]

// What session/load replays for the same conversation (recorded shape: user
// chunks are echoed, tool calls arrive already completed, without output).
const REPLAY: Record<string, unknown>[] = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Reply with exactly the word: pong' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Read a.txt and reply with its contents.' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the file.' } },
  { sessionUpdate: 'tool_call', ...read, status: 'completed' },
  { sessionUpdate: 'tool_call', ...shell, status: 'completed' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from a.txt' } },
]

function collect(): { rows: AntigravityRow[]; events: AntigravitySemanticEvent[]; assembler: TurnAssembler } {
  const rows: AntigravityRow[] = []
  const events: AntigravitySemanticEvent[] = []
  const assembler = new TurnAssembler('s1', { row: row => rows.push(row), semantic: event => events.push(event) }, () => 1)
  return { rows, events, assembler }
}

const shape = (rows: AntigravityRow[]) => [...rows].sort((a, b) => a.ordinal - b.ordinal).map(row => `${row.key} ${row.role} ${row.text ?? row.tool?.name}`)

describe('TurnAssembler', () => {
  it('cuts a live conversation and its replay into the same keyed rows', () => {
    const live = collect()
    live.assembler.setLive(true)
    for (const turn of LIVE_TURNS) {
      live.assembler.beginTurn(turn.prompt)
      for (const update of turn.updates) live.assembler.apply(update)
      live.assembler.endTurn('end_turn')
    }
    const replay = collect()
    replay.assembler.setLive(false)
    for (const update of REPLAY) replay.assembler.apply(update)
    replay.assembler.flush()

    expect(shape(live.rows)).toEqual([
      'ag:s1:0 user Reply with exactly the word: pong',
      'ag:s1:1 assistant pong',
      'ag:s1:2 user Read a.txt and reply with its contents.',
      'ag:s1:3 thought Reading the file.',
      'ag:s1:4 tool read_file',
      'ag:s1:5 tool run_command',
      'ag:s1:6 assistant hello from a.txt',
    ])
    expect(shape(replay.rows)).toEqual(shape(live.rows))
    // A replay streams nothing live.
    expect(replay.events).toEqual([])
  })

  it('streams the feed vocabulary for a live turn and carries tool output', () => {
    const live = collect()
    live.assembler.setLive(true)
    live.assembler.beginTurn(LIVE_TURNS[1]!.prompt)
    for (const update of LIVE_TURNS[1]!.updates) live.assembler.apply(update)
    live.assembler.endTurn('end_turn')
    const types = live.events.map(event => event.type)
    expect(types[0]).toBe('turn_started')
    expect(types).toContain('thinking_delta')
    expect(types).toContain('tool_input_finalized')
    expect(live.events.find(event => event.type === 'tool_result' && event.toolUseId === 'call_2')?.content).toContain('ok')
    const turnCompleted = live.events.find(event => event.type === 'turn_completed')
    expect(turnCompleted?.fullText).toBe('hello from a.txt')
    expect(live.rows.find(row => row.tool?.toolCallId === 'call_2')?.tool?.output).toContain('ok')
  })

  it('reports a cancelled turn and commits a tool that never finished', () => {
    const live = collect()
    live.assembler.setLive(true)
    live.assembler.beginTurn('run it')
    live.assembler.apply({ sessionUpdate: 'tool_call', ...shell, status: 'pending' })
    live.assembler.endTurn('cancelled')
    expect(live.events.some(event => event.type === 'api_error' && event.errorType === 'cancelled')).toBe(true)
    expect(live.rows.find(row => row.role === 'tool')?.tool?.status).toBe('pending')
  })
})
