import { useMemo } from 'react'

import type { SystemPerformanceStats } from '@shared/performance/types'

// Popover dimensions — mirror PerformancePanel's outer chrome so
// the two diagnostic surfaces look like siblings.
//
// PerformancePanel uses w-[430px] / mt-1 / shadow-xl / right-0
// top-full. We match those exactly. The INNER layout is different
// (one chart + a few summary numbers vs. PerformancePanel's
// per-pane grid) because the source data is different — system
// perf is a small handful of numbers across time, not a list of
// agents.
const POPOVER_WIDTH_CLASS = 'w-[430px] max-w-[calc(100vw-24px)]'

// Chart geometry inside the popover. Width is the popover content
// width minus padding; height is chosen to give the two series
// (heapUsed + rss) enough vertical separation to read without
// dominating the popover.
const CHART_WIDTH = 398 // 430 - 2*16 padding
const CHART_HEIGHT = 140
const CHART_PAD_TOP = 8
const CHART_PAD_BOTTOM = 16

// "1.23 GB" / "456 MB" — duplicated from SystemPerfBadge so the
// popover doesn't import from a UI sibling. Keeping the helper
// local also means we can change one's formatting without
// accidentally shifting the other (the badge is space-constrained
// in the header; the popover has room for more precision).
function formatBytes(bytes: number, fractionDigits = 2): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(fractionDigits)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}

// Growth rate: bytes/sec over the last `seconds` window. Returns
// positive for growth, negative for shrinkage, null if there's
// not enough buffer to span the window.
//
// WHY a linear "first vs. last" estimate (not a regression):
// curve-fitting buys nothing for an OOM-debug UI. The user wants
// to know "am I leaking?" — and a 60-second delta answers that
// without code that future-me has to puzzle over.
function growthBytesPerSec(
  buffer: SystemPerformanceStats[],
  field: 'heapUsed' | 'rss',
  seconds: number,
): number | null {
  if (buffer.length < 2) return null
  const last = buffer[buffer.length - 1]
  if (!last) return null
  const cutoff = last.sampledAt - seconds * 1000
  // Find the oldest sample that's still within the window.
  let firstIdx = 0
  for (let i = buffer.length - 2; i >= 0; i--) {
    const s = buffer[i]
    if (!s) break
    if (s.sampledAt < cutoff) {
      firstIdx = i + 1
      break
    }
  }
  const first = buffer[firstIdx]
  if (!first || first === last) return null
  const dt = (last.sampledAt - first.sampledAt) / 1000
  if (dt <= 0) return null
  return (last[field] - first[field]) / dt
}

function formatGrowth(bps: number | null): string {
  if (bps === null) return '—'
  const sign = bps >= 0 ? '+' : '−'
  const magnitude = Math.abs(bps)
  if (magnitude >= 1e6) return `${sign}${(magnitude / 1e6).toFixed(1)} MB/s`
  if (magnitude >= 1e3) return `${sign}${(magnitude / 1e3).toFixed(0)} KB/s`
  return `${sign}${magnitude.toFixed(0)} B/s`
}

type Props = {
  open: boolean
  current: SystemPerformanceStats | null
  buffer: SystemPerformanceStats[]
}

