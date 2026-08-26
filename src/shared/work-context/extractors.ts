import { asRecord } from '@shared/lib/asRecord.js'
import { extractClaudeWorktreeActivitySeeds } from '@shared/work-context/provider-evidence/claude.js'
import { extractCodexWorktreeActivitySeeds } from '@shared/work-context/provider-evidence/codex.js'
import type { WorktreeActivityEventSeed } from '@shared/work-context/provider-evidence/types.js'
import { primaryWeightFor } from '@shared/work-context/scoring.js'
import type { WorktreeActivityEvent } from '@shared/work-context/types.js'

/**
 * This facade is the only raw-provider reconciliation boundary consumed by
 * live tracking and historical indexing. Provider adapters describe where
 * evidence lives; this layer owns the normalized identity and scoring policy.
 * Keeping those responsibilities separate prevents the main process and the
 * renderer from learning fast-changing Codex/Claude transcript grammars.
 */
export function extractWorktreeActivityEvents(
  raw: unknown,
  now = Date.now(),
): WorktreeActivityEvent[] {
  const record = asRecord(raw)
  if (!record) return []

  const seeds = [
    ...extractClaudeWorktreeActivitySeeds(record),
    ...extractCodexWorktreeActivitySeeds(record),
  ]

  return seeds.map((seed, index) => {
    const ts = seed.ts ?? timestampMs(record, now)
    const primaryWeight = seed.primaryWeight ?? primaryWeightFor(seed.kind)
    return {
      ...seed,
      ts,
      primaryWeight,
      key: eventKey(seed, ts, index),
    }
  })
}

function eventKey(
  seed: WorktreeActivityEventSeed,
  ts: number,
  index: number,
): string {
  return [
    seed.source,
    seed.kind,
    ts,
    seed.path,
    seed.branch ?? '',
    seed.command ?? '',
    seed.filePaths?.join(',') ?? '',
    index,
  ].join('|')
}

function timestampMs(record: Record<string, unknown>, fallback: number): number {
  const timestamp = stringField(record, 'timestamp')
  if (!timestamp) return fallback
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
