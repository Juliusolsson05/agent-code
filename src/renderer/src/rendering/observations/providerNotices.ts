import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { SemanticErrorEntry } from '@renderer/session-runtime/state'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderCandidate } from '@renderer/rendering/model/types'

/** Notices have their own owner because they are request failures, not model
 * output. They neither suppress committed conversation nor get suppressed by a
 * successful turn whose text happens to quote the same provider message. */
export function collectProviderNotices(errors: readonly SemanticErrorEntry[], provider: AgentProviderKind, sessionId: string): RenderCandidate[] {
  const adapt = getRendererProviderCapabilities(provider).usageLimitNoticeFromError
  if (!adapt) return []
  return errors.flatMap((error, index) => {
    const notice = adapt(error)
    // Old debug-only errors have no ingest identity and are not reconstructable
    // status facts. Never substitute a visible index that shifts after eviction.
    if (!notice || !error.id) return []
    return [{
      id: `notice:${sessionId}:${error.id}`,
      owner: 'provider-notice' as const,
      sourcePlane: 'semantic' as const, source: error.source,
      provider, sessionId, contentKind: 'provider-notice' as const,
      timestampMs: error.observedAtMs ?? null, sequence: index,
      usageLimitNotice: notice, sessionRunId: error.sessionRunId,
    }]
  })
}