// Expanded "what's in the buffer" view. Mirrors PerformancePanel's
// positioning so the two telemetry surfaces feel related — same
// width, same border / bg / shadow / z, same right-anchored
// drop-down.
export function SystemPerfPopover({ open, current, buffer }: Props) {
  // Hooks must run unconditionally. We compute the chart geometry
  // regardless of `open`, then bail. The work is trivial (one map
  // over 600 numbers at most) and skipping the hook would change
  // the hook count between renders.
  const chart = useMemo(() => {
    if (buffer.length < 2 || !current) {
      return { heapPoints: '', rssPoints: '', heapCapY: CHART_PAD_TOP }
    }
    // Y scale: max of (heapLimit, peak rss in window). Anchoring to
    // heapLimit keeps the cap line visible at 100% of the heap
    // axis, while letting RSS exceed heap (which it usually does
    // because RSS includes native + ArrayBuffer + everything else)
    // by extending the upper bound to whichever is larger.
    const peakRss = buffer.reduce(
      (m, s) => (s.rss > m ? s.rss : m),
      0,
    )
    const yMax = Math.max(current.heapLimit, peakRss)
    if (yMax <= 0) {
      return { heapPoints: '', rssPoints: '', heapCapY: CHART_PAD_TOP }
    }
    const chartInner = CHART_HEIGHT - CHART_PAD_TOP - CHART_PAD_BOTTOM
    const project = (value: number) => {
      const ratio = Math.min(1, value / yMax)
      return CHART_HEIGHT - CHART_PAD_BOTTOM - ratio * chartInner
    }
    const heapPoints = buffer
      .map((s, i) => {
        const x = (i / Math.max(1, buffer.length - 1)) * CHART_WIDTH
        return `${x.toFixed(1)},${project(s.heapUsed).toFixed(1)}`
      })
      .join(' ')
    const rssPoints = buffer
      .map((s, i) => {
        const x = (i / Math.max(1, buffer.length - 1)) * CHART_WIDTH
        return `${x.toFixed(1)},${project(s.rss).toFixed(1)}`
      })
      .join(' ')
    return { heapPoints, rssPoints, heapCapY: project(current.heapLimit) }
  }, [buffer, current])

  if (!open || !current) return null

  // Peak heap in the buffered window: surfaced because a single
  // current reading doesn't tell you whether you've been higher
  // earlier. If peak is well above current, you've seen growth +
  // GC; if peak ≈ current, growth is monotonic and concerning.
  const peakHeap = buffer.reduce((m, s) => (s.heapUsed > m ? s.heapUsed : m), 0)
  const peakRss = buffer.reduce((m, s) => (s.rss > m ? s.rss : m), 0)

  const heapGrowth = growthBytesPerSec(buffer, 'heapUsed', 60)
  const rssGrowth = growthBytesPerSec(buffer, 'rss', 60)

  const windowSeconds = buffer.length > 1
    ? Math.round(((buffer[buffer.length - 1]?.sampledAt ?? 0) - (buffer[0]?.sampledAt ?? 0)) / 1000)
    : 0

  return (
    <div className="relative [-webkit-app-region:no-drag]">
      <div
        className={`absolute right-0 top-full mt-1 ${POPOVER_WIDTH_CLASS} border border-border bg-surface shadow-xl z-50`}
      >
        <div className="grid grid-cols-[60px_1fr_1fr] gap-2 px-3 py-1.5 border-b border-border text-[9px] uppercase text-muted">
          <span>metric</span>
          <span>current</span>
          <span>peak · Δ60s</span>
        </div>
        <div className="px-3 py-2 text-[10px] tabular-nums">
          <div className="grid grid-cols-[60px_1fr_1fr] gap-2 py-0.5">
            <span className="font-semibold text-ink">heap</span>
            <span>
              {formatBytes(current.heapUsed)} /{' '}
              <span className="text-muted">{formatBytes(current.heapLimit)}</span>
            </span>
            <span>
              {formatBytes(peakHeap)} ·{' '}
              <span className={heapGrowth !== null && heapGrowth > 0 ? 'text-amber-400' : ''}>
                {formatGrowth(heapGrowth)}
              </span>
            </span>
          </div>
          <div className="grid grid-cols-[60px_1fr_1fr] gap-2 py-0.5">
            <span className="font-semibold text-ink">rss</span>
            <span>{formatBytes(current.rss)}</span>
            <span>
              {formatBytes(peakRss)} ·{' '}
              <span className={rssGrowth !== null && rssGrowth > 0 ? 'text-amber-400' : ''}>
                {formatGrowth(rssGrowth)}
              </span>
            </span>
          </div>
          <div className="grid grid-cols-[60px_1fr_1fr] gap-2 py-0.5">
            <span className="font-semibold text-ink">native</span>
            <span>{formatBytes(current.external)} ext</span>
            <span>{formatBytes(current.arrayBuffers)} buffers</span>
          </div>
        </div>
        <div className="border-t border-border px-3 py-2">
          <div className="flex items-baseline justify-between text-[9px] uppercase text-muted mb-1">
            <span>last {windowSeconds}s</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-emerald-400" />
                heap
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-sky-400" />
                rss
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-px bg-red-400" />
                cap
              </span>
            </span>
          </div>
          <svg
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className="overflow-visible"
            aria-label="Heap and RSS over time"
          >
            {/* heap-cap reference line — sits at 100% of the heap
                axis (or below if RSS is the y-axis ceiling). Dashed
                so it visually separates from the live series. */}
            <line
              x1={0}
              x2={CHART_WIDTH}
              y1={chart.heapCapY}
              y2={chart.heapCapY}
              stroke="#f87171"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            {chart.rssPoints ? (
              <polyline
                points={chart.rssPoints}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={1.25}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {chart.heapPoints ? (
              <polyline
                points={chart.heapPoints}
                fill="none"
                stroke="#34d399"
                strokeWidth={1.25}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
          </svg>
        </div>
      </div>
    </div>
  )
}
