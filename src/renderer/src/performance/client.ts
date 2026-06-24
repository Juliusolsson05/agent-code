import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { ExportResultCode } from '@opentelemetry/core'

import type {
  PerformanceConfig,
  PerformanceMetricType,
  PerformanceRecord,
} from '@shared/performance/types'
// Shared with main's PerformanceService so the privacy redaction rule is
// single-sourced. See @shared/performance/serialization for the invariants.
import {
  serializePerformanceError,
  sanitizePerformanceData,
  areaFromPerformanceName,
} from '@shared/performance/serialization'

const FLUSH_INTERVAL_MS = 500
const MAX_BATCH = 200

let config: PerformanceConfig = {
  enabled: false,
  verbose: false,
  slowSpanMs: 50,
  runId: null,
  runDir: null,
}
let initialized = false
let tracerProvider: BasicTracerProvider | null = null
let tracer = trace.getTracer('agent-code-renderer')
let pending: PerformanceRecord[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null

class RendererIpcSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    const records = spans.map(spanToRecord)
    window.api.appendPerformanceRecords(records)
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch(error => resultCallback({ code: ExportResultCode.FAILED, error }))
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

function spanToRecord(span: ReadableSpan): PerformanceRecord {
  const startMs = hrTimeToUnixMs(span.startTime)
  const durationMs = hrDurationToMs(span.duration)
  return {
    kind: 'span_end',
    process: 'renderer',
    area: String(span.attributes['cc.area'] ?? areaFromName(span.name)),
    name: span.name,
    ts: startMs + durationMs,
    tsIso: new Date(startMs + durationMs).toISOString(),
    monotonicMs: performance.now(),
    runId: config.runId ?? undefined,
    spanId: span.spanContext().spanId,
    durationMs,
    data: {
      traceId: span.spanContext().traceId,
      parentSpanId: span.parentSpanContext?.spanId,
      attributes: span.attributes,
      events: span.events.map(event => ({
        name: event.name,
        ts: hrTimeToUnixMs(event.time),
        attributes: event.attributes,
      })),
      status: span.status,
    },
  }
}

function hrTimeToUnixMs(hrTime: readonly [number, number]): number {
  return (hrTime[0] * 1000) + (hrTime[1] / 1e6)
}

function hrDurationToMs(hrTime: readonly [number, number]): number {
  return (hrTime[0] * 1000) + (hrTime[1] / 1e6)
}

function nowRecordBase(): Pick<PerformanceRecord, 'ts' | 'tsIso' | 'monotonicMs' | 'runId'> {
  const ts = Date.now()
  return {
    ts,
    tsIso: new Date(ts).toISOString(),
    monotonicMs: performance.now(),
    runId: config.runId ?? undefined,
  }
}

// Renderer's area fallback is 'renderer'. Verbose comes from the live module
// `config`, so sanitizeData reads it at call time (preserving prior behavior).
const areaFromName = (name: string): string => areaFromPerformanceName(name, 'renderer')

function sanitizeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  return sanitizePerformanceData(data, { verbose: config.verbose })
}

function enqueue(record: PerformanceRecord): void {
  if (!initialized || !config.enabled) return
  pending.push({
    ...nowRecordBase(),
    ...record,
    process: 'renderer',
    area: record.area || areaFromName(record.name),
    data: sanitizeData(record.data),
  })
  if (pending.length >= MAX_BATCH) void flushPerformance()
}

export async function initializePerformance(): Promise<PerformanceConfig> {
  if (initialized) return config
  try {
    config = await window.api.getPerformanceConfig()
  } catch {
    config = { ...config, enabled: false }
  }
  initialized = true
  if (config.enabled) {
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [
        new BatchSpanProcessor(new RendererIpcSpanExporter(), {
          scheduledDelayMillis: FLUSH_INTERVAL_MS,
          maxExportBatchSize: 128,
          maxQueueSize: 2048,
        }),
      ],
    })
    trace.setGlobalTracerProvider(tracerProvider)
    tracer = trace.getTracer('agent-code-renderer')
    flushTimer = setInterval(() => {
      void flushPerformance()
    }, FLUSH_INTERVAL_MS)
    setupRendererPerformanceProbes()
    mark('app.renderer.performance.initialized')
  } else {
    pending = []
  }
  return config
}

