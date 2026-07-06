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
 * Lifecycle candidates. Work is a phase fact, never text (plan §7 rule 8):
 * `streamPhase !== 'idle'` ALWAYS yields a work candidate even when every
 * content candidate was suppressed as a duplicate — submit-in-flight,
 * request wait, and tool wait are visible states with no text. Empty exists
 * only when no content candidate survived; the ledger decides that AFTER
 * ownership, so this collector takes the survivor count, not raw state.
 */
export function collectLifecycleCandidates(params: {
  provider: AgentProviderKind
  sessionId: string
  streamPhaseIdle: boolean
  hasContentCandidates: boolean
}): RenderCandidate[] {
  const out: RenderCandidate[] = []
  if (!params.hasContentCandidates) {
    out.push({
      id: 'empty',
      owner: 'empty',
      provider: params.provider,
      sourcePlane: 'process',
      sessionId: params.sessionId,
      contentKind: 'empty',
      timestampMs: null,
      sequence: 0,
    })
  }
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
 * Optimistic reconciliation, ledger-side: committed user rows own their
 * optimistic stand-ins by normalized text. Exported for the ledger pass.
 */
export function committedUserTextKeys(
  committed: readonly RenderCandidate[],
): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const c of committed) {
    if (c.contentKind === 'user-text' && c.owner === 'committed') {
      // User rows don't carry textKey (only assistant rows do, for
      // suppression) — reconciliation needs its own key derivation, so the
      // committed collector is extended by callers via normalizedTextKey
      // when present, else this set stays conservative and the optimistic
      // row survives until an exact owner appears. Surviving too long is
      // the visible-and-diagnosable failure; vanishing early is the silent
      // one (#339) — we bias toward visible.
      if (c.normalizedTextKey) keys.add(c.normalizedTextKey)
    }
  }
  return keys
}
