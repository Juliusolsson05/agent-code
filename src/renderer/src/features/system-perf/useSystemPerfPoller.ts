import { useEffect, useState } from 'react'

import type { SystemPerformanceStats } from '@shared/performance/types'

// Ring-buffer length for the in-renderer history.
//
// 600 samples × 1 Hz = 10 minutes of data. Chosen because:
// - The 2026-05-11 OOM grew from ~600 MB → 2.7 GB over roughly 4
//   hours, so a 10-minute window is enough to see meaningful growth
//   trajectory in the sparkline without burying short-lived spikes.
// - 600 numbers × ~80 bytes per object is ~50 KB of renderer memory.
//   Trivially cheap. Keeping the buffer longer (e.g. 1 hour) starts
//   to argue for a downsampling strategy; this size keeps the math
//   embarrassingly simple.
// - SVG polylines with 600 points render fine; longer series start
//   to be noticeable in DevTools paint profiles.
const BUFFER_CAPACITY = 600

// Poll cadence for the header badge.
//
// 1 Hz is the lowest interesting rate for a near-realtime OOM
// indicator. The IPC roundtrip is sub-millisecond
// (process.memoryUsage + v8.getHeapStatistics) and the renderer
// re-renders only the badge subtree, so we don't pay enough to
// justify a slower rate. Faster (e.g. 250 ms) would only matter for
// catching second-scale spikes which v8 fatal-error logs already
// preserve via the GC traces.
const POLL_INTERVAL_MS = 1000

export type SystemPerfPollerState = {
  // null until the first probe completes; thereafter true if
  // AGENT_CODE_PERF gating allows polling, false if it does not.
  // The badge component renders nothing in either null or false
  // state — see SystemPerfHeader.
  enabled: boolean | null
  current: SystemPerformanceStats | null
  // Append-only series, capped at BUFFER_CAPACITY. Oldest samples
  // are dropped from the front when the cap is reached.
  buffer: SystemPerformanceStats[]
}

const INITIAL_STATE: SystemPerfPollerState = {
  enabled: null,
  current: null,
  buffer: [],
}

// One-shot probe + 1 Hz polling loop driving the header badge.
//
// WHY a hook (not a store): there's exactly one consumer pair
// (SystemPerfBadge + SystemPerfPopover, mounted under a single
// SystemPerfHeader). Keeping state local avoids growing the
// uiShell slice with telemetry-only fields and keeps the poller's
// lifecycle tied to the header's mount, which mirrors how
// PerformancePanel manages its own polling (see
// PerformancePanel.tsx — useEffect-owned setInterval).
//
// WHY probe first, then start the interval: when AGENT_CODE_PERF is
// off, the badge does not render. We want exactly zero recurring
// work in that case — no setInterval, no allocation churn. The
// first tick decides whether to schedule subsequent ticks.
export function useSystemPerfPoller(): SystemPerfPollerState {
  const [state, setState] = useState<SystemPerfPollerState>(INITIAL_STATE)

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const tick = async () => {
      try {
        const mainStats = await window.api.getSystemPerformanceStats()
        if (cancelled) return
        if (!mainStats.enabled) {
          // Disabled: record the gate state once and stop. No
          // interval is started; if the user toggles AGENT_CODE_PERF
          // they need to restart the app, which is consistent with
          // every other place that reads the flag.
          setState(prev =>
            prev.enabled === false ? prev : { enabled: false, current: null, buffer: [] },
          )
          return
        }
        // Attach the renderer-side performance.memory reading here
        // rather than via a second IPC roundtrip. WHY: performance.memory
        // is a renderer-local Chromium API — it returns the JS heap
        // numbers for THIS process, which is the renderer. Asking main
        // to ask the renderer would just bounce twice. We snapshot it
        // synchronously so the renderer-heap reading is sampled at the
        // same wall-clock time as the main-process payload it
        // accompanies.
        const stats: SystemPerformanceStats = {
          ...mainStats,
          rendererHeap: readRendererHeap() ?? undefined,
        }
        setState(prev => {
          // Append-and-trim. Using slice + concat (not push on the
          // existing array) keeps the array reference fresh so the
          // popover's chart re-renders. The cost is one allocation
          // per tick — fine at 1 Hz with capacity 600.
          const nextBuffer =
            prev.buffer.length >= BUFFER_CAPACITY
              ? [...prev.buffer.slice(prev.buffer.length - BUFFER_CAPACITY + 1), stats]
              : [...prev.buffer, stats]
          return { enabled: true, current: stats, buffer: nextBuffer }
        })
        // Schedule subsequent ticks only after the first successful
        // probe. If the probe ever throws, we never start the
        // interval and the user sees no badge — a deliberate
        // fail-silent so the rest of the app stays usable.
        if (timer === null) {
          timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS)
        }
      } catch {
        if (!cancelled) {
          setState(prev =>
            prev.enabled === false ? prev : { enabled: false, current: null, buffer: [] },
          )
        }
      }
    }

    void tick()

    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [])

  return state
}

// window.performance.memory is a non-standard Chromium API. It exists
// in Electron's renderer process (because Electron embeds Chromium)
// but is absent in stricter environments — and TypeScript's stock lib
// does not declare it. We read it through a typed accessor that
// returns null when the API isn't present so the popover can render
// nothing (instead of zeros that would look like a 0-byte renderer).
//
// NOTE on accuracy: by default Chrome quantises this API to 100 KB
// boundaries to prevent timing attacks. Electron may or may not
// expose precise values depending on `--enable-precise-memory-info`.
// For our debug purposes the rough number is still useful — we are
// catching MB-scale growth, not byte-level deltas.
type RendererMemory = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

function readRendererHeap(): RendererMemory | null {
  const perf = (window.performance ?? null) as
    | (Performance & { memory?: RendererMemory })
    | null
  if (!perf?.memory) return null
  const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = perf.memory
  if (
    typeof usedJSHeapSize !== 'number' ||
    typeof totalJSHeapSize !== 'number' ||
    typeof jsHeapSizeLimit !== 'number'
  ) {
    return null
  }
  return { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit }
}
