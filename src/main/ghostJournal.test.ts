import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GhostEntry } from 'agent-transcript-parser/ghost'
import { describe, expect, it } from 'vitest'

import { GhostJournal } from './ghostJournal'

function ghost(uuid: string, updatedAt: number, text: string): GhostEntry {
  // The writer intentionally treats GhostEntry as opaque JSON. This minimal
  // shape keeps the test about journal coalescing instead of coupling it to
  // agent-transcript-parser's ghost construction policy, which has its own
  // package-level coverage.
  return {
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    _atp: { updatedAt },
  } as unknown as GhostEntry
}

describe('GhostJournal pending snapshot coalescing', () => {
  it('writes only the latest snapshot for each uuid in a flush window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-ghost-journal-'))
    const path = join(dir, 'session.ghost.jsonl')
    const journal = new GhostJournal(path)

    journal.append(ghost('g1', 1, 'a'))
    journal.append(ghost('g2', 2, 'independent'))
    journal.append(ghost('g1', 3, 'abc'))
    await journal.flush()

    const lines = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as GhostEntry)
    expect(lines).toHaveLength(2)
    expect(lines.find(item => item.uuid === 'g1')?._atp.updatedAt).toBe(3)
    expect(lines.find(item => item.uuid === 'g2')?._atp.updatedAt).toBe(2)
  })

  it('still appends a later snapshot after the prior window is durable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-ghost-journal-'))
    const path = join(dir, 'session.ghost.jsonl')
    const journal = new GhostJournal(path)

    journal.append(ghost('g1', 1, 'a'))
    await journal.flush()
    journal.append(ghost('g1', 2, 'ab'))
    await journal.flush()

    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2)
  })
})
