export type PerformanceProcess = 'main' | 'renderer' | 'preload'

export type PerformanceRecordKind =
  | 'mark'
  | 'span_start'
  | 'span_end'
  | 'metric'
  | 'error'

export type PerformanceLevel = 'info' | 'debug' | 'warn' | 'error'

export type PerformanceMetricType = 'counter' | 'gauge' | 'sample'

export type PerformanceConfig = {
  enabled: boolean
  verbose: boolean
  slowSpanMs: number
  runId: string | null
  runDir: string | null
}

export type PerformanceRecord = {
  kind: PerformanceRecordKind
  process: PerformanceProcess
  area: string
  name: string
  ts?: number
  tsIso?: string
  monotonicMs?: number
  runId?: string
  level?: PerformanceLevel
  spanId?: string
  parentSpanId?: string
  durationMs?: number
  metricType?: PerformanceMetricType
  value?: number
  unit?: string
  sessionId?: string
  tabId?: string
  provider?: string
  count?: number
  data?: Record<string, unknown>
  error?: {
    name?: string
    message: string
    stack?: string
  }
}

export type PerformanceSnapshot = {
  runId: string | null
  runDir: string | null
  files: Array<{ name: string; content: string }>
}

export type PanePerformanceStats = {
  sessionId: string
  kind: 'claude' | 'codex' | 'terminal'
  status: 'running' | 'idle' | 'exited' | 'unknown'
  rootPid: number | null
  cpuPercent: number | null
  memoryBytes: number | null
  childCount: number
  lastActivityAt: number | null
  sampledAt: number
}

export type PanePerformanceSnapshot = {
  enabled: boolean
  sampledAt: number
  panes: PanePerformanceStats[]
}

// Main-process snapshot powering the always-visible header badge.
//
// WHY a NEW type rather than extending PerformanceSnapshot or
// PanePerformanceSnapshot:
//
// - PerformanceSnapshot returns ON-DISK log files (large, infrequent
//   IO) — wrong shape for the 1 Hz header poll.
// - PanePerformanceSnapshot describes PER-AGENT processes (cpu /
//   memory / status for sessionIds) — that's agent perf, not main-
//   process perf. The header strip is intentionally NOT per-agent;
//   the OOM crashes we're chasing happen in the Electron main
//   process, not in agent subprocesses.
//
// The fields below are deliberately the v8/process numbers a v8
// fatal-error log reports, in the same units. `heapUsed` is the
// number the OOM crash header prints; `heapLimit` is what v8 will
// crash AT (typically 4 GiB on macOS, but observed lower in
// production — see heapWatchdog.ts for the empirical note). `rss`
// captures native-side allocations (Buffers, native modules) that
// v8 heap numbers DO NOT show — the 2026-05-11 OOM had Rust frames
// and a Buffer::New in the crash stack, exactly the kind of growth
// v8 heap alone misses.
export type SystemPerformanceStats = {
  /** Mirrors PerformanceConfig.enabled — controls whether telemetry
   *  is on. The header badge renders only when enabled === true. */
  enabled: boolean
  /** Wall-clock ms when the sample was taken. Used to plot the
   *  buffered series with real timestamps. */
  sampledAt: number
  /** v8 used_heap_size in bytes — the number v8's fatal-error log
   *  reports as "heap used". Source of truth for the color zone. */
  heapUsed: number
  /** v8 total_heap_size — committed heap. Often larger than used due
   *  to internal fragmentation; surfaced for the expanded popover. */
  heapTotal: number
  /** v8 heap_size_limit — the cap v8 will OOM at. Used as the
   *  denominator for the green/yellow/red zones. Measured at
   *  runtime because Electron varies this across dev/prod launches. */
  heapLimit: number
  /** process.memoryUsage().rss — resident set size. Catches native
   *  growth (Buffers, native modules) that the v8 heap doesn't
   *  reflect. No fixed ceiling, hence no zone color. */
  rss: number
  /** process.memoryUsage().external — memory used by C++ objects
   *  bound to JS objects. Component of RSS but split out so the
   *  popover can surface "is this a native leak or a JS leak?". */
  external: number
  /** process.memoryUsage().arrayBuffers — ArrayBuffer-backed
   *  allocations. The Buffer::New in the OOM crash points here. */
  arrayBuffers: number
}
