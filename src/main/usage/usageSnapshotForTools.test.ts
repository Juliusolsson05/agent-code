import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1451 review c: the two contracts the usage domain exists for — a failed
// source stays an ERROR (never a zero), and agents never bypass the shared
// cache — were pinned only against a mocked `readUsageSnapshot` in
// usageTools.test.ts. A passthrough mock cannot regress, so the reader itself
// could drop error rows or default to `force: true` with every test green.
// This drives the REAL `readUsageSnapshotForTools` over the real Usage service,
// with only the provider reads replaced at the source table (the true edge:
// network + credential files), using the recorded snapshot's own rows.

const recorded = JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../testing/fixtures/usage/snapshot-2026-09-27.json'), 'utf8')) as {
  snapshot: { providers: Array<{ provider: string; status: string; message?: string }> }
}
const recordedCodex = recorded.snapshot.providers.find(p => p.provider === 'codex')!
const recordedGrok = recorded.snapshot.providers.find(p => p.provider === 'grok')!

const reads = vi.hoisted(() => ({ codex: 0, grok: 0 }))
vi.mock('@main/setup/providerEnablement.js', () => ({
  getProviderEnablementSnapshot: async () => ({ entries: [], opencodeUsageSource: null }),
}))
vi.mock('@main/usage/sources.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@main/usage/sources.js')>()
  return {
    ...actual,
    listActiveUsageSourceIds: () => ['codex', 'grok'],
    USAGE_SOURCES: {
      ...actual.USAGE_SOURCES,
      codex: { ...actual.USAGE_SOURCES.codex!, read: async () => { reads.codex += 1; return structuredClone(recordedCodex) } },
      // The recorded Grok row is an expired login; the real reader throws the
      // first-party copy and the service's per-provider catch turns it into
      // the error row. Reproduce that path, not the row itself.
      grok: { ...actual.USAGE_SOURCES.grok!, read: async () => { reads.grok += 1; throw new Error(recordedGrok.message) } },
    },
  }
})

import { invalidateUsageSnapshotCache, readUsageSnapshotForTools } from './usageService.js'

beforeEach(() => {
  invalidateUsageSnapshotCache()
  reads.codex = 0
  reads.grok = 0
})

describe('readUsageSnapshotForTools (#1339, #1451 review c)', () => {
  it('keeps a failed source as an error row, never a zero or a missing provider', async () => {
    const snapshot = await readUsageSnapshotForTools() as { providers: Array<{ provider: string; status: string; message?: string; rows?: unknown }> }
    expect(snapshot.providers.map(p => p.provider)).toEqual(['codex', 'grok'])
    const grok = snapshot.providers.find(p => p.provider === 'grok')!
    expect(grok.status).toBe('error')
    expect(grok.rows).toBeUndefined()
    expect(grok.message).toBe(recordedGrok.message)
  })

  it('reads through the shared cache by default, so a fleet of agents cannot poll the providers', async () => {
    // Called exactly as usage_read calls it (no argument). A `force: true`
    // default here, or in main's wiring, would read the providers twice.
    await readUsageSnapshotForTools()
    const second = await readUsageSnapshotForTools() as { cache: { hit: boolean } }
    expect(reads).toEqual({ codex: 1, grok: 1 })
    expect(second.cache.hit).toBe(true)
  })
})
