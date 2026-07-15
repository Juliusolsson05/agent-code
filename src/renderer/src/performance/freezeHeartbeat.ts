import type { RendererFreezeHeartbeat } from '@shared/incident/rendererFreeze.js'

const HEARTBEAT_INTERVAL_MS = 1_000
const DOM_SAMPLE_EVERY_TICKS = 5

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number
    totalJSHeapSize: number
    jsHeapSizeLimit: number
  }
}

/**
 * Start the always-on, deliberately tiny renderer liveness signal consumed by main's freeze
 * watchdog. This does not rely on the optional AGENT_CODE_PERF pipeline: when the renderer is
 * completely starved, main needs to know the age and content of the LAST successful tick even in a
 * normal user run. A recursive timeout measures scheduler delay directly and cannot accumulate a
 * backlog of interval callbacks after one long task.
 */
export function startRendererFreezeHeartbeat(): void {
  let expectedAt = performance.now() + HEARTBEAT_INTERVAL_MS
  let tick = 0
  let longTaskCount = 0
  let longTaskTotalMs = 0
  let longestTaskMs = 0

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1
        longTaskTotalMs += entry.duration
        longestTaskMs = Math.max(longestTaskMs, entry.duration)
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // Chromium normally exposes Long Task entries, but the heartbeat remains useful on builds or
    // test environments that do not. Event-loop lag is measured without this observer.
  }

  const send = (): void => {
    try {
      const monotonicMs = performance.now()
      tick += 1
      const memory = (performance as PerformanceWithMemory).memory
      const heartbeat: RendererFreezeHeartbeat = {
        sentAt: Date.now(),
        monotonicMs,
        eventLoopLagMs: Math.max(0, monotonicMs - expectedAt),
        visibilityState: document.visibilityState,
        longTasks: {
          count: longTaskCount,
          totalMs: Math.round(longTaskTotalMs * 100) / 100,
          maxMs: Math.round(longestTaskMs * 100) / 100,
        },
        ...(memory === undefined
          ? {}
          : {
              heap: {
                usedBytes: memory.usedJSHeapSize,
                totalBytes: memory.totalJSHeapSize,
                limitBytes: memory.jsHeapSizeLimit,
              },
            }),
        ...(tick % DOM_SAMPLE_EVERY_TICKS !== 0
          ? {}
          : {
              dom: {
                nodes: document.getElementsByTagName('*').length,
                preElements: document.getElementsByTagName('pre').length,
                codeElements: document.getElementsByTagName('code').length,
                workflowActivities: document.querySelectorAll('[data-workflow-activity-id]').length,
              },
            }),
      }
      longTaskCount = 0
      longTaskTotalMs = 0
      longestTaskMs = 0
      window.api.reportRendererHeartbeat(heartbeat)
    } catch {
      // WHY heartbeat failures are swallowed: preload teardown during reload,
      // an unavailable Performance API in a test shell, or a transient DOM
      // query failure must not break application rendering. The next timeout
      // is scheduled in finally so diagnostics can recover independently.
    } finally {
      expectedAt = performance.now() + HEARTBEAT_INTERVAL_MS
      window.setTimeout(send, HEARTBEAT_INTERVAL_MS)
    }
  }

  window.setTimeout(send, HEARTBEAT_INTERVAL_MS)
}
