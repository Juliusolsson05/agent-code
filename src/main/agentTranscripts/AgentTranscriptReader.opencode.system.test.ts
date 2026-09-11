import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectionDatabase,
  listDurableFixtures,
  LiveFixtureWriter,
  loadDurableFixture,
  sessionRowFor,
} from 'opencode-terminal-headless/testing/index'

import { createOpencodeDatabase, type OpencodeDatabase } from '@providers/opencode/runtime/opencodeDatabase.js'
import type { AgentTranscriptItem, AgentTranscriptStats } from '@mcp/shared/agentTranscriptTypes.js'

import {
  inspectAgentTranscriptFile,
  readAgentTranscriptFile,
  searchAgentTranscriptFile,
  type AgentTranscriptReaderDeps,
} from './AgentTranscriptReader.js'

// The agent transcript MCP tools reading OpenCode sessions through their
// `opencode://session/<id>` locator, from real SQLite files with OpenCode's
// own schema.
//
// Two kinds of evidence:
// - A hand-written session whose content is known, written through the same
//   projector path OpenCode uses, so each expectation below is a statement
//   about what a parent agent should see.
// - Every recorded session in opencode-terminal-headless's fixtures, whose
//   text is sanitized, checked against counts taken straight from the raw
//   rows — never from the reader.
// The literal corpus counts protect recorded traversal/completeness. The full
// registry/custom-tool matrix in AgentTranscriptReader.opencode.contracts.system.test.ts
// independently covers tool semantics absent from these recordings.

let dir: string
let databases: OpencodeDatabase[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-transcript-reader-'))
  databases = []
})
afterEach(() => {
  for (const database of databases) database.release()
  rmSync(dir, { recursive: true, force: true })
})

function depsFor(file: string): AgentTranscriptReaderDeps {
  const database = createOpencodeDatabase({ resolveDbPath: async () => file })
  databases.push(database)
  return { opencode: database }
}

const SESSION = 'ses_reader_known'
const locator = (sessionID: string) => `opencode://session/${sessionID}`

// One turn: the user asks, the agent reads, runs the tests, updates its todo
// list, edits, applies a patch (one applied, one rejected before applying),
// answers, and has a fifth step still streaming.
function writeKnownSession(file: string): void {
  const writer = new LiveFixtureWriter(file, SESSION, sessionRowFor(SESSION))
  const message = (info: Record<string, unknown>) =>
    writer.apply('message.updated.1', { sessionID: SESSION, info: { sessionID: SESSION, ...info } })
  const part = (messageID: string, id: string, fields: Record<string, unknown>) =>
    writer.apply('message.part.updated.1', { sessionID: SESSION, part: { id, messageID, sessionID: SESSION, ...fields } })
  const tool = (messageID: string, id: string, name: string, state: Record<string, unknown>) =>
    part(messageID, id, { type: 'tool', tool: name, callID: `call_${id}`, state: { status: 'completed', ...state } })

  message({ id: 'msg_01_user', role: 'user', time: { created: 1_000 } })
  part('msg_01_user', 'prt_01a', { type: 'text', text: 'Fix the failing parser test' })
  part('msg_01_user', 'prt_01b', { type: 'text', text: 'You are in plan mode. Do not edit files.', synthetic: true })

  message({ id: 'msg_02_step', role: 'assistant', parentID: 'msg_01_user', time: { created: 2_000, completed: 2_900 }, finish: 'tool-calls' })
  part('msg_02_step', 'prt_02a', { type: 'reasoning', text: 'The parser probably trips on empty input.' })
  part('msg_02_step', 'prt_02b', { type: 'text', text: 'Looking at the parser first.' })
  tool('msg_02_step', 'prt_02c', 'read', { input: { filePath: '/repo/src/parser.ts' }, output: 'export function parse(input) {', time: { start: 2_100, end: 2_150 } })
  tool('msg_02_step', 'prt_02d', 'bash', { input: { command: 'npm test -- parser', workdir: '/repo' }, metadata: { exit: 1 }, output: '1 failing', time: { start: 2_200, end: 2_600 } })
  tool('msg_02_step', 'prt_02e', 'todowrite', { input: { todos: [{ content: 'Handle empty input', status: 'in_progress' }] }, output: '1 todo', time: { start: 2_700, end: 2_710 } })

  message({ id: 'msg_03_step', role: 'assistant', parentID: 'msg_01_user', time: { created: 3_000, completed: 3_900 }, finish: 'tool-calls' })
  tool('msg_03_step', 'prt_03a', 'edit', { input: { filePath: '/repo/src/parser.ts', oldString: 'parse(input)', newString: 'parse(input = "")' }, output: 'Edit applied', time: { start: 3_100, end: 3_150 } })
  tool('msg_03_step', 'prt_03b', 'apply_patch', {
    input: { patchText: '*** Begin Patch\n*** Add File: src/empty.ts\n+export {}\n*** End Patch' },
    metadata: { files: [{ filePath: '/repo/src/empty.ts', relativePath: 'src/empty.ts', type: 'add' }] },
    output: 'Success',
    time: { start: 3_200, end: 3_250 },
  })
  tool('msg_03_step', 'prt_03c', 'apply_patch', {
    status: 'error',
    input: { patchText: '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/renamed.ts\n@@\n-a\n+b\n*** End Patch' },
    error: 'patch did not apply',
    time: { start: 3_300, end: 3_320 },
  })
  part('msg_03_step', 'prt_03d', { type: 'patch', hash: 'abc123', files: ['/repo/src/parser.ts', '/repo/src/empty.ts'] })

  message({ id: 'msg_04_answer', role: 'assistant', parentID: 'msg_01_user', time: { created: 4_000, completed: 4_500 }, finish: 'stop' })
  part('msg_04_answer', 'prt_04a', { type: 'text', text: 'Fixed: the parser now handles empty input.' })

  message({ id: 'msg_05_streaming', role: 'assistant', parentID: 'msg_01_user', time: { created: 5_000 } })
  part('msg_05_streaming', 'prt_05a', { type: 'text', text: 'And one more thi' })
  writer.close()
}

