import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // #1362: since code mode (0.144+), Codex runs shell commands and patches
  // through `custom_tool_call(name="exec")`, whose input is a JavaScript
  // program calling `tools.exec_command(...)` / `tools.apply_patch(...)`. The
  // reader only knew `function_call`, so a modern Codex child's timeline held
  // its messages and nothing it did. The fixture is a slice of a recorded
  // 0.157.1 rollout (see the fixture's README entry): one script per shape
  // the corpus census found.
  it('reads Codex code-mode scripts: commands, patches, other scripts, and their outputs', async () => {
    const path = jsonl('codex-0.157.jsonl', readFileSync(join(import.meta.dirname,
      '../../../testing/fixtures/agent-transcripts/codex-0.157-custom-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    const at = (iso: string) => Date.parse(iso)
    const worktree = '/Users/xxxxxxxxxxxx/Desktop/Development/agent-code/.worktrees/review-cxh55-b'
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { payload: { input?: string } })
    const computedScript = records[3]!.payload.input!
    const otherScript = records[2]!.payload.input!
    const result = await readAgentTranscriptFile({ path, projection: 'timeline' })
    expect(result).toMatchObject({ ok: true, provider: 'codex' })
    expect(result.ok && result.items.slice(2, -1)).toEqual([
      // A script that calls no command or patch still records that it ran.
      { kind: 'tool_read', timestamp: at('2026-09-27T00:26:39.779Z'), tool: 'exec', excerpt: otherScript },
      // A computed argument (`{cmd, ...}` over a mapped array) cannot be read
      // without running the script: the script itself is the command.
      { kind: 'shell_command', timestamp: at('2026-09-27T00:26:52.324Z'), command: computedScript, executed: 'unknown' },
      { kind: 'patch', timestamp: at('2026-09-27T00:27:16.483Z'), files: [`${worktree}/src/CodexHeadless.ts`], summary: `apply_patch: ${worktree}/src/CodexHeadless.ts`, executed: 'unknown' },
      // Two decodable calls in one script: two commands, in order.
      { kind: 'shell_command', timestamp: at('2026-09-27T00:27:26.627Z'), command: 'git checkout -- src/CodexHeadless.ts', cwd: worktree, executed: 'unknown' },
      { kind: 'shell_command', timestamp: at('2026-09-27T00:27:26.627Z'), command: "rg -n 'snapshotPlain\\(' src/terminal/HeadlessTerminal.ts", cwd: worktree, executed: 'unknown' },
      { kind: 'shell_command', timestamp: at('2026-09-27T00:30:39.279Z'), command: 'rm node_modules', cwd: worktree, executed: 'unknown' },
    ])
    const shell = await readAgentTranscriptFile({ path, projection: 'shell_commands' })
    expect(shell.ok && shell.items.map(item => item.kind === 'shell_command' && item.command)).toEqual([
      computedScript, 'git checkout -- src/CodexHeadless.ts', "rg -n 'snapshotPlain\\(' src/terminal/HeadlessTerminal.ts", 'rm node_modules',
    ])
    const outputs = await readAgentTranscriptFile({ path, projection: 'tool_reads', include: { rawToolOutputs: true } })
    expect(outputs.ok && outputs.items.filter(item => item.kind === 'tool_read' && item.tool === 'function_call_output').map(item => item.timestamp)).toEqual([
      at('2026-09-27T00:27:16.554Z'), at('2026-09-27T00:27:26.908Z'), at('2026-09-27T00:30:39.877Z'),
    ])
    // Every text block, in order: the transport header AND each command's
    // result (#1368 review c: keeping only the last part passed before).
    const twoCommandOutput = records[7]!.payload as unknown as { output: Array<{ text: string }> }
    expect(outputs.ok && outputs.items.find(item => item.timestamp === at('2026-09-27T00:27:26.908Z'))).toMatchObject({
      excerpt: twoCommandOutput.output.map(block => block.text).join('\n').trim(),
    })
    const inspect = await inspectAgentTranscriptFile({ path })
    expect(inspect).toMatchObject({ ok: true, stats: { shellCommands: 4, userMessages: 1, assistantMessages: 2 } })
  })

  // #1362: recorded custom-call forms the 0.157 slice does not hold.
  // - A template-literal patch argument cannot be decoded lexically, so its
  //   files come from the headers in the script text.
  // - The older top-level `apply_patch` custom call carries the patch as its
  //   whole input.
  // - #1368 review c: a patch whose TEXT quotes
  //   `tools.exec_command({"cmd":"rg …"})` (it edits a test fixture). A regex
  //   scan read that as a call and reported a command that never ran; the
  //   lexical scan skips string contents.
  // - A script calling only an MCP tool is recorded as a script, targeted at
  //   the tool it called.
  // - #1368 review a: two `apply_patch` calls with `${path}` headers around a
  //   real command. The path resolves through its `const path="…"` binding (it
  //   used to be reported as the literal `${path}`), and the two calls make
  //   ONE patch item.
  // - #1368 review a: four `exec_command` calls, two with template commands.
  //   One undecodable call makes the whole script ONE command, not four
  //   copies of it.
  it('reads the other recorded custom-call forms without inventing commands', async () => {
    const path = jsonl('codex-custom-call-forms.jsonl', readFileSync(join(import.meta.dirname,
      '../../../testing/fixtures/agent-transcripts/codex-custom-call-forms.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    const home = '/Users/xxxxxxxxxxxx/Desktop/Development/agent-code/.worktrees'
    const edited = `${home}/review-1326-c/src/renderer/src/workspace/hook/actions/session.ts`
    const quoting = [
      `${home}/feed-render-rewrite/testing/fixtures/feed-presentation/operation-families.json`,
      `${home}/feed-render-rewrite/testing/unit/scripts/renderingFixtureTools.test.ts`,
    ]
    const records = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { payload: { input: string } })
    const titles = `${home}/auto-agent-titles`
    const result = await readAgentTranscriptFile({ path, provider: 'codex', projection: 'timeline' })
    expect(result.ok && result.items).toEqual([
      { kind: 'patch', timestamp: Date.parse('2026-09-27T01:27:05.044Z'), files: [edited], summary: `apply_patch: ${edited}`, executed: 'unknown' },
      { kind: 'patch', timestamp: Date.parse('2026-05-19T07:15:19.499Z'), files: ['src/app/page.tsx'], summary: 'apply_patch: src/app/page.tsx' },
      { kind: 'patch', timestamp: Date.parse('2026-07-12T19:14:02.294Z'), files: quoting, summary: `apply_patch: ${quoting.join(', ')}`, executed: 'unknown' },
      {
        kind: 'tool_read',
        timestamp: Date.parse('2026-09-07T19:01:30.089Z'),
        tool: 'exec',
        target: 'mcp__agent_code__orchestration_wait_agents',
        excerpt: expect.stringContaining('tools.mcp__agent_code__orchestration_wait_agents('),
      },
      { kind: 'patch', timestamp: Date.parse('2026-09-25T04:28:55.297Z'), files: [`${titles}/src/mcp/runtime/BuiltInMcpHttpHost.ts`], summary: `apply_patch: ${titles}/src/mcp/runtime/BuiltInMcpHttpHost.ts`, executed: 'unknown' },
      { kind: 'shell_command', timestamp: Date.parse('2026-09-25T04:28:55.297Z'), command: "npx vitest run src/main/tldr/enforcement.system.test.ts -t 'keeps TLDR enforcement responsive'", cwd: titles, executed: 'unknown' },
      { kind: 'shell_command', timestamp: Date.parse('2026-09-27T00:23:21.087Z'), command: records[5]!.payload.input, executed: 'unknown' },
    ])
  })

  // Steering q86: a command read from script source is never presented as a
  // command that ran. A call inside a branch that never runs is still listed
  // (the reader does not execute scripts), and it is listed ONLY with the
  // `executed: 'unknown'` marker; so is every other script-derived entry.
  it('marks every command and patch read from script source as not proven to have run', async () => {
    const path = jsonl('codex-dead-branch.jsonl', [
      { type: 'response_item', timestamp: '2026-09-27T07:00:00.000Z', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'if (false) tools.exec_command({cmd:"echo never"}); text("done")' } },
      { type: 'response_item', timestamp: '2026-09-27T07:00:01.000Z', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'if (false) text(await tools.apply_patch("*** Begin Patch\\n*** Delete File: never.ts\\n*** End Patch"))' } },
    ])
    for (const projection of ['timeline', 'shell_commands', 'file_changes'] as const) {
      const result = await readAgentTranscriptFile({ path, provider: 'codex', projection })
      expect(result.ok && result.items.length).toBeGreaterThan(0)
      for (const item of result.ok ? result.items : []) {
        expect(item).toMatchObject({ executed: 'unknown' })
      }
    }
    const shell = await readAgentTranscriptFile({ path, provider: 'codex', projection: 'shell_commands' })
    expect(shell.ok && shell.items).toEqual([
      { kind: 'shell_command', timestamp: Date.parse('2026-09-27T07:00:00.000Z'), command: 'echo never', executed: 'unknown' },
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
