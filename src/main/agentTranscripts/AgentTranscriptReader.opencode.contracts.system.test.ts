import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LiveFixtureWriter, sessionRowFor } from 'opencode-terminal-headless/testing/index'
import { createOpencodeDatabase, type OpencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase.js'
import type { AgentTranscriptItem } from '@mcp/shared/agentTranscriptTypes.js'
import { inspectAgentTranscriptFile, readAgentTranscriptFile, searchAgentTranscriptFile } from './AgentTranscriptReader.js'

let dir: string
let database: OpencodeDatabase
const sessionID = 'ses_reader_contracts'
const path = `opencode://session/${sessionID}`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reader-contracts-'))
  database = createOpencodeDatabase({ resolveDbPath: async () => join(dir, 'opencode.db') })
})
afterEach(() => {
  database.release()
  rmSync(dir, { recursive: true, force: true })
})

type Message = { info: Record<string, unknown>; parts: Record<string, unknown>[] }
function writeMessages(messages: Message[]): void {
  const writer = new LiveFixtureWriter(join(dir, 'opencode.db'), sessionID, sessionRowFor(sessionID))
  try {
    messages.forEach(({ info, parts }, index) => {
      const id = `msg_${String(index).padStart(3, '0')}`
      writer.apply('message.updated.1', { sessionID, info: { id, sessionID, role: 'assistant', time: { created: 100 + index, completed: 200 + index }, ...info } })
      parts.forEach((part, partIndex) => writer.apply('message.part.updated.1', {
        sessionID, part: { id: `prt_${index}_${String(partIndex).padStart(3, '0')}`, messageID: id, sessionID, ...part },
      }))
    })
  } finally {
    writer.close()
  }
}

// Oracle: sst/opencode@v1.18.30 packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
// and session/processor.ts, also checked in the installed 1.18.30 binary.
// Each case is a first turn: a prior stop answer would mask fallback bugs.
describe('OpenCode owns final-answer semantics', () => {
  it('never promotes a completed tool step while the next step streams', async () => {
    writeMessages([
      { info: { finish: 'tool-calls' }, parts: [{ type: 'text', text: 'I will run the tests' }] },
      { info: { time: { created: 101 } }, parts: [{ type: 'text', text: 'Still stream' }] },
    ])
    const deps = { opencode: database }
    await expect(readAgentTranscriptFile({ path, projection: 'final' }, deps)).resolves.toMatchObject({ ok: true, items: [] })
    const timeline = await readAgentTranscriptFile({ path, projection: 'timeline' }, deps)
    expect(timeline.ok && timeline.items).toEqual([{ kind: 'assistant_message', timestamp: 100, text: 'I will run the tests', final: false }])
  })

  it.each([
    { finish: undefined, final: false },
    { finish: 'unknown', final: false },
    { finish: 'length', final: true },
    { finish: 'stop', final: true },
  ])('finish=$finish yields final=$final', async ({ finish, final }) => {
    writeMessages([{ info: { finish }, parts: [{ type: 'text', text: 'Answer' }] }])
    const deps = { opencode: database }
    const item = { kind: 'assistant_message', timestamp: 100, text: 'Answer', final }
    const read = await readAgentTranscriptFile({ path, projection: 'final' }, deps)
    expect(read.ok && read.items).toEqual(final ? [item] : [])
    const search = await searchAgentTranscriptFile({ path, query: 'Answer' }, deps)
    expect(search.ok && search.matches[0]?.item).toEqual(item)
  })

  it.each([
    { name: 'MessageAbortedError', message: 'interrupted', finish: undefined, partial: 'Partial answer' },
    { name: 'MessageAbortedError', message: 'interrupted', finish: 'stop', partial: 'Partial answer' },
    { name: 'APIError', message: 'upstream unavailable', finish: 'stop', partial: 'Partial answer' },
    { name: 'APIError', message: 'upstream unavailable', finish: 'error', partial: '' },
  ])('preserves $name with finish=$finish and partial=$partial', async ({ name, message, finish, partial }) => {
    writeMessages([{ info: { finish, error: { name, data: { message } } }, parts: [{ type: 'text', text: partial }] }])
    const deps = { opencode: database }
    const text = `[OpenCode error: ${name}: ${message}]${partial ? `\n\n${partial}` : ''}`
    const conversation = await readAgentTranscriptFile({ path, projection: 'conversation' }, deps)
    expect(conversation.ok && conversation.items).toEqual([{ kind: 'assistant_message', timestamp: 100, text, final: false }])
    await expect(readAgentTranscriptFile({ path, projection: 'final' }, deps)).resolves.toMatchObject({ ok: true, items: [] })
    const search = await searchAgentTranscriptFile({ path, query: name }, deps)
    expect(search.ok && search.matches[0]?.item).toEqual({ kind: 'assistant_message', timestamp: 100, text, final: false })
  })

  it('keeps failure evidence visible under a small per-item cap', async () => {
    writeMessages([{ info: { finish: 'stop', error: { name: 'APIError', data: { message: 'failed' } } }, parts: [{ type: 'text', text: 'partial'.repeat(100) }] }])
    const result = await readAgentTranscriptFile({ path, projection: 'conversation', maxCharsPerItem: 50 }, { opencode: database })
    expect(result.ok && result.items).toEqual([{ kind: 'assistant_message', timestamp: 100, text: '[OpenCode error: APIError:\n[truncated]', final: false }])
  })
})

