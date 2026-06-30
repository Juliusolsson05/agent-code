import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { arch, platform } from 'os'
import { pid, versions } from 'process'

import type {
  PerformanceConfig,
  PanePerformanceStats,
  PerformanceRecord,
  PerformanceSnapshot,
} from '@shared/performance/types.js'
import {
  ensurePerformanceRunDir,
  queuePerformanceAppend,
  readPerformanceTail,
  writePerformanceManifest,
  type PerformanceLogFile,
} from '@main/storage/performanceLog.js'
import { LocalJsonlSpanExporter } from '@main/performance/LocalJsonlSpanExporter.js'
import { getAppRunId } from '@main/incident/appRunIds.js'
import { APP_SLUG } from '@shared/appIdentity.js'
// Privacy-sensitive sanitizer + error/area helpers are shared with the renderer
// client so the redaction rule is single-sourced. See
// @shared/performance/serialization for the invariants.
import {
  serializePerformanceError,
  sanitizePerformanceData,
  areaFromPerformanceName,
} from '@shared/performance/serialization.js'

const DEFAULT_SLOW_SPAN_MS = 50
const FLUSH_INTERVAL_MS = 500
const SAMPLE_INTERVAL_MS = 5000
const MAX_PENDING_RECORDS = 2000

function envFlag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes'
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function runFolderName(now: Date, pidValue: number): string {
  const stamp = now.toISOString().replace(/\..+$/, '').replace(/:/g, '-')
  return `${stamp}-main-${pidValue}`
}

// Thin process-local aliases over the shared helpers — keep the existing call
// sites untouched while the logic lives once in @shared/performance/serialization.
const serializeError = serializePerformanceError
const sanitizeData = (
  data: Record<string, unknown> | undefined,
  verbose: boolean,
): Record<string, unknown> | undefined => sanitizePerformanceData(data, { verbose })
// Main's area fallback is 'app'.
const areaFromName = (name: string): string => areaFromPerformanceName(name, 'app')

function recordFile(record: PerformanceRecord): PerformanceLogFile {
  if (record.kind === 'metric') return 'metrics'
  if (record.kind === 'error') return 'errors'
  return 'events'
}

export class PerformanceService {
  private readonly enabled = envFlag('AGENT_CODE_PERF')
  private readonly verbose = envFlag('AGENT_CODE_PERF_VERBOSE')
  private readonly slowSpanMs = envNumber('AGENT_CODE_PERF_SLOW_MS', DEFAULT_SLOW_SPAN_MS)
  // Share the canonical app run id (getAppRunId) instead of minting a second,
  // unrelated one. When perf is enabled this is the SAME id AppRunJournal
  // records, so perf runs, incidents, and (later) heap snapshots / debug bundles
  // all correlate by one key. Still null when disabled, so every gate that keys
  // off `runId === null` behaves exactly as before this change.
  private readonly runId = this.enabled ? getAppRunId() : null
  private runDir: string | null = null
  private tracerProvider: NodeTracerProvider | null = null
  private tracer = trace.getTracer(`${APP_SLUG}-main`)
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null
  private pending: PerformanceRecord[] = []
  private droppedPendingRecords = 0

  getConfig(): PerformanceConfig {
    return {
      enabled: this.enabled,
      verbose: this.verbose,
      slowSpanMs: this.slowSpanMs,
      runId: this.runId,
      runDir: this.runDir,
    }
  }

