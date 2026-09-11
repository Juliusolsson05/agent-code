import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  inspectAgentTranscriptFile,
  readAgentTranscriptFile,
  searchAgentTranscriptFile,
} from './AgentTranscriptReader.js'

// Claude and Codex JSONL through the agent transcript tools. These pin the
// behavior the reader had before it learned to read OpenCode sessions, so
// giving providers one exhaustive switch cannot quietly change what a parent
// agent reads from a Claude or Codex child.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-transcript-reader-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function jsonl(name: string, records: unknown[]): string {
  const file = join(dir, name)
  writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  return file
}

const claudeTranscript = () => jsonl('claude.jsonl', [
  { type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-09-11T10:00:00.000Z', message: { role: 'user', content: 'Rename the config loader' } },
  {
    type: 'assistant',
    uuid: 'a1',
    sessionId: 's',
    timestamp: '2026-09-11T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Find its callers first.' },
        { type: 'text', text: 'Searching for callers.' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'loadConfig', path: '/repo' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/config.ts' } },
      ],
    },
  },
  { type: 'assistant', uuid: 'a2', sessionId: 's', timestamp: '2026-09-11T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Renamed to readConfig.' }] } },
])

const codexTranscript = () => jsonl('codex.jsonl', [
  { type: 'turn_context', timestamp: '2026-09-11T10:00:00.000Z', payload: { cwd: '/repo' } },
  { type: 'event_msg', timestamp: '2026-09-11T10:00:00.000Z', payload: { type: 'user_message', message: 'Run the tests' } },
  // The same prompt again as the canonical response item: one message.
  { type: 'response_item', timestamp: '2026-09-11T10:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the tests' }] } },
  { type: 'response_item', timestamp: '2026-09-11T10:00:02.000Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', workdir: '/repo' }) } },
  { type: 'response_item', timestamp: '2026-09-11T10:00:09.000Z', payload: { type: 'function_call_output', output: '12 passing' } },
  { type: 'event_msg', timestamp: '2026-09-11T10:00:10.000Z', payload: { type: 'agent_message', message: 'All 12 tests pass.', phase: 'final_answer' } },
  { type: 'response_item', timestamp: '2026-09-11T10:00:10.000Z', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'All 12 tests pass.' }] } },
])

describe('agent transcript tools on Claude and Codex JSONL', () => {
  it('reads a Claude transcript: text, tool calls by kind, and the last answer as final', async () => {
    const path = claudeTranscript()
    const result = await readAgentTranscriptFile({ path, projection: 'timeline' })
    expect(result).toMatchObject({ ok: true, provider: 'claude', path })
    expect(result.ok && result.items).toEqual([
      { kind: 'user_message', timestamp: Date.parse('2026-09-11T10:00:00.000Z'), text: 'Rename the config loader' },
      { kind: 'assistant_message', timestamp: Date.parse('2026-09-11T10:00:05.000Z'), text: 'Searching for callers.' },
      { kind: 'tool_read', timestamp: Date.parse('2026-09-11T10:00:05.000Z'), tool: 'Grep', target: '/repo', excerpt: 'Grep: /repo' },
      { kind: 'shell_command', timestamp: Date.parse('2026-09-11T10:00:05.000Z'), command: 'npm test' },
      { kind: 'tool_write', timestamp: Date.parse('2026-09-11T10:00:05.000Z'), tool: 'Edit', target: '/repo/config.ts', summary: 'Edit: /repo/config.ts' },
      { kind: 'assistant_message', timestamp: Date.parse('2026-09-11T10:01:00.000Z'), text: 'Renamed to readConfig.', final: true },
    ])
    const final = await readAgentTranscriptFile({ path, projection: 'final' })
    expect(final.ok && final.items.map(item => item.kind === 'assistant_message' && item.text)).toEqual(['Renamed to readConfig.'])
  })

  it('reads a Codex rollout: duplicate records collapse, outputs stay hidden, the final answer is marked', async () => {
    const path = codexTranscript()
    const result = await readAgentTranscriptFile({ path, projection: 'timeline' })
    expect(result).toMatchObject({ ok: true, provider: 'codex' })
    expect(result.ok && result.items).toEqual([
      { kind: 'user_message', timestamp: Date.parse('2026-09-11T10:00:00.000Z'), text: 'Run the tests' },
      { kind: 'shell_command', timestamp: Date.parse('2026-09-11T10:00:02.000Z'), command: 'npm test', cwd: '/repo' },
      { kind: 'assistant_message', timestamp: Date.parse('2026-09-11T10:00:10.000Z'), text: 'All 12 tests pass.', final: true },
    ])
    const outputs = await readAgentTranscriptFile({ path, projection: 'tool_reads', include: { rawToolOutputs: true } })
    expect(outputs.ok && outputs.items).toEqual([
      { kind: 'tool_read', timestamp: Date.parse('2026-09-11T10:00:09.000Z'), tool: 'function_call_output', excerpt: '12 passing' },
    ])
  })

  it('searches and inspects JSONL as before', async () => {
    const path = codexTranscript()
    const search = await searchAgentTranscriptFile({ path, query: 'tests' })
    expect(search.ok && search.matches.map(match => match.item.kind)).toEqual(['user_message', 'assistant_message'])
    const inspect = await inspectAgentTranscriptFile({ path })
    expect(inspect).toMatchObject({
      ok: true,
      provider: 'codex',
      firstTimestamp: Date.parse('2026-09-11T10:00:00.000Z'),
      lastTimestamp: Date.parse('2026-09-11T10:00:10.000Z'),
      stats: { totalEvents: 7, userMessages: 1, assistantMessages: 1, shellCommands: 1, toolReads: 1 },
    })
  })

  it('reports path and detection failures', async () => {
    await expect(readAgentTranscriptFile({ path: '  ', projection: 'final' })).resolves.toMatchObject({ ok: false, error: 'path_required' })
    await expect(readAgentTranscriptFile({ path: join(dir, 'missing.jsonl'), projection: 'final' })).resolves.toMatchObject({ ok: false, error: 'file_not_readable' })
    const unknown = jsonl('unknown.jsonl', [{ hello: 'world' }])
    await expect(inspectAgentTranscriptFile({ path: unknown })).resolves.toMatchObject({ ok: false, error: 'provider_detection_failed' })
    // An explicit provider skips detection.
    await expect(inspectAgentTranscriptFile({ path: unknown, provider: 'claude' })).resolves.toMatchObject({ ok: true, provider: 'claude' })
  })
})
