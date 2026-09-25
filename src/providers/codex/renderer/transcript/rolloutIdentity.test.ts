import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { admitMappedEntries, type CommittedSeenLedger } from '@renderer/session-runtime/ingest/committedRecords'
import { createCodexTranscriptEntryMapper } from './mapper'

// #1288: the recorded same-millisecond shapes (minimal, redacted). Before the
// shared identity, the second item of each pair mapped to the first's uuid
// and admission dropped it for good: a tool card with no result, a message
// that never rendered.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../../../testing/fixtures/codex-identity/same-millisecond-2026-04.json'), 'utf8')) as {
  callAndOutput: Record<string, unknown>[]
  messages: Record<string, unknown>[]
}

function ledger(): CommittedSeenLedger {
  return { seen: new Set(), isTrimmed: () => false, releaseTrimmed: () => {} }
}

function admitAll(lines: Record<string, unknown>[], seen = ledger()) {
  const mapper = createCodexTranscriptEntryMapper()
  return lines.flatMap(line => {
    const { entries, historyMarker } = mapper.map(line)
    return admitMappedEntries(entries, historyMarker, 'live', seen).admitted
  })
}

describe('Codex rollout identity (#1288)', () => {
  it('admits a tool call and its output that share a millisecond', () => {
    const admitted = admitAll(fixture.callAndOutput)
    const blocks = admitted.flatMap(entry => (entry as { message?: { content?: Array<{ type: string }> } }).message?.content ?? [])
    expect(blocks.map(block => block.type)).toEqual(expect.arrayContaining(['tool_use', 'tool_result']))
  })

  it('admits two different messages that share a millisecond', () => {
    expect(admitAll(fixture.messages)).toHaveLength(2)
  })

  it('still dedupes the same line read twice (a chunk overlap)', () => {
    const seen = ledger()
    const first = admitAll(fixture.messages, seen)
    const again = admitAll(fixture.messages, seen)
    expect(first).toHaveLength(2)
    expect(again).toHaveLength(0)
  })

  it('gives a line without a timestamp the same identity on every read', async () => {
    const [line] = fixture.messages
    const { timestamp: _dropped, ...untimed } = line!
    const uuidOf = () => (createCodexTranscriptEntryMapper().map(untimed).entries[0] as { uuid?: string } | undefined)?.uuid
    const a = uuidOf()
    await new Promise(resolve => setTimeout(resolve, 2))
    expect(a).toBeDefined()
    expect(uuidOf()).toBe(a)
  })
})
