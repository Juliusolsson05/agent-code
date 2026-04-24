import { ipcMain } from 'electron'
import { performance } from 'perf_hooks'

import { performanceService } from '@main/performance/PerformanceService.js'

let installed = false

export function installPerformanceIpcInstrumentation(): void {
  if (installed || !performanceService.getConfig().enabled) return
  installed = true
  const originalHandle = ipcMain.handle.bind(ipcMain)

  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown) =>
    originalHandle(channel, async (...args: unknown[]) => {
      const startedAt = performance.now()
      try {
        const result = await listener(...args)
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
