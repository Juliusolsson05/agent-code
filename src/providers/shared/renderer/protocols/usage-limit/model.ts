import type { UsageLimitNotice } from '@shared/types/usageLimitNotice'

// Fixed provider destinations, never a link extracted from arbitrary error
// text. The original payload remains inspectable without granting its URLs an
// executable role in the card.
export const USAGE_URLS = {
  claude: 'https://claude.ai/settings/usage?from=cc_cli_limit_message',
  codex: 'https://chatgpt.com/codex/settings/usage',
} as const

export type UsageLimitActions = {
  openUsage: () => void
  switchProvider: (notice: UsageLimitNotice, sessionRunId?: string) => void
  canSwitchProvider: (notice: UsageLimitNotice, sessionRunId?: string) => boolean
}

/** An absolute, qualified report stays truthful in history and across midnight.
 * No render-time Date.now/countdown: passing a reset time is not evidence that
 * the account is usable again. Claude's text-only label is never date-parsed. */
export function usageLimitResetLabel(notice: UsageLimitNotice, timeZone?: string): string | null {
  const reset = notice.reset
  if (!reset) return null
  const subject = reset.subject === 'session-window' ? 'Session reset reported for' : 'Reset reported for'
  if (reset.label) return `${subject} ${reset.label}`
  if (reset.atMs === undefined || !Number.isFinite(reset.atMs) || Math.abs(reset.atMs) > 8_640_000_000_000_000) return null
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  })
  return `${subject} ${formatter.format(reset.atMs)} (${formatter.resolvedOptions().timeZone})`
}
