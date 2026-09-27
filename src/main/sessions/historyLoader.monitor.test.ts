import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

// #769 (measure first): each IPC initial history load recorded
// `transcript.read` TWICE. The outer span ended after path resolution
// ("delegated") and the file read opened a second span with the same name,
// so half the monitor's samples timed only the path lookup and the
// percentiles read low. One load must be one sample.
const fixture = join(
  import.meta.dirname,
  '../../../testing/fixtures/conversations/claude/projects/-fixture-repo--worktrees-feat-api-key-vault/fc475787-6395-4cda-8bd2-1faacaa18bc7.jsonl',
)
// The resolver takes a measurable 80 ms, so the one sample can be checked to
// time the READ, not the path lookup (#1352 review c: a count alone passed
// when the lookup span was mapped instead of the read span).
const RESOLVE_MS = 80
vi.mock('@main/providerSwitch/shared.js', () => ({
  resolveProviderTranscriptPath: vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, RESOLVE_MS)); return fixture }),
}))
vi.mock('@providers/registry.main.js', () => ({ getMainProvider: () => ({}) }))

const { setMainOperationSink } = await import('@main/performance/operations.js')
const { loadInitialHistoryChunk } = await import('./historyLoader.js')

afterEach(() => setMainOperationSink(() => {}))

it('records one transcript.read per initial history load', async () => {
  const operations: Array<{ name: string; durationMs?: number }> = []
  setMainOperationSink(record => { operations.push(record) })
  const chunk = await loadInitialHistoryChunk({ kind: 'claude', cwd: '/fixture/repo', providerSessionId: 'fc475787-6395-4cda-8bd2-1faacaa18bc7', limit: 20 } as never)
  expect(chunk.entries.length).toBeGreaterThan(0)
  const reads = operations.filter(op => op.name === 'transcript.read') as Array<{ name: string; durationMs: number }>
  expect(reads).toHaveLength(1)
  expect(reads[0]!.durationMs).toBeLessThan(RESOLVE_MS)
})