function knownSession(): { path: string; deps: AgentTranscriptReaderDeps } {
  const file = join(dir, 'opencode.db')
  writeKnownSession(file)
  return { path: locator(SESSION), deps: depsFor(file) }
}

describe('agent transcript tools on an OpenCode session', () => {
  it('reads the conversation, the tool calls by name and target, and leaves out what OpenCode inserted', async () => {
    const { path, deps } = knownSession()
    const result = await readAgentTranscriptFile({ path, projection: 'timeline', maxItems: 1000 }, deps)
    expect(result).toMatchObject({ ok: true, provider: 'opencode', path })
    if (!result.ok) return
    expect(result.items).toEqual<AgentTranscriptItem[]>([
      { kind: 'user_message', timestamp: 1_000, text: 'Fix the failing parser test' },
      { kind: 'assistant_message', timestamp: 2_000, text: 'Looking at the parser first.', final: false },
      { kind: 'tool_read', timestamp: 2_100, tool: 'read', target: '/repo/src/parser.ts', excerpt: 'read: /repo/src/parser.ts' },
      { kind: 'shell_command', timestamp: 2_200, command: 'npm test -- parser', cwd: '/repo', exitCode: 1 },
      // todowrite writes the session's todo list, not a file.
      { kind: 'tool_read', timestamp: 2_700, tool: 'todowrite', target: undefined, excerpt: undefined },
      { kind: 'tool_write', timestamp: 3_100, tool: 'edit', target: '/repo/src/parser.ts', summary: 'edit: /repo/src/parser.ts' },
      { kind: 'patch', timestamp: 3_200, files: ['/repo/src/empty.ts'], summary: 'apply_patch: /repo/src/empty.ts' },
      // Rejected before applying: no reported files, so they come from the patch text.
      { kind: 'patch', timestamp: 3_300, files: ['src/old.ts', 'src/renamed.ts'], summary: 'apply_patch: src/old.ts, src/renamed.ts' },
      { kind: 'patch', timestamp: 3_000, files: ['/repo/src/parser.ts', '/repo/src/empty.ts'], summary: '2 files changed in this step' },
      { kind: 'assistant_message', timestamp: 4_000, text: 'Fixed: the parser now handles empty input.', final: true },
    ])
    // Every message is an event; the still-streaming step contributes none.
    expect(result.stats).toMatchObject({ totalEvents: 5, userMessages: 1, assistantMessages: 2, shellCommands: 1, toolWrites: 1, patches: 3 })
    // Tool outputs are counted but hidden by default.
    expect(result.stats.toolReads).toBe(2 + 6)
  })

  it('answers the final projection with the turn\'s answer, not the step that ran tools', async () => {
    const { path, deps } = knownSession()
    const result = await readAgentTranscriptFile({ path, projection: 'final' }, deps)
    expect(result.ok && result.items).toEqual([
      { kind: 'assistant_message', timestamp: 4_000, text: 'Fixed: the parser now handles empty input.', final: true },
    ])
  })

  it('lists file changes and shell commands, and returns tool outputs only when asked', async () => {
    const { path, deps } = knownSession()
    const changes = await readAgentTranscriptFile({ path, projection: 'file_changes' }, deps)
    expect(changes.ok && changes.items.map(item => item.kind)).toEqual(['tool_write', 'patch', 'patch', 'patch'])

    const shell = await readAgentTranscriptFile({ path, projection: 'shell_commands' }, deps)
    expect(shell.ok && shell.items).toEqual([{ kind: 'shell_command', timestamp: 2_200, command: 'npm test -- parser', cwd: '/repo', exitCode: 1 }])

    const withOutputs = await readAgentTranscriptFile({ path, projection: 'tool_reads', include: { rawToolOutputs: true } }, deps)
    const outputs = withOutputs.ok ? withOutputs.items.filter(item => item.kind === 'tool_read' && item.tool === 'function_call_output') : []
    expect(outputs.map(item => item.kind === 'tool_read' && item.excerpt)).toEqual([
      'export function parse(input) {',
      '1 failing',
      '1 todo',
      'Edit applied',
      'Success',
      'patch did not apply',
    ])
  })

  it('searches with surrounding context and inspects without returning content', async () => {
    const { path, deps } = knownSession()
    const search = await searchAgentTranscriptFile({ path, query: 'EMPTY INPUT' }, deps)
    expect(search.ok && search.matches.map(match => match.item)).toEqual([
      { kind: 'assistant_message', timestamp: 4_000, text: 'Fixed: the parser now handles empty input.', final: true },
    ])
    expect(search.ok && search.matches[0]!.before?.map(item => item.kind)).toEqual(['patch'])

    const inspect = await inspectAgentTranscriptFile({ path }, deps)
    expect(inspect).toMatchObject({ ok: true, provider: 'opencode', firstTimestamp: 1_000, lastTimestamp: 5_000 })
    expect(inspect.ok && inspect.stats).toMatchObject({ totalEvents: 5, userMessages: 1, assistantMessages: 2, patches: 3 })
  })

  it('lets the main process run other work while it reads a long session', async () => {
    const file = join(dir, 'long.db')
    const writer = new LiveFixtureWriter(file, 'ses_long', sessionRowFor('ses_long'))
    for (let index = 0; index < 300; index += 1) {
      const id = `msg_${String(index).padStart(4, '0')}`
      writer.apply('message.updated.1', { sessionID: 'ses_long', info: { id, sessionID: 'ses_long', role: 'user', time: { created: 1_000 + index } } })
      writer.apply('message.part.updated.1', { sessionID: 'ses_long', part: { id: `prt_${index}`, messageID: id, sessionID: 'ses_long', type: 'text', text: `prompt ${index}` } })
    }
    writer.close()
    // Stand-in for everything else the main process does (PTY forwarding,
    // IPC): a chain of macrotasks that only advances when the read yields.
    let turns = 0
    let running = true
    const other = () => {
      turns += 1
      if (running) setImmediate(other)
    }
    setImmediate(other)
    try {
      const result = await inspectAgentTranscriptFile({ path: locator('ses_long') }, depsFor(file))
      expect(result).toMatchObject({ ok: true, stats: { totalEvents: 300, userMessages: 300 } })
      // One pause per page of 25 messages.
      expect(turns).toBeGreaterThanOrEqual(10)
    } finally {
      running = false
    }
  })

  it('refuses honestly: an unknown session, no database, and a provider that does not match the locator', async () => {
    const { deps } = knownSession()
    await expect(readAgentTranscriptFile({ path: locator('ses_nobody'), projection: 'final' }, deps))
      .resolves.toMatchObject({ ok: false, error: 'file_not_found' })
    await expect(readAgentTranscriptFile({ path: locator(SESSION), provider: 'claude', projection: 'final' }, deps))
      .resolves.toMatchObject({ ok: false, error: 'unsupported_provider' })

    const missing = depsFor(join(dir, 'absent.db'))
    await expect(inspectAgentTranscriptFile({ path: locator(SESSION) }, missing))
      .resolves.toMatchObject({ ok: false, error: 'file_not_readable' })

    // And the other way round: OpenCode has no transcript files.
    const jsonl = join(dir, 'claude.jsonl')
    writeFileSync(jsonl, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } })}\n`)
    await expect(readAgentTranscriptFile({ path: jsonl, provider: 'opencode', projection: 'final' }, deps))
      .resolves.toMatchObject({ ok: false, error: 'unsupported_provider' })
  })
})

// Literal census of the fixture rows, not a second extractor. The previous
// expectedCounts walked the same role/tool rules as production and could
// silently bless the same classification mistake. These fixtures need an
// explicit review when changed, while the independent registry matrix covers
// tool ids that recordings happen not to exercise.
//
// 5a9e: 128 messages; 9 user messages carry 12 real text parts (4 synthetic
// parts are excluded), 82 assistants carry text; 61 bash, 12 edit + 8 write,
// 44 other tool calls, 125 outputs/errors, and one snapshot. Its five custom
// exec calls have only a `value` argument, so no shell command is established.
// a6fa: two spoken assistant steps PLUS msg_070bb9da5001uZF628C7gPXXhS's
// MessageAbortedError (no text). Dropping that third item hides the abort.
const expectedCounts: Record<string, Partial<AgentTranscriptStats>> = {
  ses_47fca639e3f6415791277e7c065a18ff: { totalEvents: 3, userMessages: 1, assistantMessages: 1, shellCommands: 1, toolWrites: 0, patches: 0, toolReads: 1 },
  ses_5a9eb7438b655a5a8b1453adf276083c: { totalEvents: 128, userMessages: 9, assistantMessages: 82, shellCommands: 61, toolWrites: 20, patches: 1, toolReads: 169 },
  ses_7d808f8696294ec782dd6fd02f6c07ac: { totalEvents: 4, userMessages: 2, assistantMessages: 2, shellCommands: 0, toolWrites: 0, patches: 0, toolReads: 0 },
  ses_a6fac9228f234c60a7148d82f27e34c2: { totalEvents: 4, userMessages: 1, assistantMessages: 3, shellCommands: 1, toolWrites: 0, patches: 0, toolReads: 9 },
  ses_f95eaec8cffe9MjQ00EGdkBV6a: { totalEvents: 22, userMessages: 5, assistantMessages: 15, shellCommands: 13, toolWrites: 0, patches: 0, toolReads: 45 },
  ses_f963831c3ffeoUTd1qcWlr0Qrb: { totalEvents: 17, userMessages: 1, assistantMessages: 13, shellCommands: 15, toolWrites: 0, patches: 0, toolReads: 29 },
  ses_f96bdb539ffe2Q22Yzk6zhDUYI: { totalEvents: 6, userMessages: 1, assistantMessages: 3, shellCommands: 0, toolWrites: 0, patches: 0, toolReads: 14 },
}

describe('agent transcript tools on recorded OpenCode sessions', () => {
  it('sees every message, tool call and output the database holds, across page boundaries', async () => {
    const fixtures = listDurableFixtures().map(loadDurableFixture)
    // One shared database, as on a real machine: sessions must not bleed
    // into each other's reads.
    const file = join(dir, 'opencode.db')
    createProjectionDatabase(fixtures, file)
    const deps = depsFor(file)
    for (const fixture of fixtures) {
      const result = await inspectAgentTranscriptFile({ path: locator(fixture.meta.sessionID) }, deps)
      expect(result, fixture.meta.sessionID).toMatchObject({ ok: true, provider: 'opencode' })
      if (!result.ok) throw new Error(result.message)
      expect(expectedCounts[fixture.meta.sessionID], fixture.meta.sessionID).toBeDefined()
      expect(result.stats, fixture.meta.sessionID).toMatchObject(expectedCounts[fixture.meta.sessionID]!)
    }
    // The compaction session is longer than one read page (100 messages).
    expect(fixtures.some(fixture => fixture.messages.length > 100)).toBe(true)
  })
})
