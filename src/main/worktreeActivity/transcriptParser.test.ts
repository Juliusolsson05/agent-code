import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseTranscriptForActivity } from '@main/worktreeActivity/transcriptParser.js'
import type { TranscriptCandidate } from '@main/worktreeActivity/types.js'
import { asRecord } from '@shared/lib/asRecord.js'

const scratchDirectories: string[] = []

function recordedCodexRecords(): Array<Record<string, unknown>> {
  const path = resolve(
    process.cwd(),
    'testing/fixtures/worktree-context/codex-main-to-worktree.json',
  )
  const fixture = asRecord(JSON.parse(readFileSync(path, 'utf8')))
  if (!fixture || !Array.isArray(fixture.records)) {
    throw new Error('codex-main-to-worktree fixture has no records array')
  }
  return fixture.records as Array<Record<string, unknown>>
}

function transcriptCandidate(file: string): TranscriptCandidate {
  return {
    provider: 'codex',
    providerSessionId: 'recorded-codex-session',
    file,
    cwd: '',
    mtimeMs: Date.parse('2026-08-26T21:38:22.000Z'),
    size: 0,
  }
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('parseTranscriptForActivity recorded Codex contracts', () => {
  it('[codex-main-to-worktree] indexes the recorded command and both worktree writes', async () => {
    const records = recordedCodexRecords()
    const directory = mkdtempSync(join(tmpdir(), 'agent-code-work-context-'))
    scratchDirectories.push(directory)
    const file = join(directory, 'rollout.jsonl')

    // WHY write the fixture back as JSONL instead of calling the extractor
    // directly: the historical failure lives at the streaming transcript
    // boundary. This preserves the real record order/framing while keeping raw
    // provider transcripts outside Agent Code's derived index.
    writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)

    const indexed = await parseTranscriptForActivity(transcriptCandidate(file))
    const fileChange = asRecord(asRecord(asRecord(records[4].payload)?.item)?.changes)
    if (!fileChange) throw new Error('recorded FileChange lost its changes object')

    expect(indexed.cwd).toBe('/fixture/project-1')
    expect(indexed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'command',
        path: 'file:///fixture/project-1',
      }),
    ]))
    expect(
      indexed.events
        .filter(event => event.kind === 'file-write')
        .map(event => event.path),
    ).toEqual(Object.keys(fileChange))
  })
})
