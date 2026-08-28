import type { WorktreeActivityEvent } from '@shared/work-context/types.js'

/**
 * Provider adapters stop at this seed shape because timestamps, stable event
 * keys, and scoring defaults are provider-neutral policy. Keeping that final
 * materialization in the facade means a future Codex grammar change cannot
 * quietly invent a second key or weighting scheme that historical and live
 * consumers interpret differently.
 */
export type WorktreeActivityEventSeed = Omit<
  WorktreeActivityEvent,
  'key' | 'ts' | 'primaryWeight'
> & {
  ts?: number
  primaryWeight?: number
}
