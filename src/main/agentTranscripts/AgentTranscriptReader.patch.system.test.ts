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
const sessionID = 'ses_patch_caps'
const path = `opencode://session/${sessionID}`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reader-patches-'))
  const file = join(dir, 'opencode.db')
  database = createOpencodeDatabase({ resolveDbPath: async () => file })
  const writer = new LiveFixtureWriter(file, sessionID, sessionRowFor(sessionID))
  try {
    // Hand-specified counts and fixed-width paths make the exact boundary
    // calculable independently: eight 9-char paths + eight newlines + a
    // 19-char omission marker = 99. No extractor decides these expectations.
    const parts = [
      { type: 'patch', files: Array.from({ length: 300 }, (_, i) => `/s/${String(i).padStart(3, '0')}.ts`) },
      { type: 'text', text: 'needle' },
      { type: 'tool', tool: 'apply_patch', callID: 'call_patch', state: {
        status: 'completed', input: {}, metadata: {
          files: Array.from({ length: 400 }, (_, i) => ({ filePath: `/a/${String(i).padStart(3, '0')}.ts` })),
        },
      } },
    ]
    parts.forEach((part, i) => {
      const id = `msg_${i}`
      writer.apply('message.updated.1', { sessionID, info: { id, sessionID, role: 'assistant', time: { created: 100 + i, completed: 200 + i }, finish: 'tool-calls' } })
      writer.apply('message.part.updated.1', { sessionID, part: { id: `prt_${i}`, messageID: id, sessionID, ...part } })
    })
  } finally {
    writer.close()
  }
})
afterEach(() => {
  database.release()
  rmSync(dir, { recursive: true, force: true })
})

const snapshot: AgentTranscriptItem = {
  kind: 'patch', timestamp: 100,
  files: ['/s/000.ts', '/s/001.ts', '/s/002.ts', '/s/003.ts', '/s/004.ts', '/s/005.ts', '/s/006.ts', '/s/007.ts'],
  summary: '…and 292 more files',
}
const applied: AgentTranscriptItem = {
  kind: 'patch', timestamp: 102,
  files: ['/a/000.ts', '/a/001.ts', '/a/002.ts', '/a/003.ts', '/a/004.ts', '/a/005.ts', '/a/006.ts', '/a/007.ts'],
  summary: '…and 392 more files',
}
const stats = { totalEvents: 3, assistantMessages: 1, patches: 2, parseErrors: 0 }

function patchChars(item: AgentTranscriptItem): number {
  if (item.kind !== 'patch') throw new Error('Expected a patch')
  // The API's character budget measures displayed/searchable content, not
  // JSON property names. Count every filename and every separator as well as
  // the summary; checking only summary length was the original blind spot.
  return [...item.files, item.summary].filter(Boolean).join('\n').length
}

describe('complete patch representations share one character budget', () => {
  it('bounds both a 300-file snapshot and a 400-file apply_patch without losing their counts', async () => {
    const result = await readAgentTranscriptFile({ path, projection: 'file_changes', maxCharsPerItem: 100, maxChars: 198 }, { opencode: database })
    expect(result).toMatchObject({ ok: true, truncated: false, stats: { ...stats, returnedItems: 2 } })
    expect(result.ok && result.items).toEqual([snapshot, applied])
    expect(result.ok && result.items.map(patchChars)).toEqual([99, 99])
    await expect(inspectAgentTranscriptFile({ path }, { opencode: database })).resolves.toMatchObject({ ok: true, stats })
  })

  it('honors exact total and item caps while keeping full-session statistics', async () => {
    for (const bounds of [{ maxChars: 197 }, { maxChars: 198, maxItems: 1 }]) {
      const result = await readAgentTranscriptFile({ path, projection: 'file_changes', maxCharsPerItem: 100, ...bounds }, { opencode: database })
      expect(result).toMatchObject({ ok: true, truncated: true, stats: { ...stats, returnedItems: 1 } })
      expect(result.ok && result.items).toEqual([snapshot])
    }
  })

  it('keeps omission counts through tail eviction and a second bounding pass', async () => {
    const result = await readAgentTranscriptFile({ path, projection: 'file_changes', tail: 1, maxCharsPerItem: 100, maxChars: 100 }, { opencode: database })
    expect(result).toMatchObject({ ok: true, truncated: true, stats: { ...stats, returnedItems: 1 } })
    expect(result.ok && result.items).toEqual([applied])
  })

  it('bounds match items and before/after context but searches the full list', async () => {
    const deps = { opencode: database }
    const before = { kind: 'patch', timestamp: 100, files: ['/s/000.ts', '/s/001.ts', '/s/002.ts'], summary: '…and 297 more files' }
    const after = { kind: 'patch', timestamp: 102, files: ['/a/000.ts', '/a/001.ts', '/a/002.ts'], summary: '…and 397 more files' }
    const context = await searchAgentTranscriptFile({ path, query: 'needle', contextItems: 1, maxCharsPerMatch: 50 }, deps)
    expect(context).toMatchObject({ ok: true, truncated: false, stats })
    expect(context.ok && context.matches).toEqual([{
      item: { kind: 'assistant_message', timestamp: 101, text: 'needle', final: false }, before: [before], after: [after],
    }])
    const matches = await searchAgentTranscriptFile({ path, query: '.ts', kinds: ['patch'], contextItems: 0, maxMatches: 1, maxCharsPerMatch: 50 }, deps)
    expect(matches).toMatchObject({ ok: true, truncated: true, stats: { ...stats, returnedItems: 1 } })
    expect(matches.ok && matches.matches.map(match => match.item)).toEqual([before])
    const lastFile = await searchAgentTranscriptFile({ path, query: '/a/399.ts', contextItems: 0, maxCharsPerMatch: 50 }, deps)
    expect(lastFile.ok && lastFile.matches.map(match => match.item)).toEqual([after])
    expect(lastFile.ok && patchChars(lastFile.matches[0]!.item)).toBe(49)
  })
})
