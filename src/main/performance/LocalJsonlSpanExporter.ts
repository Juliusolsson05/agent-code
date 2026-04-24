import { ExportResultCode } from '@opentelemetry/core'
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { queuePerformanceAppend } from '@main/storage/performanceLog.js'

function hrTimeToUnixMs(hrTime: readonly [number, number]): number {
  return (hrTime[0] * 1000) + (hrTime[1] / 1e6)
}

function hrDurationToMs(hrTime: readonly [number, number]): number {
  return (hrTime[0] * 1000) + (hrTime[1] / 1e6)
}

export class LocalJsonlSpanExporter implements SpanExporter {
  constructor(
    private readonly runDir: string,
    private readonly slowSpanMs: number,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    const spanLines: string[] = []
    const slowLines: string[] = []

    for (const span of spans) {
      const startMs = hrTimeToUnixMs(span.startTime)
      const durationMs = hrDurationToMs(span.duration)
      const payload = {
        kind: 'otel_span',
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        name: span.name,
        status: span.status,
        attributes: span.attributes,
        events: span.events.map(event => ({
          name: event.name,
          ts: hrTimeToUnixMs(event.time),
          tsIso: new Date(hrTimeToUnixMs(event.time)).toISOString(),
          attributes: event.attributes,
        })),
        startedAt: startMs,
        startedAtIso: new Date(startMs).toISOString(),
        endedAt: hrTimeToUnixMs(span.endTime),
        durationMs,
        resource: span.resource.attributes,
        instrumentationScope: span.instrumentationScope,
      }
      const line = JSON.stringify(payload)
      spanLines.push(line)
      if (durationMs >= this.slowSpanMs) slowLines.push(line)
    }

    Promise.all([
      queuePerformanceAppend(this.runDir, 'spans', spanLines),
      queuePerformanceAppend(this.runDir, 'slow', slowLines),
    ])
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch(error => resultCallback({ code: ExportResultCode.FAILED, error }))
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
