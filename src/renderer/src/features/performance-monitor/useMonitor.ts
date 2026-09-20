import { useEffect, useState } from 'react'
import type { MonitorSnapshot } from '@shared/performance/monitorSnapshot.js'

/** Mounting the monitor is the only owner of UI polling. Background collection
 * continues independently; a hung IPC read cannot create a pile of promises. */
export function useMonitor() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let warning: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      warning = setTimeout(() => { if (!disposed) setError(true) }, 5000)
      try {
        const result = await window.api.getMonitorSnapshot()
        if (!disposed) { setSnapshot(result); setError(result === null) }
      } catch { if (!disposed) setError(true) }
      finally {
        clearTimeout(warning)
        if (!disposed) timer = setTimeout(tick, 1000)
      }
    }
    void tick()
    return () => { disposed = true; clearTimeout(timer); clearTimeout(warning) }
  }, [])
  return { snapshot, error }
}
