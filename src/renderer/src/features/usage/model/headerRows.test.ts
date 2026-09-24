import { describe, expect, it } from 'vitest'

import type { UsageSnapshot, UsageSourceId } from '@shared/types/usage'
import { toHeaderProviders } from './headerRows'

function snapshotFor(provider: UsageSourceId): UsageSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    cache: { hit: false, ttlMs: 30_000 },
    providers: [
      {
        provider,
        status: 'ok',
        sourceLabel: 'test',
        plan: null,
        rows: [
          {
            id: 'r1',
            label: 'Current week',
            percent: 42,
            severity: 'normal',
            resetsAt: null,
            active: true,
            detail: null,
            scope: 'all-models',
          },
        ],
        spend: null,
        extraUsage: null,
        credits: null,
      },
    ],
  }
}

describe('toHeaderProviders chip codes', () => {
  it('assigns a distinct two-letter code per source', () => {
    expect(toHeaderProviders(snapshotFor('claude'))[0].code).toBe('CL')
    expect(toHeaderProviders(snapshotFor('codex'))[0].code).toBe('CX')
    expect(toHeaderProviders(snapshotFor('grok'))[0].code).toBe('GR')
    expect(toHeaderProviders(snapshotFor('opencode:zai'))[0].code).toBe('ZA')
  })
})
