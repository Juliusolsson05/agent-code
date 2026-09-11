/** Provider status, never an assistant message. Recognition belongs to each
 * provider adapter; the view consumes this closed model without inspecting wire
 * payloads. In particular, a session-reset hint can accompany a MONTHLY cap and
 * must not become a promise that the blocking cap clears at that time. */
export type UsageLimitNotice = {
  provider: 'claude' | 'codex'
  category: 'usage-window' | 'spend-cap' | 'credits' | 'access' | 'unknown'
  title: string
  detail?: string
  originalMessage: string
  reset?: {
    subject: 'blocking-limit' | 'session-window'
    atMs?: number
    label?: string
  }
  remedy: 'manage-usage' | 'ask-owner' | 'ask-admin'
  limitId?: string
  limitName?: string
  /** Native session identity on durable carriers. Hosts can decline actions
   * for an archived/imported carrier belonging to a different session. */
  providerSessionId?: string
}

/** Optional additions keep pre-feature recordings readable. IDs name observed
 * failures, not turns: a rejected HTTP request often has no model turn at all. */
export type ProviderErrorMetadata = {
  id?: string
  requestId?: string
  errorType?: string
  turnId?: string
  source?: string
  resetsAt?: number
  limitId?: string
  limitName?: string
  rateLimitReachedType?: string
  status?: number
  retryAfterMs?: number
}
