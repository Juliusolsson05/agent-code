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
vi.mock('@main/providerSwitch/shared.js', () => ({ resolveProviderTranscriptPath: vi.fn(async () => fixture) }))
vi.mock('@providers/registry.main.js', () => ({ getMainProvider: () => ({}) }))

const { setMainOperationSink } = await import('@main/performance/operations.js')
const { loadInitialHistoryChunk } = await import('./historyLoader.js')

afterEach(() => setMainOperationSink(() => {}))

it('records one transcript.read per initial history load', async () => {
  const operations: Array<{ name: string }> = []
  setMainOperationSink(record => { operations.push(record) })
  const chunk = await loadInitialHistoryChunk({ kind: 'claude', cwd: '/fixture/repo', providerSessionId: 'fc475787-6395-4cda-8bd2-1faacaa18bc7', limit: 20 } as never)
  expect(chunk.entries.length).toBeGreaterThan(0)
  expect(operations.filter(op => op.name === 'transcript.read')).toHaveLength(1)
})
