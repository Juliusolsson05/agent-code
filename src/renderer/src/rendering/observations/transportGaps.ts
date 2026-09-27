import type { AgentProviderKind } from '@shared/types/providerKind'
import type { TransportGapRecord } from '@shared/types/session'
import type { RenderCandidate } from '@renderer/rendering/model/types'

/**
 * One durable "not captured" row per proxy-transport gap (#1381, option B,
 * OWNER-APPROVED by B6 proxy 2026-09-27: lost data is never hidden).
 *
 * WHY owner `provider-notice` and not a new owner: adding an owner is an
 * architectural change (RenderOwner's own comment), and the notice owner's
 * contract is already the right one — a status fact that neither suppresses
 * committed conversation nor is suppressed by it, ordered after equal-time
 * conversation (order.ts SOURCE_RANK).
 *
 * WHY `timestampMs = since ?? until`: the row belongs where the loss began,
 * among the entries written around then. `since` is when main's tail was last
 * caught up; with no `since` (a loss before the first poll) the detection
 * time is the only instant we have. A gap older than every loaded entry sorts
 * to the top of the window rather than being withheld — never hidden.
 */
export function collectTransportGaps(
  gaps: readonly TransportGapRecord[],
  provider: AgentProviderKind,
  sessionId: string,
): RenderCandidate[] {
  return gaps.map((gap, index) => ({
    id: `transport-gap:${sessionId}:${gap.id}`,
    owner: 'provider-notice' as const,
    sourcePlane: 'semantic' as const,
    source: 'proxy',
    provider,
    sessionId,
    contentKind: 'transport-gap' as const,
    timestampMs: gap.since ?? gap.until,
    sequence: index,
    transportGap: gap,
  }))
}
