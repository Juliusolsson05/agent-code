import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  collectSessionIds,
  parseWorkspaceFile,
  serializeWorkspaceFile,
  withoutWindow,
  withSidekicks,
  withWindowSlice,
} from '@main/storage/workspaceFile.js'
import type { WorkspaceFile } from '@main/storage/workspaceFile.js'

// The Sidekick index rides in workspace.json beside the window slices (#1493,
// plan §3). The failure this file exists for is silent and destroys data:
// every window composer used to rebuild the document as `{version, windows}`,
// so the first ordinary window save after a sidekick was created would erase
// the whole index — and nothing in any window slice refers to a sidekick, so
// nothing would ever notice.
//
// Fixtures are a real 2026-10-14 capture and a documented mechanical mutation
// of it (testing/fixtures/workspace-v3/README.md).

const FIXTURES = join(process.cwd(), 'testing/fixtures/workspace-v3')
const withSidekicksText = readFileSync(join(FIXTURES, '2026-10-14-live-workspace-with-sidekicks.mutated.json'), 'utf8')
const plainText = readFileSync(join(FIXTURES, '2026-10-14-live-workspace-with-hermes.sanitized.json'), 'utf8')

function okFile(text: string): WorkspaceFile {
  const parsed = parseWorkspaceFile(text, () => 'minted-window')
  if (parsed.kind !== 'ok') throw new Error(`expected a readable file, got: ${parsed.reason}`)
  return parsed.file
}

const geometry = { bounds: null, displayId: null, fullScreen: false }

describe('workspace.json sidekicks section', () => {
  it('reads the section with both real-derived records intact', () => {
    const file = okFile(withSidekicksText)
    expect(file.sidekicks?.records.map(record => record.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ])
    // The Hermes record keeps its connection: a restore must reopen the same server.
    const hermes = file.sidekicks!.records[1]!.meta as Record<string, unknown>
    expect(hermes.kind).toBe('hermes')
    expect(typeof hermes.remoteConnectionId).toBe('string')
  })

  it('survives a window save, a geometry-only update and a window removal', () => {
    const file = okFile(withSidekicksText)
    const windowId = file.windows[0]!.windowId
    const original = JSON.stringify(file.sidekicks)

    const saved = withWindowSlice(file, windowId, { sessions: {}, projects: [] }, geometry)
    expect(JSON.stringify(saved.sidekicks)).toBe(original)

    const geometryOnly = withWindowSlice(saved, windowId, saved.windows[0]!.workspace, { ...geometry, fullScreen: true })
    expect(JSON.stringify(geometryOnly.sidekicks)).toBe(original)

    const removed = withoutWindow(geometryOnly, windowId)
    expect(removed.windows).toEqual([])
    expect(JSON.stringify(removed.sidekicks)).toBe(original)
  })

  it('writes no section at all when there are no sidekicks, so older files stay byte-identical', () => {
    const plain = okFile(plainText)
    expect(plain.sidekicks).toBeUndefined()
    expect(serializeWorkspaceFile(plain)).not.toContain('"sidekicks"')

    const emptied = withSidekicks(okFile(withSidekicksText), { version: 1, records: [] })
    expect(serializeWorkspaceFile(emptied)).not.toContain('"sidekicks"')
  })

  it('counts sidekick sessions as durably owned', () => {
    const file = okFile(withSidekicksText)
    const ids = collectSessionIds(file)
    for (const record of file.sidekicks!.records) expect(ids.has(record.sessionId)).toBe(true)
    // ...and still every window session.
    for (const id of Object.keys((file.windows[0]!.workspace as { sessions: object }).sessions)) expect(ids.has(id)).toBe(true)
  })

  it('drops a malformed or duplicate record but keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const document = JSON.parse(withSidekicksText) as { sidekicks: { records: unknown[] } }
    const [first, second] = document.sidekicks.records as Array<Record<string, unknown>>
    document.sidekicks.records = [
      first,
      { ...second, id: 'not-a-uuid' },
      { ...second, id: '00000000-0000-4000-8000-000000000009', sessionId: first!.sessionId },
      second,
      'garbage',
    ]
    const file = okFile(JSON.stringify(document))
    expect(file.sidekicks?.records.map(record => record.id)).toEqual([first!.id, second!.id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 3 malformed'))
    warn.mockRestore()
  })

  it('ignores a section that is not an object without losing the windows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const document = JSON.parse(withSidekicksText) as Record<string, unknown>
    document.sidekicks = ['nope']
    const file = okFile(JSON.stringify(document))
    expect(file.sidekicks).toBeUndefined()
    expect(file.windows).toHaveLength(1)
    warn.mockRestore()
  })
})
