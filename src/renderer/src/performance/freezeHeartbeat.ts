import type { RendererFreezeHeartbeat } from '@shared/incident/rendererFreeze.js'

const HEARTBEAT_INTERVAL_MS = 1000
let disposeCurrent: (() => void) | null = null
const listeners = new Set<(sample: RendererFreezeHeartbeat) => void>()

export function subscribeRendererProbe(listener: (sample: RendererFreezeHeartbeat) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * One renderer probe owns liveness, long tasks and Event Timing. The payload
 * contains only numbers; Event Timing targets/names and Long Task attribution
 * never leave this callback. Whole-document scans were removed because their
 * cost grows with the exact large-render-tree failure we want to diagnose.
 * Event Timing is thresholded (16ms minimum), not a full input distribution.
 */
export function startRendererFreezeHeartbeat(): () => void {
  if (disposeCurrent) return disposeCurrent
  let stopped = false
  let expectedAt = performance.now() + HEARTBEAT_INTERVAL_MS
  let longTaskCount = 0
  let longTaskTotalMs = 0
  let longestTaskMs = 0
  let inputCount = 0
  let inputMaxMs = 0
  const observers: PerformanceObserver[] = []
  const observe = (type: string, consume: (entry: PerformanceEntry) => void): boolean => {
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) consume(entry) })
      observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 16 } : {}) })
      observers.push(observer)
      return true
    } catch { return false /* Unsupported APIs leave the independent lag probe available. */ }
  }
  const longTasksSupported = observe('longtask', entry => {
    longTaskCount++
    longTaskTotalMs += entry.duration
    longestTaskMs = Math.max(longestTaskMs, entry.duration)
  })
  const inputSupported = observe('event', entry => { inputCount++; inputMaxMs = Math.max(inputMaxMs, entry.duration) })

  const send = (): void => {
    if (stopped) return
    try {
      const monotonicMs = performance.now()
      const memory = (performance as Performance & { memory?: {
        usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number
      } }).memory
      const heartbeat: RendererFreezeHeartbeat = {
        sentAt: Date.now(), monotonicMs, timeOriginMs: performance.timeOrigin,
        longTasksSupported, inputSupported,
        eventLoopLagMs: Math.max(0, monotonicMs - expectedAt),
        visibilityState: document.visibilityState,
        longTasks: { count: longTaskCount, totalMs: longTaskTotalMs, maxMs: longestTaskMs },
        input: { count: inputCount, maxMs: inputMaxMs },
        ...(memory ? { heap: {
          usedBytes: memory.usedJSHeapSize, totalBytes: memory.totalJSHeapSize, limitBytes: memory.jsHeapSizeLimit,
        } } : {}),
      }
      longTaskCount = longTaskTotalMs = longestTaskMs = inputCount = inputMaxMs = 0
      window.api.reportRendererHeartbeat(heartbeat)
      for (const listener of listeners) {
        try { listener(heartbeat) } catch { /* Optional verbose sinks cannot break liveness. */ }
      }
    } catch { /* Preload teardown cannot break application rendering. */ }
    finally {
      expectedAt = performance.now() + HEARTBEAT_INTERVAL_MS
      if (!stopped) timer = window.setTimeout(send, HEARTBEAT_INTERVAL_MS)
    }
  }
  let timer = window.setTimeout(send, HEARTBEAT_INTERVAL_MS)
  const dispose = (): void => {
    stopped = true
    window.clearTimeout(timer)
    for (const observer of observers) observer.disconnect()
    window.removeEventListener('pagehide', dispose)
    if (disposeCurrent === dispose) disposeCurrent = null
  }
  disposeCurrent = dispose
  window.addEventListener('pagehide', dispose, { once: true })
  return dispose
}
