// Relative-time labels for glance surfaces (fleet rows, peek footers).
// Deliberately terse — these are status chips, not timestamps: "now", "5m",
// "2h", "3d". The exact instant (title attr) rides along for anyone who
// needs it, which is the same deal the desktop's freshness footer makes.

export function relativeShort(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
