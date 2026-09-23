import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { loadLiveFixture, referenceActiveBranch, toJsonl } from 'pi-terminal-headless/testing/index'

import { loadPiHistoryChunk } from './piHistory.js'

// Pi history for the app's history loader, over a recorded session file that
// holds an abandoned branch (the `tree` recording: two /tree moves). The
// expected rows come from the independent reference walk — the branch pi
// itself would load — never from the loader.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function treeFile(): { file: string; branch: string[]; all: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-history-app-'))
  dirs.push(dir)
  const rows = Object.values(loadLiveFixture('tree').files)[0]!
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, toJsonl(rows))
  return { file, branch: referenceActiveBranch(rows).map(row => row.id as string), all: rows.slice(1).map(row => row.id as string) }
}

const request = (extra: Partial<{ limit: number; beforeMarker: string }> = {}) => ({ cwd: '/w', providerSessionId: 'sid', limit: 3, ...extra })

describe('loadPiHistoryChunk', () => {
  it('pages the active branch newest-first by entry id, and never returns an abandoned turn', async () => {
    const { file, branch, all } = treeFile()
    expect(all.length).toBeGreaterThan(branch.length) // the recording really has abandoned rows
    const resolveFile = async () => file
    const seen: string[][] = []
    let chunk = await loadPiHistoryChunk(request(), { resolveFile })
    expect(chunk.totalEntries).toBe(branch.length)
    seen.unshift(chunk.entries.map(entry => entry.id as string))
    while (chunk.hasMore) {
      expect(chunk.oldestMarker).toBe(seen[0]![0])
      chunk = await loadPiHistoryChunk(request({ beforeMarker: chunk.oldestMarker! }), { resolveFile })
      expect(chunk.totalEntries).toBeUndefined() // counts belong to initial hydration
      seen.unshift(chunk.entries.map(entry => entry.id as string))
    }
    expect(seen.flat()).toEqual(branch)
  })

  it('a session pi has not written yet is empty history, not an error (the file appears after the first reply)', async () => {
    await expect(loadPiHistoryChunk(request(), { resolveFile: async () => null })).resolves.toEqual({ entries: [], hasMore: false, totalEntries: 0 })
  })

  it('a file that is not a Pi session throws, with the category in the message (Electron drops Error properties)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-history-app-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'x.jsonl'), '{"not":"pi"}\n')
    await expect(loadPiHistoryChunk(request(), { resolveFile: async () => join(dir, 'x.jsonl') })).rejects.toThrow(/^not_a_session: /)
  })
})