type ToolCase = {
  tool: string
  input: Record<string, unknown>
  kind: 'tool_read' | 'tool_write' | 'shell_command' | 'patch'
  target?: string
  why: string
}

// Independent classification oracle: every built-in in
// sst/opencode@v1.18.30 packages/opencode/src/tool/registry.ts, including the
// binary's gated execute tool, plus explicitly specified custom/MCP actions.
// This table states effects, not a second substring-based implementation.
// Indirect tools (task/execute) cannot truthfully enumerate their child side
// effects; those come from child transcripts/snapshots, not their tool names.
const tools: ToolCase[] = [
  { tool: 'bash', input: { command: 'npm test' }, kind: 'shell_command', why: 'runs a shell' },
  { tool: 'read', input: { filePath: '/repo/a.ts' }, kind: 'tool_read', target: '/repo/a.ts', why: 'reads file contents' },
  { tool: 'glob', input: { path: '/repo', pattern: '*.ts' }, kind: 'tool_read', target: '/repo', why: 'lists matches in a directory' },
  { tool: 'grep', input: { pattern: 'needle' }, kind: 'tool_read', target: 'needle', why: 'searches file contents' },
  { tool: 'edit', input: { filePath: '/repo/a.ts' }, kind: 'tool_write', target: '/repo/a.ts', why: 'replaces file contents' },
  { tool: 'write', input: { filePath: '/repo/b.ts' }, kind: 'tool_write', target: '/repo/b.ts', why: 'creates or overwrites a file' },
  { tool: 'apply_patch', input: { patchText: '*** Add File: a.ts\n+x' }, kind: 'patch', why: 'applies a multi-file patch' },
  { tool: 'task', input: { description: 'check callers' }, kind: 'tool_read', target: 'check callers', why: 'delegates; no direct file write is established' },
  { tool: 'webfetch', input: { url: 'https://example.test' }, kind: 'tool_read', target: 'https://example.test', why: 'retrieves a URL' },
  { tool: 'websearch', input: { query: 'needle' }, kind: 'tool_read', target: 'needle', why: 'retrieves search results' },
  { tool: 'todowrite', input: { todos: [], command: 'bookkeeping only' }, kind: 'tool_read', why: 'session metadata, never file changes or shell execution' },
  { tool: 'skill', input: { name: 'review' }, kind: 'tool_read', target: 'review', why: 'loads instructions' },
  { tool: 'question', input: {}, kind: 'tool_read', why: 'asks a user question' },
  { tool: 'lsp', input: { filePath: '/repo/a.ts' }, kind: 'tool_read', target: '/repo/a.ts', why: 'queries language-server information' },
  { tool: 'plan_exit', input: {}, kind: 'tool_read', why: 'changes agent mode, not files' },
  { tool: 'invalid', input: {}, kind: 'tool_read', why: 'reports invalid tool use' },
  { tool: 'execute', input: { code: 'return await tools.lookup()' }, kind: 'tool_read', why: 'orchestrates MCP calls; direct effect unknown' },
  { tool: 'filesystem_read_file', input: { filePath: '/outside/a' }, kind: 'tool_read', target: '/outside/a', why: 'MCP file read, camel-case target' },
  { tool: 'filesystem:read_file', input: { file_path: '/outside/b' }, kind: 'tool_read', target: '/outside/b', why: 'MCP file read, snake-case target' },
  { tool: 'filesystem_write_file', input: { path: '/outside-repo/notes.txt' }, kind: 'tool_write', target: '/outside-repo/notes.txt', why: 'outside-repository write has no snapshot safety net' },
  { tool: 'filesystem:write_file', input: { filePath: '/outside/a', path: '/ignored' }, kind: 'tool_write', target: '/outside/a', why: 'camel-case target wins when both aliases occur' },
  { tool: 'filesystem_delete_file', input: { file_path: '/outside/b' }, kind: 'tool_write', target: '/outside/b', why: 'deletes a file' },
  { tool: 'filesystem:delete_file', input: { path: '/outside/c' }, kind: 'tool_write', target: '/outside/c', why: 'colon-qualified deletion' },
  { tool: 'mail_send_email', input: {}, kind: 'tool_write', why: 'sends externally visible content' },
  { tool: 'mail:send_email', input: {}, kind: 'tool_write', why: 'colon-qualified send' },
  { tool: 'custom_edit_document', input: { filePath: '/outside/d' }, kind: 'tool_write', target: '/outside/d', why: 'custom tools need the generic effects policy too' },
  { tool: 'runner:run', input: { command: 'echo ready', cwd: '/repo' }, kind: 'shell_command', why: 'explicit command argument identifies execution' },
]

