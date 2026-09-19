import { mainOperations } from './operations.js'
import { ipcMain } from 'electron'
import { performance } from 'perf_hooks'

import { performanceService } from '@main/performance/PerformanceService.js'

let installed = false

function shouldInstrumentChannel(channel: string): boolean {
  // WHY the perf channels are excluded: renderer batches reach main over IPC,
  // and tracing that transport means recording telemetry creates more
  // telemetry. The feedback is bounded, but in exactly the diagnostic sessions
  // where this instrumentation is on we want the trace to describe the app, not
  // the logging pipe carrying the trace.
  return !channel.startsWith('performance:')
    && !channel.startsWith('incident:')
    && !channel.startsWith('lifecycle:')
}

export function installPerformanceIpcInstrumentation(): void {
  if (installed) return
  installed = true
  const originalHandle = ipcMain.handle.bind(ipcMain)

  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown) =>
    originalHandle(channel, async (...args: unknown[]) => {
      if (!shouldInstrumentChannel(channel)) return listener(...args)
      const startedAt = performance.now()
      const end = mainOperations.begin('ipc.handler')
      try {
        const result = await listener(...args)
        end()
        performanceService.record({
          kind: 'span_end',
          process: 'main',
          area: 'ipc.handle',
          name: `ipc.handle.${channel}`,
          durationMs: performance.now() - startedAt,
          data: { channel },
        })
        return result
      } catch (err) {
        end('error')
        performanceService.record({
          kind: 'span_end',
          process: 'main',
          area: 'ipc.handle',
          name: `ipc.handle.${channel}`,
          level: 'error',
          durationMs: performance.now() - startedAt,
          data: { channel },
        })
        performanceService.error(`ipc.handle.${channel}.error`, err)
        throw err
      }
    })) as typeof ipcMain.handle
}
