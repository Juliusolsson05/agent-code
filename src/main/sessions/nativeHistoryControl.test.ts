import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const source = vi.hoisted(() => ({ path: '', list: vi.fn() }))
vi.mock('@providers/registry.main', () => ({ getMainProvider: (id: string) => id === 'opencode'
  ? { sessionDiscoveryUnavailableReason: 'OpenCode discovery unavailable (#773)' } : { listSessions: source.list, listAllSessions: source.list } }))
vi.mock('@main/providerSwitch/shared.js', () => ({ getClaudeSessionFilePath: async () => source.path, writeProjectedClaudeSessionFile: vi.fn(), projectedClaudeSessionId: vi.fn() }))
import { nativeHistoryControlCapabilities } from './nativeHistoryControl'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const context = { requestId: 'catalog', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'main' as const, generation: 'main' } }
it('pages exact rewind references from the recorded Claude transcript through the real native engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ac-native-catalog-')); directories.push(dir)
  source.path = join(dir, 'source.jsonl')
  // These are captured native Claude records from the existing rendering
  // bundle, not invented prompt shapes. Only the storage path is redirected.
  const bundle = JSON.parse(await readFile('testing/fixtures/rendering-bundles/2026-07-07T13-17-48-452-5b19529f.json', 'utf8'))
  await writeFile(source.path, bundle.input.entries.map((row: unknown) => JSON.stringify(row)).join('\n'))
  const native = await getHostTranscriptAdapter('claude').listPrompts('/trial', 'recorded')
  expect(native.length).toBeGreaterThan(1)
  const cap = nativeHistoryControlCapabilities().find(cap => cap.descriptor.id === 'nativeHistory.prompts')!
  const input = { provider: 'claude', cwd: '/trial', nativeSessionId: 'recorded', limit: 1, previewChars: 20 }
  const first = await cap.execute(input, context)
  if (!first.ok) throw new Error(JSON.stringify(first))
  const page = first.value as { items: Array<{ address: unknown; totalChars: number; text: string }>; nextCursor: string }
  expect(page.items[0]).toMatchObject({ address: native.at(-1)!.address, text: native.at(-1)!.text.slice(0, 20), totalChars: native.at(-1)!.text.length })
  expect(await cap.execute({ ...input, cursor: page.nextCursor }, context)).toMatchObject({ ok: true, value: { items: [{ address: native.at(-2)!.address }] } })
  expect(await cap.execute({ ...input, previewChars: 0, cursor: page.nextCursor }, context)).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
})
it('reports unsupported discovery and IO failures rather than a complete empty account', async () => {
  const cap = nativeHistoryControlCapabilities().find(cap => cap.descriptor.id === 'nativeHistory.list')!
  expect(await cap.execute({ provider: 'opencode' }, context)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  source.list.mockRejectedValue(new Error('Provider directory is unreadable'))
  expect(await cap.execute({ provider: 'claude' }, context)).toMatchObject({ ok: false, error: { message: 'Provider directory is unreadable' } })
})
