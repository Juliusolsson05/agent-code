import { asRecord } from '@shared/lib/asRecord'
import type { UsageLimitNotice } from '@shared/types/usageLimitNotice'

/** Accept the typed error channel, including its retained reducer shape. A
 * bare 429 and the broader native UsageLimitExceeded tag cannot prove a cap's
 * reset or remediation. Those signals deliberately do not enter this adapter. */
export function codexUsageLimitNotice(value: unknown): UsageLimitNotice | null {
  const event = asRecord(value)
  if (!event || (event.type ?? event.kind) !== 'api_error' || event.source !== 'proxy') return null
  if (typeof event.message !== 'string') return null
  const base = { provider: 'codex' as const, originalMessage: event.message }
  if (event.errorType === 'quota_exceeded' || event.errorType === 'usage_not_included') {
    return { ...base, category: 'access', title: event.errorType === 'quota_exceeded' ? 'Quota exhausted' : 'Usage not included', detail: event.message, remedy: 'manage-usage' }
  }
  if (event.errorType !== 'usage_limit_reached') return null
  const limitId = typeof event.limitId === 'string' ? event.limitId : undefined
  const limitName = typeof event.limitName === 'string' ? event.limitName.trim() : undefined
  const namedPool = limitName && !['codex', 'gpt-reserve'].includes(limitName.toLowerCase()) ? limitName : undefined
  const notice: UsageLimitNotice = {
    ...base, category: 'usage-window',
    title: namedPool ? `Usage limit reached for ${namedPool}` : 'Usage limit reached',
    remedy: 'manage-usage', limitId, limitName,
  }
  switch (event.rateLimitReachedType) {
    case undefined:
    case 'rate_limit_reached':
      break
    case 'workspace_owner_credits_depleted':
    case 'workspace_member_credits_depleted':
      notice.category = 'credits'
      notice.title = 'Workspace credits exhausted'
      notice.remedy = event.rateLimitReachedType === 'workspace_member_credits_depleted' ? 'ask-owner' : 'manage-usage'
      notice.detail = notice.remedy === 'ask-owner' ? 'Ask a workspace owner to add credits.' : 'Add workspace credits to continue.'
      break
    case 'workspace_owner_usage_limit_reached':
    case 'workspace_member_usage_limit_reached':
      notice.category = 'spend-cap'
      notice.title = 'Workspace spend cap reached'
      notice.remedy = event.rateLimitReachedType === 'workspace_member_usage_limit_reached' ? 'ask-owner' : 'manage-usage'
      notice.detail = notice.remedy === 'ask-owner' ? 'Ask a workspace owner to increase your spend cap.' : 'Increase your workspace spend cap to continue.'
      break
    default:
      notice.category = 'unknown'
      notice.detail = event.message
      break
  }
  // Backend resets_at is UNIX SECONDS. Convert at this provider boundary only,
  // validate the representable Date range, and do not attach an ordinary-window
  // reset to a workspace cap/credit refusal. Waiting need not resolve those.
  const seconds = event.resetsAt
  if (notice.category === 'usage-window' && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 8_640_000_000_000) {
    notice.reset = { subject: 'blocking-limit', atMs: seconds * 1000 }
  }
  return notice
}