  async start(): Promise<void> {
    if (!this.enabled || this.runDir) return
    const startedAt = new Date()
    this.runDir = await ensurePerformanceRunDir(runFolderName(startedAt, pid))
    this.tracerProvider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': APP_SLUG,
        'service.namespace': 'desktop',
        'process.runtime.name': 'electron-main',
        'process.pid': pid,
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new LocalJsonlSpanExporter(this.runDir, this.slowSpanMs),
          {
            scheduledDelayMillis: FLUSH_INTERVAL_MS,
            maxExportBatchSize: 128,
            maxQueueSize: 2048,
          },
        ),
      ],
    })
    this.tracerProvider.register()
    this.tracer = trace.getTracer(`${APP_SLUG}-main`)

    await writePerformanceManifest(this.runDir, {
      schemaVersion: 2,
      tracing: 'opentelemetry',
      runId: this.runId,
      startedAt: startedAt.getTime(),
      startedAtIso: startedAt.toISOString(),
      pid,
      platform: platform(),
      arch: arch(),
      node: versions.node,
      electron: versions.electron,
      chrome: versions.chrome,
      env: {
        AGENT_CODE_PERF: process.env.AGENT_CODE_PERF ?? null,
        AGENT_CODE_PERF_VERBOSE: process.env.AGENT_CODE_PERF_VERBOSE ?? null,
        AGENT_CODE_PERF_SLOW_MS: process.env.AGENT_CODE_PERF_SLOW_MS ?? null,
      },
    })
    this.startFlushTimer()
    this.startProbes()
    this.mark('app.main.performance.started')
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.sampleTimer) clearInterval(this.sampleTimer)
    this.flushTimer = null
    this.sampleTimer = null
    this.eventLoopDelay?.disable()
    this.eventLoopDelay = null
    void this.flush()
    void this.tracerProvider?.shutdown()
  }

  mark(name: string, data?: Record<string, unknown>): void {
    this.record({
      kind: 'mark',
      process: 'main',
      area: areaFromName(name),
      name,
      data,
    })
  }

  metric(
    name: string,
    value: number,
    metricType: 'counter' | 'gauge' | 'sample' = 'sample',
    data?: Record<string, unknown>,
  ): void {
    this.record({
      kind: 'metric',
      process: 'main',
      area: areaFromName(name),
      name,
      metricType,
      value,
      data,
    })
  }

  error(name: string, error: unknown, data?: Record<string, unknown>): void {
    this.record({
      kind: 'error',
      process: 'main',
      area: areaFromName(name),
      name,
      level: 'error',
      error: serializeError(error),
      data,
    })
  }

  recordBatch(records: PerformanceRecord[]): void {
    if (!this.enabled || records.length === 0) return
    for (const record of records) this.record(record)
  }

  record(input: PerformanceRecord): void {
    if (!this.enabled) return
    if (input.kind === 'span_end') {
      this.recordSpan(input)
      return
    }
    if (input.kind === 'span_start') return
    const ts = input.ts ?? Date.now()
    const record: PerformanceRecord = {
      ...input,
      ts,
      tsIso: input.tsIso ?? new Date(ts).toISOString(),
      monotonicMs: input.monotonicMs ?? performance.now(),
      runId: input.runId ?? this.runId ?? undefined,
      data: sanitizeData(input.data, this.verbose),
    }
    if (this.pending.length >= MAX_PENDING_RECORDS) {
      // WHY drop oldest instead of letting this array grow: performance mode is
      // commonly enabled while the app is already sick. If disk or OTel export
      // stalls, an unbounded diagnostics queue becomes part of the incident and
      // can push main into the same OOM class it is supposed to explain. Keeping
      // the newest records preserves the most relevant tail of the failure.
      this.pending.shift()
      this.droppedPendingRecords++
    }
    this.pending.push(record)
  }

  span(name: string, attributes?: Record<string, unknown>) {
    if (!this.enabled) {
      return {
        end() {},
        fail() {},
      }
    }
    const span = this.tracer.startSpan(name, {
      attributes: toAttributes(sanitizeData(attributes, this.verbose)),
    })
    return {
      end: (endAttributes?: Record<string, unknown>) => {
        const attrs = toAttributes(sanitizeData(endAttributes, this.verbose))
        if (attrs) span.setAttributes(attrs)
        span.end()
      },
      fail: (err: unknown, endAttributes?: Record<string, unknown>) => {
        const attrs = toAttributes(sanitizeData(endAttributes, this.verbose))
        if (attrs) span.setAttributes(attrs)
        span.recordException(err instanceof Error ? err : String(err))
        span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as Error)?.message ?? err) })
        span.end()
      },
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.runDir) return
    const batch = this.pending
    this.pending = []
    const dropped = this.droppedPendingRecords
    this.droppedPendingRecords = 0
    if (dropped > 0) {
      const ts = Date.now()
      batch.push({
        kind: 'metric',
        process: 'main',
        area: 'performance.dropped',
        name: 'performance.pending.dropped',
        metricType: 'counter',
        value: dropped,
        ts,
        tsIso: new Date(ts).toISOString(),
        monotonicMs: performance.now(),
        runId: this.runId ?? undefined,
      })
    }
    const grouped = new Map<PerformanceLogFile, string[]>()
    for (const record of batch) {
      const file = recordFile(record)
      const lines = grouped.get(file) ?? []
      lines.push(JSON.stringify(record))
      grouped.set(file, lines)
    }
    await Promise.all([
      ...[...grouped.entries()].map(([file, lines]) =>
        queuePerformanceAppend(this.runDir!, file, lines),
      ),
      this.tracerProvider?.forceFlush() ?? Promise.resolve(),
    ])
  }

  async snapshot(): Promise<PerformanceSnapshot> {
    if (!this.enabled || !this.runDir) {
      return { runId: this.runId, runDir: this.runDir, files: [] }
    }
    await this.flush()
    const files = await Promise.all(
      (['events', 'spans', 'metrics', 'errors', 'slow', 'pane-process'] as PerformanceLogFile[]).map(
        async file => ({
          name: `performance/${file}-tail.jsonl`,
          content: await readPerformanceTail(this.runDir!, file),
        }),
      ),
    )
    return {
      runId: this.runId,
      runDir: this.runDir,
      files,
    }
  }

  async recordPaneProcessStats(stats: PanePerformanceStats[]): Promise<void> {
    if (!this.enabled || !this.runDir || stats.length === 0) return
    await queuePerformanceAppend(
      this.runDir,
      'pane-process',
      stats.map(stat => JSON.stringify(stat)),
    )
  }

  private recordSpan(input: PerformanceRecord): void {
    const durationMs = input.durationMs ?? 0
    const endTime = input.ts ?? Date.now()
    const startTime = Math.max(0, endTime - durationMs)
    const span = this.tracer.startSpan(input.name, {
      startTime,
      attributes: toAttributes({
        ...sanitizeData(input.data, this.verbose),
        'cc.process': input.process,
        'cc.area': input.area,
        ...(input.sessionId ? { 'cc.session_id': input.sessionId } : {}),
        ...(input.tabId ? { 'cc.tab_id': input.tabId } : {}),
        ...(input.provider ? { 'cc.provider': input.provider } : {}),
      }),
    })
    if (input.error) {
      span.recordException(input.error.message)
      span.setStatus({ code: SpanStatusCode.ERROR, message: input.error.message })
    }
    span.end(endTime)
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush().catch(err => {
        console.warn('[performance] flush failed:', err)
      })
    }, FLUSH_INTERVAL_MS)
    this.flushTimer.unref?.()
  }

  // NOTE on the deliberate overlap with AppRunJournal's heartbeat: both this
  // probe loop and the journal's heartbeat sample the event loop + memory every
  // 5s. That overlap exists ONLY when AGENT_CODE_PERF is enabled — in normal
  // always-on runs the perf service never starts, so only the journal samples.
  // The two feed different sinks (OTel metrics here vs. the always-on
  // heartbeat.json there), so we keep both rather than coupling the heavy OTel
  // pipeline to the always-on spine for the sake of one extra timer in dev/perf
  // sessions. Run identity is already unified (see runId); the sampler dedup is
  // intentionally NOT done here.
  private startProbes(): void {
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
    this.eventLoopDelay.enable()
    this.sampleTimer = setInterval(() => {
      const memory = process.memoryUsage()
      this.metric('main.memory.rss', memory.rss, 'gauge', { heapUsed: memory.heapUsed })
      if (this.eventLoopDelay) {
        this.metric('main.eventLoop.delay.mean', this.eventLoopDelay.mean / 1e6, 'sample', {
          maxMs: this.eventLoopDelay.max / 1e6,
          p99Ms: this.eventLoopDelay.percentile(99) / 1e6,
        })
        this.eventLoopDelay.reset()
      }
    }, SAMPLE_INTERVAL_MS)
    this.sampleTimer.unref?.()
  }
}

function toAttributes(data: Record<string, unknown> | undefined): Attributes | undefined {
  if (!data) return undefined
  const out: Attributes = {}
  for (const [key, value] of Object.entries(data)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value
    } else if (value == null) {
      continue
    } else {
      out[key] = JSON.stringify(value)
    }
  }
  return out
}

export const performanceService = new PerformanceService()
