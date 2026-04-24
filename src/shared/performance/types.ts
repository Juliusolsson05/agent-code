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
