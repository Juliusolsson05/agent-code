import { sessionActivity } from '@renderer/session-runtime/activity'

const DAY = 24 * 60 * 60 * 1000
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'long' })

export function tldrTime(timestamp: number | null, now: number): { text: string; iso?: string; exact?: string } {
  if (timestamp === null || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return { text: 'Unknown' }
  const date = new Date(timestamp)
  // Calendar dates for old entries are easier to place than "17 weeks ago".
  // Follow GitHub relative-time's 30-day threshold, using Intl rather than a
  // dependency. Minute precision keeps this secondary surface calm; slight
  // producer clock skew is clamped instead of claiming activity in the future.
  const elapsed = Math.max(0, now - timestamp)
  const text = elapsed < 60_000 ? 'just now'
    : elapsed < 3_600_000 ? relative.format(-Math.floor(elapsed / 60_000), 'minute')
    : elapsed < DAY ? relative.format(-Math.floor(elapsed / 3_600_000), 'hour')
    : elapsed < 30 * DAY ? relative.format(-Math.floor(elapsed / DAY), 'day')
    : `on ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}) })}`
  return { text, iso: date.toISOString(), exact: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) }
}

/**
 * The TLDR footer's activity line.
 *
 * Re-exported rather than implemented here since #915: the
 * `agent_management` MCP inventory answers the same question, and two
 * derivations of "last active" meant two answers to "is this child safe to
 * close". `sessionActivity` carries the full reasoning.
 */
export const tldrActivity = sessionActivity