describe('OpenCode built-in and custom tool projections', () => {
  it.each(tools)('$tool: $why', async ({ tool, input, kind, target }) => {
    writeMessages([{ info: { finish: 'tool-calls' }, parts: [{ type: 'tool', tool, callID: 'call_1', state: { status: 'completed', input } }] }])
    const deps = { opencode: database }
    const timeline = await readAgentTranscriptFile({ path, projection: 'timeline' }, deps)
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) throw new Error(timeline.message)
    const expected: AgentTranscriptItem = kind === 'patch'
      ? { kind, timestamp: 100, files: ['a.ts'], summary: 'apply_patch: a.ts' }
      : kind === 'shell_command'
        ? { kind, timestamp: 100, command: input.command as string, ...(input.cwd ? { cwd: input.cwd as string } : {}) }
        : kind === 'tool_write'
          ? { kind, timestamp: 100, tool, target, summary: target ? `${tool}: ${target}` : tool }
          : { kind, timestamp: 100, tool, target, excerpt: target ? `${tool}: ${target}` : undefined }
    expect(timeline.items).toEqual([expected])
    for (const projection of ['file_changes', 'tool_writes', 'tool_reads', 'shell_commands'] as const) {
      const result = await readAgentTranscriptFile({ path, projection }, deps)
      const included = projection === 'tool_reads' ? kind === 'tool_read'
        : projection === 'shell_commands' ? kind === 'shell_command' : kind === 'tool_write' || kind === 'patch'
      expect(result.ok && result.items, projection).toEqual(included ? [expected] : [])
    }
    const inspect = await inspectAgentTranscriptFile({ path }, deps)
    expect(inspect).toMatchObject({ ok: true, stats: {
      totalEvents: 1, toolReads: kind === 'tool_read' ? 1 : 0, toolWrites: kind === 'tool_write' ? 1 : 0,
      shellCommands: kind === 'shell_command' ? 1 : 0, patches: kind === 'patch' ? 1 : 0,
    } })
  })
})
