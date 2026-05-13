import { useMemo, useState } from 'react'

import type { HeapSpaceStats, SystemPerformanceStats } from '@shared/performance/types'
import { formatBytes } from '@renderer/features/system-perf/formatBytes'

// Popover dimensions — wider than PerformancePanel because we now
// pack the heap-space breakdown, stress signals, renderer heap, and
// the snapshot button below the chart. Capped at viewport-24 so it
// still fits on a 1280-wide window without horizontal clipping.
//
// PerformancePanel uses w-[430px]. Going to 520 here is deliberate:
// the two diagnostics live next to each other in the header, but
// the system-perf popover does more work and benefits from more
// horizontal room for the heap-space rows (each row needs name +
// used + size + proportional bar). The visual mismatch is small
// because both popovers anchor to the right edge of the header.
const POPOVER_WIDTH_CLASS = 'w-[520px] max-w-[calc(100vw-24px)]'

// Chart geometry inside the popover. Width tracks the popover
// content width minus padding; height stays at 140 so the chart
// doesn't dominate the popover now that more sections live below.
const CHART_WIDTH = 488 // 520 - 2*16 padding
const CHART_HEIGHT = 140
const CHART_PAD_TOP = 8
const CHART_PAD_BOTTOM = 16

// Heap-space rows shown in the breakdown table. The popover never
// renders the bottom-of-list spaces (e.g. read_only_space — fixed
// size, never the cause of growth) at the cost of hiding them
// entirely from this view. If you need them, capture a snapshot.
const HEAP_SPACES_TO_SHOW = 6


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

// Format the snake_case v8 names so they read naturally in the UI
// without forcing the user to know what `large_object_space` is.
//
// WHY we don't try to localize or explain each space: the names are
// stable v8 internals — knowing them is part of the contract for
// reading this surface. Removing the underscores is the most we
// should do. Future tooltips can add definitions if we feel the gap.
function prettySpaceName(name: string): string {
  return name.replace(/_/g, ' ')
}

// Color the event-loop p99 number by lag severity.
//
//  - < 16 ms is a smooth frame (the renderer is at 60 fps, which
//    means a 16.6 ms budget per frame). Below this, the main thread
//    is fine.
//  - 16-50 ms is a "noticeable" stall — the user might feel a janky
//    interaction but won't drop everything.
//  - > 50 ms is bad — at 100 ms+ the user definitely feels the app
//    "freezing." GC pauses, sync IO, or heavy CPU bursts produce
//    these.
//
// Thresholds are heuristic; tune if user reports diverge from them.
function eventLoopClass(ms: number): string {
  if (ms >= 50) return 'text-red-400'
  if (ms >= 16) return 'text-amber-400'
  return 'text-emerald-400'
}

// Snapshot capture state. Local-only to the popover — no reason to
// promote to uiShell since the capture flow is self-contained and
// any future "captures captured this run" listing would belong in a
// dedicated debug surface, not the header popover.
type SnapshotState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; path: string }
  | { kind: 'error'; message: string }

type Props = {
  open: boolean
  current: SystemPerformanceStats | null
  buffer: SystemPerformanceStats[]
}

