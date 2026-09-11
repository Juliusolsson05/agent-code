import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const source = vi.hoisted(() => ({ path: '' }))
vi.mock('@main/providerSwitch/shared.js', () => ({ getClaudeSessionFilePath: async () => source.path, writeProjectedClaudeSessionFile: vi.fn(), projectedClaudeSessionId: vi.fn() }))
import { nativeHistoryControlCapabilities } from './nativeHistoryControl'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const context = { requestId: 'catalog', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'main' as const, generation: 'main' } }
// The catalog is the conversation service; the control layer only reshapes
// its rows, so a fake service with one catalog-shaped row is the contract.
const service = {
  list: vi.fn(async (request: { query?: string; providers?: string[] }) => ({
    rows: [{ provider: 'claude', nativeId: 'source', cwd: '/trial', label: 'Recorded conversation', labelSource: 'ai-title', gitBranch: null, agentCodeTitle: null, firstPrompt: 'Recorded', lastUserActivityAt: 1, promptCount: 3, match: request.query ? { field: 'prompt', text: 'Recorded conversation', start: 0, end: 8 } : null }],
    total: 1, hiddenChildren: 0, nextCursor: null, family: { repoRoot: '/trial', roots: ['/trial'] }, timing: { ms: 1 },
  })),
  prompts: vi.fn(async () => [{ text: 'Recorded conversation', timestamp: 1 }]),
  children: vi.fn(async () => []),
}
const capabilities = () => nativeHistoryControlCapabilities(service as never)
it('pages exact rewind references from the recorded Claude transcript through the real native engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-native-catalog-')); directories.push(dir)
  source.path = join(dir, 'source.jsonl')
  // These are captured native Claude records from the existing rendering
  // bundle, not invented prompt shapes. Only the storage path is redirected.
  const bundle = JSON.parse(await readFile('testing/fixtures/rendering-bundles/2026-07-07T13-17-48-452-5b19529f.json', 'utf8'))
  await writeFile(source.path, bundle.input.entries.map((row: unknown) => JSON.stringify(row)).join('\n'))
  const native = await getHostTranscriptAdapter('claude').listPrompts('/trial', 'recorded')
  expect(native.length).toBeGreaterThan(1)
  const cap = capabilities().find(cap => cap.descriptor.id === 'nativeHistory.prompts')!
  const input = { provider: 'claude', cwd: '/trial', nativeSessionId: 'recorded', limit: 1, previewChars: 20 }
  const first = await cap.execute(input, context)
  if (!first.ok) throw new Error(JSON.stringify(first))
  const page = first.value as { items: Array<{ address: unknown; totalChars: number; text: string }>; nextCursor: string }
  expect(page.items[0]).toMatchObject({ address: native.at(-1)!.address, text: native.at(-1)!.text.slice(0, 20), totalChars: native.at(-1)!.text.length })
  expect(await cap.execute({ ...input, cursor: page.nextCursor }, context)).toMatchObject({ ok: true, value: { items: [{ address: native.at(-2)!.address }] } })
  const search = capabilities().find(cap => cap.descriptor.id === 'nativeHistory.search')!
  const query = native.find(row => row.text.trim().length > 20)!.text.trim().slice(0, 60)
  expect(await search.execute({ query, cwd: '/trial' }, context)).toMatchObject({ ok: true, value: { items: [expect.objectContaining({ provider: 'claude', nativeSessionId: 'source', cwd: '/trial', matchCount: 1 })], coverage: { exhaustive: true, candidatesPerProvider: 1 } } })
  expect(service.list).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/trial', scope: 'repository', query: query.trim(), includeChildren: true }))
  const exact = native.at(-1)!.text
  expect(await cap.execute({ ...input, query: exact, previewChars: 0 }, context)).toMatchObject({ ok: true, value: { items: [{ address: native.at(-1)!.address, text: '', totalChars: exact.length }] } })
  expect(await cap.execute({ ...input, previewChars: 0, cursor: page.nextCursor }, context)).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
})
it('lists every provider through the catalog and reports IO failures rather than a complete empty account', async () => {
  const cap = capabilities().find(cap => cap.descriptor.id === 'nativeHistory.list')!
  // OpenCode discovery works now: the catalog reads its database directly.
  expect(await cap.execute({ provider: 'opencode' }, context)).toMatchObject({ ok: true, value: { provider: 'opencode', items: [expect.objectContaining({ nativeSessionId: 'source', summary: 'Recorded conversation', cwd: '/trial' })] } })
  expect(service.list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'everywhere', providers: ['opencode'], includeChildren: true }))
  service.list.mockRejectedValueOnce(new Error('Provider directory is unreadable'))
  expect(await cap.execute({ provider: 'claude' }, context)).toMatchObject({ ok: false, error: { message: 'Provider directory is unreadable' } })
})
