import type { SessionRuntime } from '@renderer/session-runtime/state'

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

export function tldrActivity(runtime?: SessionRuntime): { active: boolean; timestamp: number | null } {
  if (!runtime) return { active: false, timestamp: null }
  // The canonical session status owns "working". A running CLI alone is not
  // activity, nor is mounting/reloading a pane. Phase timestamps are observed
  // work; JSONL timestamps are producer time, so replaying yesterday's history
  // cannot make it look freshly active. TLDR writes never enter this signal.
  const active = runtime.exited == null && runtime.sessionStatus === 'running'
  const evidence = [runtime.lastJsonlEntryAt, runtime.phaseChangedAt, runtime.turnStartedAt, runtime.submittedAt]
  if (runtime.lastJsonlEntryAt == null) {
    // Some history-loading paths predate the ingest watermark. Only visible
    // previews need this fallback, and chronological history lets us stop at
    // the latest valid entry instead of scanning it on every workspace render.
    for (let i = runtime.entries.length - 1; i >= 0; i--) {
      const raw = (runtime.entries[i] as { timestamp?: unknown }).timestamp
      const time = typeof raw === 'string' ? Date.parse(raw) : NaN
      if (Number.isFinite(time)) { evidence.push(time); break }
    }
  }
  const valid = evidence.filter((time): time is number => typeof time === 'number' && Number.isFinite(time))
  return { active, timestamp: valid.length ? Math.max(...valid) : null }
}
