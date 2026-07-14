import { memo } from 'react'

// The single status vocabulary for artifact cards. One component so
// every tool surface flips through the SAME states with the SAME look —
// the old rows each hand-rolled their own "running/failed/done" spans
// (BlockRow's toolState badge, Codex status chips, GitCardRow's
// placeholder) and drifted.
//
// Design constraints:
//   - No layout shift between states: fixed line-height inline span,
//     text-only. A card completing must not move its neighbors.
//   - `streaming` pulses subtly (input still arriving); `running` is
//     static (input done, awaiting result) — the WorkIndicator at the
//     feed foot owns the loud "agent is busy" affordance, this badge
//     is per-card context only.
//   - Error shows the exit code when known (`exit 1`) because that is
//     the single most useful diagnostic bit a command can surface;
//     the old rows parsed it and then threw it away.

export type BadgeStatus = 'streaming' | 'running' | 'complete' | 'error'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m${sec ? ` ${sec}s` : ''}`
}

export const StatusBadge = memo(function StatusBadge({
  status,
  exitCode = null,
  durationMs = null,
}: {
  status: BadgeStatus
  exitCode?: number | null
  durationMs?: number | null
}) {
  const base = 'text-[11px] uppercase tracking-wider select-none'
  switch (status) {
    case 'streaming':
      return <span className={`${base} text-muted animate-pulse`}>streaming</span>
    case 'running':
      return <span className={`${base} text-muted`}>running</span>
    case 'error':
      return (
        <span className={`${base} text-danger`}>
          {exitCode != null ? `exit ${exitCode}` : 'failed'}
        </span>
      )
    case 'complete':
      return (
        <span className={`${base} text-muted`}>
          ✓{durationMs != null ? ` ${formatDuration(durationMs)}` : ''}
        </span>
      )
  }
})