// Expanded "what's in the buffer" view. Anchored right under the
// badge so the chart axes align with where the user just clicked.
export function SystemPerfPopover({ open, current, buffer }: Props) {
  const [snapshot, setSnapshot] = useState<SnapshotState>({ kind: 'idle' })

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

  // Heap-space rows. We sort by used size descending so the biggest
  // spaces show first — that's what the user wants to see when the
  // popover opens. `read_only_space` etc. fall off the bottom; if
  // you need them, capture a snapshot.
  const spacesByUsed: HeapSpaceStats[] = [...(current.heapSpaces ?? [])]
    .sort((a, b) => b.spaceUsedSize - a.spaceUsedSize)
    .slice(0, HEAP_SPACES_TO_SHOW)
  const totalUsedForBars = spacesByUsed.reduce(
    (m, s) => m + s.spaceUsedSize,
    0,
  )

  const handleCapture = async () => {
    setSnapshot({ kind: 'pending' })
    try {
      const result = await window.api.writeHeapSnapshot()
      if (result.ok) {
        setSnapshot({ kind: 'success', path: result.path })
      } else {
        setSnapshot({ kind: 'error', message: result.error })
      }
    } catch (err) {
      setSnapshot({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleReveal = () => {
    if (snapshot.kind !== 'success') return
    void window.api.revealPath(snapshot.path)
  }

  return (
    <div className="relative [-webkit-app-region:no-drag]">
      <div
        className={`absolute right-0 top-full mt-1 ${POPOVER_WIDTH_CLASS} border border-border bg-surface shadow-xl z-50`}
      >
        {/* Top headline: current/peak/Δ60s for heap, rss, native. Same
            shape as before — this is the at-a-glance "are we OK?". */}
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

        {/* Chart: heap + rss over the buffered window, with heap-cap
            reference. Single visual; per-space and stress numbers go
            in the tables below. */}
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

        {/* Heap-space breakdown.
            WHY this section: the chart answers "is heap growing?"
            but not "WHICH space?". old_space rising = retention (the
            thing you actually care about); new_space rising = high
            churn but typically not a leak; large_object_space rising
            = giant buffers/strings (often the actual smoking gun on
            agent-heavy workflows). We show six spaces, sorted by
            used size, with a proportional bar so the relative
            magnitudes are visible at a glance. */}
        {spacesByUsed.length > 0 ? (
          <div className="border-t border-border px-3 py-2">
            <div className="text-[9px] uppercase text-muted mb-1">heap spaces</div>
            <div className="space-y-0.5 text-[10px] tabular-nums">
              {spacesByUsed.map(space => {
                const widthPct =
                  totalUsedForBars > 0
                    ? Math.max(2, (space.spaceUsedSize / totalUsedForBars) * 100)
                    : 0
                return (
                  <div
                    key={space.spaceName}
                    className="grid grid-cols-[120px_1fr_70px_70px] gap-2 items-center"
                  >
                    <span className="text-ink">{prettySpaceName(space.spaceName)}</span>
                    <span className="bg-surface-hi h-1.5 relative">
                      <span
                        className="absolute left-0 top-0 bottom-0 bg-emerald-400/60"
                        style={{ width: `${widthPct}%` }}
                      />
                    </span>
                    <span className="text-right">{formatBytes(space.spaceUsedSize, 1)}</span>
                    <span className="text-right text-muted">
                      / {formatBytes(space.spaceSize, 1)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* Stress signals — the three numbers that are the closest
            thing to a leak diagnosis without a snapshot.
            WHY each one matters is documented at the type level
            (HeapSpaceStats / SystemPerformanceStats in shared); the
            UI's job is to surface them with strong color when they
            disagree with the "healthy" expectation:
              - detached contexts: 0 in steady state, red if not.
              - native contexts: ~1 per BrowserWindow.
              - event-loop p99: < 16 ms ideal, > 50 ms is a stall.
        */}
        <div className="border-t border-border px-3 py-2 grid grid-cols-3 gap-2 text-[10px] tabular-nums">
          <div>
            <div className="text-[9px] uppercase text-muted">detached ctx</div>
            <div
              className={
                current.detachedContexts > 0
                  ? 'font-semibold text-red-400'
                  : 'text-emerald-400'
              }
            >
              {current.detachedContexts}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-muted">native ctx</div>
            <div className={current.nativeContexts > 5 ? 'text-amber-400' : ''}>
              {current.nativeContexts}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-muted">event loop p99</div>
            <div
              className={
                current.eventLoopDelay
                  ? eventLoopClass(current.eventLoopDelay.p99Ms)
                  : 'text-muted'
              }
            >
              {current.eventLoopDelay
                ? `${current.eventLoopDelay.p99Ms.toFixed(1)} ms`
                : '—'}
            </div>
          </div>
        </div>

        {/* Renderer heap. WHY a separate section instead of folding
            into the headline grid: the values are from a different
            process (Chromium renderer) so mixing them with main-
            process numbers above invites the wrong mental model
            ("why are these the same numbers twice with different
            values?"). Keeping them separate makes the
            cross-process distinction explicit. */}
        {current.rendererHeap ? (
          <div className="border-t border-border px-3 py-2">
            <div className="text-[9px] uppercase text-muted mb-1">renderer heap</div>
            <div className="grid grid-cols-3 gap-2 text-[10px] tabular-nums">
              <div>
                <div className="text-[9px] uppercase text-muted">used</div>
                <div>{formatBytes(current.rendererHeap.usedJSHeapSize)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-muted">committed</div>
                <div>{formatBytes(current.rendererHeap.totalJSHeapSize)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase text-muted">limit</div>
                <div className="text-muted">
                  {formatBytes(current.rendererHeap.jsHeapSizeLimit)}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Snapshot capture button.
            WHY a button (not auto): writeHeapSnapshot is multi-second
            STW and writes 100MB-3GB to disk. It MUST be user-initiated.
            WHY four discrete states: pending/success/error all need
            different affordances — pending shows the user we're
            working, success offers a reveal, error tells them what
            broke. Folding into a single message-only state hides the
            "reveal" affordance which is the entire point of the
            success state. */}
        <div className="border-t border-border px-3 py-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCapture()}
            disabled={snapshot.kind === 'pending'}
            className="px-2 py-1 text-[10px] border border-border bg-surface-hi hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {snapshot.kind === 'pending' ? 'capturing…' : 'capture heap snapshot'}
          </button>
          {snapshot.kind === 'success' ? (
            <button
              type="button"
              onClick={handleReveal}
              className="px-2 py-1 text-[10px] border border-emerald-400/40 text-emerald-400 hover:bg-surface"
              title={snapshot.path}
            >
              reveal in Finder
            </button>
          ) : null}
          {snapshot.kind === 'error' ? (
            <span className="text-[10px] text-red-400" title={snapshot.message}>
              {snapshot.message}
            </span>
          ) : null}
          {snapshot.kind === 'idle' ? (
            <span className="text-[9px] text-muted">
              writes a .heapsnapshot · load in Chrome DevTools Memory tab
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
