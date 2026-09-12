import { asRecord } from '@shared/lib/asRecord'
import type { UsageLimitNotice } from '@shared/types/usageLimitNotice'

/** The metadata is the admission boundary. Matching a phrase in arbitrary
 * prose would turn a quoted error in a user prompt, tool output, or explanation
 * into an actionable cap. Only the known provider-authored error carrier may
 * use the text profile to refine its cap and reset subject. */
export function claudeUsageLimitNotice(value: unknown): UsageLimitNotice | null {
  const entry = asRecord(value)
  if (entry?.type !== 'assistant' || entry.isApiErrorMessage !== true || entry.error !== 'rate_limit') return null
  const message = asRecord(entry.message)
  const content = message?.content
  const originalMessage = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(block => {
        const item = asRecord(block)
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
      }).filter(Boolean).join('\n')
    : ''
  if (!originalMessage.trim()) return null
  const monthly = /^You've hit your monthly spend limit(?:[\s.·]|$)/i.test(originalMessage.trim())
  const usage = /^You've hit your (?:usage|session|weekly) limit(?:[\s.·]|$)/i.test(originalMessage.trim())
  // The source contains a clock label, not a date. Keep its timezone verbatim
  // and never feed Date.parse a bare "2:10pm", even during history replay.
  const sessionReset = originalMessage.match(/(?:^|[·\n])\s*your session limit resets\s+([^·\n]+)/i)?.[1]?.trim()
  return {
    provider: 'claude',
    category: monthly ? 'spend-cap' : usage ? 'usage-window' : 'unknown',
    title: monthly ? 'Monthly spend limit reached' : usage ? 'Usage limit reached' : 'Rate limit reported',
    detail: monthly || usage ? undefined : originalMessage,
    originalMessage,
    reset: sessionReset ? { subject: 'session-window', label: sessionReset } : undefined,
    remedy: 'manage-usage',
    providerSessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
  }
}
