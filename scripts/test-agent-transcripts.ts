import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  inspectAgentTranscriptFile,
  readAgentTranscriptFile,
  searchAgentTranscriptFile,
} from '../src/main/agentTranscripts/AgentTranscriptReader'

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

const dir = await mkdtemp(join(tmpdir(), 'agent-transcripts-'))
const claudePath = join(dir, 'claude.jsonl')
const codexPath = join(dir, 'codex.jsonl')

await writeJsonl(claudePath, [
  {
    type: 'user',
    timestamp: '2026-05-18T08:00:00.000Z',
    cwd: '/repo',
    permissionMode: 'default',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Please inspect the parser.' }],
    },
  },
  {
    type: 'assistant',
    timestamp: '2026-05-18T08:01:00.000Z',
    cwd: '/repo',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I found the parser file.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/parser.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test', cwd: '/repo' } },
      ],
    },
  },
])

await writeJsonl(codexPath, [
  {
    timestamp: '2026-05-18T08:10:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Review PR #206.' }],
    },
  },
  {
    timestamp: '2026-05-18T08:11:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'gh pr diff 206', workdir: '/repo' }),
    },
  },
  {
    timestamp: '2026-05-18T08:12:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'No findings.' }],
    },
  },
  {
    timestamp: '2026-05-18T08:12:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'final_answer',
      message: 'No findings.',
    },
  },
])

{
  const result = await inspectAgentTranscriptFile({ path: claudePath, provider: 'auto' })
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'claude')
  assert.equal(result.stats.userMessages, 1)
  assert.equal(result.stats.assistantMessages, 1)
  assert.equal(result.stats.toolReads, 1)
  assert.equal(result.stats.shellCommands, 1)
}

{
  const result = await readAgentTranscriptFile({
    path: claudePath,
    provider: 'auto',
    projection: 'conversation',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.items.map(item => item.kind), ['user_message', 'assistant_message'])
  assert.equal(result.truncated, false)
}

{
  const result = await readAgentTranscriptFile({
    path: claudePath,
    provider: 'auto',
    projection: 'shell_commands',
  })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.kind, 'shell_command')
  assert.equal(result.items[0]?.command, 'npm test')
}

{
  const result = await readAgentTranscriptFile({
    path: codexPath,
    provider: 'auto',
    projection: 'final',
  })
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'codex')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.kind, 'assistant_message')
  assert.equal(result.items[0]?.text, 'No findings.')
  assert.equal(result.stats.assistantMessages, 1)
}

{
  const result = await searchAgentTranscriptFile({
    path: codexPath,
    provider: 'auto',
    query: 'gh pr diff',
    kinds: ['shell_command'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.item.kind, 'shell_command')
}

{
  const result = await readAgentTranscriptFile({
    path: codexPath,
    provider: 'auto',
    projection: 'timeline',
    maxChars: 20,
  })
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.ok(result.items.length < 3)
}

{
  const result = await inspectAgentTranscriptFile({ path: join(dir, 'missing.jsonl') })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'file_not_readable')
}

console.log('agent transcript tests passed')
