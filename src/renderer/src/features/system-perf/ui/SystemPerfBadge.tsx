import type { SystemPerformanceStats } from '@shared/performance/types'

// Color zones for the heap badge.
//
// Thresholds chosen against observed cc-shell OOMs:
// - 2026-05-06: crashed at ~3.84 GiB / 4.09 GiB cap → 93% (deep red).
// - 2026-05-11: crashed at ~2.69 GiB at an effective ~2.78 GiB cap
//   → 97% (deep red), but the heap-watchdog snapshot threshold is
//   75% — meaning a yellow zone starting at 60% gives the user
//   roughly the same warning the watchdog uses, while red at 80%
//   is "you have minutes, not hours."
// - Hardcoded rather than env-driven on purpose: the zone boundaries
//   are not a per-user preference, they're a diagnostic UX choice.
//   If a future user needs to tune them we can lift to env vars
//   then; YAGNI today.
const YELLOW_ZONE_RATIO = 0.6
const RED_ZONE_RATIO = 0.8

// Sparkline geometry. 60 samples × 1 Hz = last 60 seconds.
//
// We deliberately show ONLY the last minute in the badge sparkline
// (the popover chart shows the full 10-minute ring buffer). The
// badge is meant to answer "is the heap growing right now?" — a
// 60s window catches even rapid growth visibly while staying
// glanceable.
const SPARK_SAMPLES = 60
const SPARK_WIDTH = 60
const SPARK_HEIGHT = 12

type Zone = 'green' | 'yellow' | 'red'

function zoneFor(used: number, limit: number): Zone {
  if (limit <= 0) return 'green'
  const ratio = used / limit
  if (ratio >= RED_ZONE_RATIO) return 'red'
  if (ratio >= YELLOW_ZONE_RATIO) return 'yellow'
  return 'green'
}

// Tailwind text-* colors used for the badge labels. We resolve via
// a switch (not a record indexed by zone) so dead-code elimination
// in the build can drop unused classes if the bundler is strict.
function textClassFor(zone: Zone): string {
  switch (zone) {
    case 'red':
      return 'text-red-400'
    case 'yellow':
      return 'text-amber-400'
    case 'green':
      return 'text-emerald-400'
  }
}

// Raw stroke color for the SVG polyline. SVG doesn't pick up
// Tailwind text utilities through currentColor unless we set
// `color` on the parent — easier to just emit hex values matching
// Tailwind's color-400 stops.
function strokeFor(zone: Zone): string {
  switch (zone) {
    case 'red':
      return '#f87171'
    case 'yellow':
      return '#fbbf24'
    case 'green':
      return '#34d399'
  }
}

// "1.23 GB" / "456 MB". We always use SI multiples (1e9 / 1e6) to
// match Activity Monitor's display rather than Chrome's binary
// (GiB) units. Off by ~7% from GiB but in line with what users
// see in the OS-level monitor.
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}

type Props = {
  current: SystemPerformanceStats
  buffer: SystemPerformanceStats[]
  onClick: () => void
  open: boolean
}

// Header strip rendering live main-process memory.
//
// WHY a button (not a div): the popover toggles on click. Making
// the whole strip the click target keeps the hit area generous
// without adding a separate caret icon — the OOM-debug user is
// looking AT the numbers and wants to inspect them, so the entire
// strip is the affordance.
//
// WHY `[-webkit-app-region:no-drag]`: the header is the
// draggable region for the Electron window on macOS. Without this,
// clicks on the badge would be eaten by window drag and the
// popover would never open.
export function SystemPerfBadge({ current, buffer, onClick, open }: Props) {
  const zone = zoneFor(current.heapUsed, current.heapLimit)
  const textClass = textClassFor(zone)
  const stroke = strokeFor(zone)

  // Take the last SPARK_SAMPLES from the buffer. Early in the
  // session there are fewer than 60 samples; we render whatever
  // we have left-aligned, leaving the right side empty until the
  // buffer fills. That's intentional: a half-filled sparkline
  // makes it obvious the data isn't synthetic.
  const window = buffer.slice(-SPARK_SAMPLES)
  const points = window
    .map((s, i) => {
      const x = (i / Math.max(1, SPARK_SAMPLES - 1)) * SPARK_WIDTH
      const ratio = s.heapLimit > 0 ? Math.min(1, s.heapUsed / s.heapLimit) : 0
      const y = SPARK_HEIGHT - ratio * SPARK_HEIGHT
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label="System performance"
      title="Main-process heap + RSS · click to expand"
      className={`flex items-center gap-2 px-2 py-0.5 text-[10px] tabular-nums [-webkit-app-region:no-drag] hover:bg-surface/60 border border-transparent ${
        open ? 'bg-surface border-border' : ''
      }`}
    >
      <span className={textClass}>
        heap {formatBytes(current.heapUsed)} / {formatBytes(current.heapLimit)}
      </span>
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        className="overflow-visible"
        aria-hidden="true"
      >
        {window.length > 1 ? (
          <polyline
            points={points}
            fill="none"
            stroke={stroke}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      <span className="text-muted">rss {formatBytes(current.rss)}</span>
    </button>
  )
}
