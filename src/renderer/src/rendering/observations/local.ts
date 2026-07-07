import type { AgentProviderKind } from '@shared/types/providerKind'
import { normalizeTextKey } from '@renderer/rendering/observations/committed'
import type { RenderCandidate } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// Local candidate collectors — optimistic submits + lifecycle (work/empty).
//
// Optimistic rows exist ONLY for echo providers (codex, opencode — the
// usesOptimisticUserEcho capability): their committed user row can lag or
// never arrive, so the submitted prompt needs a visible owner immediately.
// Claude never mints one (its queue-operation records are the provider-
// owned signal; a Claude optimistic row would double-render every prompt).
//
// The optimistic candidate carries the normalized prompt key because its
// whole lifecycle ends by RECONCILIATION: when the committed user row with
// matching normalized text lands, committed owns the prompt and the
// optimistic candidate is rejected with 'optimistic-owned-by-committed'.
// Matching is marker + normalized text, never tail position (a committed
// tool-result user row can land between the optimistic row and the real
// prompt — the documented two-pass lesson).
// ---------------------------------------------------------------------------

export type OptimisticPromptLike = {
  /** The optimistic uuid (legacy prefix `optimistic-codex-user:` is the
   *  shared marker across echo providers — codex-named, provider-neutral). */
  uuid: string
  text: string
  submittedAtMs: number | null
}

export function collectOptimisticCandidates(
  prompts: readonly OptimisticPromptLike[],
  provider: AgentProviderKind,
  sessionId: string,
): RenderCandidate[] {
  return prompts.map((p, i) => ({
    id: `optimistic:${p.uuid}`,
    owner: 'optimistic-submit' as const,
    provider,
    sourcePlane: 'local-submit' as const,
    sessionId,
    contentKind: 'user-text' as const,
    // Submit wall-clock: the optimistic row stands in for its future
    // committed twin, so it must sort exactly where the committed row will
    // (same timestamp basis, and SOURCE_RANK ties it with committed rows).
    timestampMs: p.submittedAtMs,
    sequence: i,
    textKey: p.text,
    normalizedTextKey: normalizeTextKey(p.text),
  }))
}

/**
 * Lifecycle candidates. Work is a PURE phase fact, never text (plan §7 rule
 * 8): `streamPhase !== 'idle'` ALWAYS yields a work candidate even when every
 * content candidate was suppressed as a duplicate — submit-in-flight, request
 * wait, and tool wait are visible states with no text.
 *
 * WHY 'empty' NO LONGER lives here (finding #9): emptiness is not a
 * collection-time fact. A content candidate can still be REJECTED downstream
 * by committed ownership or the ghost gate, so "no content survived" is only
 * knowable AFTER the ledger runs its decisions. The old shape keyed 'empty'
 * on a `hasContentCandidates` flag computed from RAW candidate counts in the
 * adapter; when the sole content candidate was later suppressed, the flag
 * still read true, no 'empty' was emitted, and the feed painted a BLANK
 * surface. The ledger now owns the empty verdict — it appends
 * buildEmptyCandidate() after survivors are known — which also lets this
 * collector stay a pure function of streamPhaseIdle, keeping the 'work' row
 * identity-stable across the whole stream (D11).
 */
export function collectLifecycleCandidates(params: {
  provider: AgentProviderKind
  sessionId: string
  streamPhaseIdle: boolean
}): RenderCandidate[] {
  const out: RenderCandidate[] = []
  if (!params.streamPhaseIdle) {
    out.push({
      id: 'work',
      owner: 'work',
      provider: params.provider,
      sourcePlane: 'process',
      sessionId: params.sessionId,
      contentKind: 'work',
      timestampMs: null,
      sequence: 1,
    })
  }
  return out
}

/**
 * The empty-state candidate, built on demand for the LEDGER to append when no
 * content candidate survived its decisions (finding #9 — see
 * collectLifecycleCandidates for why emptiness cannot be decided at collection
 * time). Split out as a builder because only the adapter holds the sessionId;
 * the value is otherwise static, so callers cache it on (provider, sessionId)
 * to preserve the D11 identity contract. sequence 0 keeps it ordering-stable
 * ahead of the sequence-1 work chip when both are present (all content
 * suppressed while still streaming).
 */
export function buildEmptyCandidate(
  provider: AgentProviderKind,
  sessionId: string,
): RenderCandidate {
  return {
    id: 'empty',
    owner: 'empty',
    provider,
    sourcePlane: 'process',
    sessionId,
    contentKind: 'empty',
    timestampMs: null,
    sequence: 0,
  }
}
