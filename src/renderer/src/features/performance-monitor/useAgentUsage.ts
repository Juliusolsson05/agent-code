import { useEffect, useState } from 'react'
import type { MonitorAgentUsage } from '@shared/performance/agentUsage.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'

/** Per-agent usage for the overview, polled at the process sample cadence.
 *
 * WHY the previous value survives a null read: null means main is busy or the
 * read is still in flight, not that every agent vanished. Clearing the ranking
 * on a transient miss made rows blink away and back. */
export function useAgentUsage() {
  const [usage, setUsage] = useState<MonitorAgentUsage | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const result = await window.api.getMonitorAgentUsage()
        if (!disposed) { if (result) setUsage(result); setError(result === null) }
      } catch { if (!disposed) setError(true) }
      finally { if (!disposed) timer = setTimeout(read, MONITOR_POLICY.sampleMs) }
    }
    void read()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  return { usage, error }
}