export function getPerformanceConfig(): PerformanceConfig {
  return config
}

export function mark(name: string, data?: Record<string, unknown>): void {
  enqueue({
    kind: 'mark',
    process: 'renderer',
    area: areaFromName(name),
    name,
    data,
  })
}

export function metric(
  name: string,
  value: number,
  metricType: PerformanceMetricType = 'sample',
  data?: Record<string, unknown>,
): void {
  enqueue({
    kind: 'metric',
    process: 'renderer',
    area: areaFromName(name),
    name,
    metricType,
    value,
    data,
  })
}

export function count(name: string, value = 1, data?: Record<string, unknown>): void {
  metric(name, value, 'counter', data)
}

export function gauge(name: string, value: number, data?: Record<string, unknown>): void {
  metric(name, value, 'gauge', data)
}

export function error(name: string, err: unknown, data?: Record<string, unknown>): void {
  enqueue({
    kind: 'error',
    process: 'renderer',
    area: areaFromName(name),
    name,
    level: 'error',
    error: serializeError(err),
    data,
  })
}

export function span(name: string, data?: Record<string, unknown>) {
  if (!initialized || !config.enabled) {
    return {
      end() {},
      fail() {},
    }
  }
  const active = tracer.startSpan(name, {
    attributes: {
      ...toAttributes(sanitizeData(data)),
      'cc.area': areaFromName(name),
      'cc.process': 'renderer',
    },
  })
  return {
    end(endData?: Record<string, unknown>) {
      const attrs = toAttributes(sanitizeData(endData))
      if (attrs) active.setAttributes(attrs)
      active.end()
    },
    fail(err: unknown, endData?: Record<string, unknown>) {
      const attrs = toAttributes(sanitizeData(endData))
      if (attrs) active.setAttributes(attrs)
      active.recordException(err instanceof Error ? err : String(err))
      active.setStatus({ code: SpanStatusCode.ERROR, message: String((err as Error)?.message ?? err) })
      active.end()
    },
  }
}

export async function measure<T>(
  name: string,
  fn: () => T | Promise<T>,
  data?: Record<string, unknown>,
): Promise<T> {
  const active = span(name, data)
  try {
    const result = await fn()
    active.end()
    return result
  } catch (err) {
    active.fail(err)
    throw err
  }
}

export async function flushPerformance(): Promise<void> {
  if (!config.enabled) return
  const batch = pending
  pending = []
  try {
    if (batch.length > 0) await window.api.appendPerformanceRecords(batch)
    await tracerProvider?.forceFlush()
  } catch (err) {
    pending = batch.concat(pending).slice(-MAX_BATCH)
    // eslint-disable-next-line no-console
    console.warn('[performance] append failed', err)
  }
}

export async function shutdownPerformance(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer)
  flushTimer = null
  await flushPerformance()
  await tracerProvider?.shutdown()
}

function setupRendererPerformanceProbes(): void {
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        mark('renderer.longtask', {
          durationMs: entry.duration,
          startTime: entry.startTime,
          entryType: entry.entryType,
          name: entry.name,
        })
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // Long Task API is Chromium-only and may not be exposed in every context.
  }

  setInterval(() => {
    const memory = performanceMemory()
    if (!memory) return
    gauge('renderer.memory.usedJSHeapSize', memory.usedJSHeapSize, {
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    })
  }, 5000)
}

function performanceMemory():
  | { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  | null {
  const maybePerformance = performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  }
  return maybePerformance.memory ?? null
}

const serializeError = serializePerformanceError

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
