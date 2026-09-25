import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadLiveFixture, referenceActiveBranch, toJsonl, type RecordedRow } from 'pi-terminal-headless/testing/index'

import { inspectAgentTranscriptFile, readAgentTranscriptFile, searchAgentTranscriptFile } from './AgentTranscriptReader.js'

// The agent transcript MCP tools reading Pi session files — the path a parent
// agent passes to agent_transcript_read_file for a Pi child. Every file is a
// Stage 0 recording of the real pi 0.87.1; expectations are counted from the
// recorded rows on the ACTIVE BRANCH (the independent reference walk), never
// from the reader.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function materialize(scenario: string, index = 0): { file: string; rows: RecordedRow[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-transcript-reader-'))
  dirs.push(dir)
  const rows = Object.values(loadLiveFixture(scenario).files)[index]!
  const file = join(dir, `${scenario}.jsonl`)
  writeFileSync(file, toJsonl(rows))
  return { file, rows }
}

function textOf(row: RecordedRow): string {
  const content = (row.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(b => (b as { type?: string }).type === 'text').map(b => (b as { text: string }).text).join('\n') : ''
}

const role = (row: RecordedRow) => (row.type === 'message' ? (row.message as { role: string }).role : null)

describe('Pi session files through the agent transcript tools', () => {
  it('auto-detects Pi from its header and reads the conversation of the active branch only', async () => {
    const { file, rows } = materialize('tree')
    const branch = referenceActiveBranch(rows)
    const result = await readAgentTranscriptFile({ path: file, projection: 'conversation' })
    if (!result.ok) throw new Error(result.message)
    expect(result.provider).toBe('pi')
    const expectedUsers = branch.filter(row => role(row) === 'user').map(textOf)
    expect(result.items.filter(item => item.kind === 'user_message').map(item => (item as { text: string }).text)).toEqual(expectedUsers)
    // The abandoned turns really exist in the file, and never reach the reader.
    const abandonedText = rows.filter(row => role(row) === 'user' && !branch.some(b => b.id === row.id)).map(textOf)
    expect(abandonedText.length).toBeGreaterThan(0)
    for (const text of abandonedText) {
      expect(result.items.some(item => 'text' in item && item.text === text)).toBe(false)
    }
  })

  it('a tool run: the bash call is a shell command and its output a raw tool output; the last reply is final', async () => {
    const { file } = materialize('tool')
    const result = await readAgentTranscriptFile({ path: file, provider: 'pi', projection: 'timeline', include: { rawToolOutputs: true } })
    if (!result.ok) throw new Error(result.message)
    expect(result.items.filter(item => item.kind === 'shell_command').map(item => (item as { command: string }).command)).toEqual(['echo probe-tool-output', 'echo probe-tool-output'])
    const final = await readAgentTranscriptFile({ path: file, provider: 'pi', projection: 'final' })
    if (!final.ok) throw new Error(final.message)
    expect(final.items.at(-1)).toMatchObject({ kind: 'assistant_message', text: 'Tool finished. Done.', final: true })
  })

  it('an aborted or errored reply is never reported as a finished answer, and says why first', async () => {
    const { file } = materialize('abort')
    const result = await readAgentTranscriptFile({ path: file, provider: 'pi', projection: 'assistant_messages' })
    if (!result.ok) throw new Error(result.message)
    const aborted = result.items.filter(item => item.kind === 'assistant_message' && (item as { text: string }).text.startsWith('[Pi aborted: Operation aborted]'))
    expect(aborted).toHaveLength(2)
    for (const item of aborted) expect((item as { final?: boolean }).final).toBe(false)
    const errored = await readAgentTranscriptFile({ path: materialize('error').file, provider: 'pi', projection: 'assistant_messages' })
    if (!errored.ok) throw new Error(errored.message)
    expect(errored.items[0]).toMatchObject({ kind: 'assistant_message', text: '[Pi error: probe: simulated provider error]', final: false })
  })

  it('search and inspect see the same branch, with timestamps from the rows', async () => {
    const { file, rows } = materialize('compaction')
    const search = await searchAgentTranscriptFile({ path: file, query: '[probe:c4]' } as never)
    if (!search.ok) throw new Error(search.message)
    expect(search.provider).toBe('pi')
    expect(search.matches.length).toBeGreaterThan(0)
    const inspect = await inspectAgentTranscriptFile({ path: file } as never)
    if (!inspect.ok) throw new Error(inspect.message)
    // Every record counts, like for other providers: a message's own epoch-ms
    // timestamp, else the row's ISO timestamp (model_change at session start
    // predates the first message).
    const stamps = referenceActiveBranch(rows).map(row =>
      row.type === 'message' ? (row.message as { timestamp: number }).timestamp : Date.parse(row.timestamp as string))
    expect(inspect.firstTimestamp).toBe(Math.min(...stamps))
    expect(inspect.lastTimestamp).toBe(Math.max(...stamps))
  })

  it('the user’s own !bash command is reported as a shell command', async () => {
    const { file } = materialize('user-bash')
    const result = await readAgentTranscriptFile({ path: file, provider: 'pi', projection: 'shell_commands' })
    if (!result.ok) throw new Error(result.message)
    expect(result.items.map(item => (item as { command?: string }).command)).toEqual(['echo from-user-bash'])
  })
})
