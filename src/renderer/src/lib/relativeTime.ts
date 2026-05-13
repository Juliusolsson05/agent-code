// Compact relative timestamps for status surfaces.
//
// Why this lives in src/renderer/src/lib (and not under
// features/worktrees or features/workspace): four different modals
// and bars need the same formatter — the path-picker session-age
// label, prompt-search results, agent-activity rows, and the
// worktrees bar — and they cross feature boundaries. Keeping the
// helper in a feature folder forced one of them to reach across
// (which would always feel wrong) so we hoist it to the shared
// renderer-lib level instead.
//
// The 'just now' threshold (sub-5s) exists so the agent-activity
// modal does not flicker between '0s ago', '1s ago', '2s ago' on
// freshly-touched sessions; older surfaces (where 'just now' would
// be inappropriate) can keep using the sub-minute seconds tick by
// querying with timestamps that are already > 5s old, but in
// practice everyone has been happy with 'just now'.

export function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  if (diffMs < 0) return 'in the future'
  const secs = Math.floor(diffMs / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
