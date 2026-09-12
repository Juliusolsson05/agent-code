import { MonitorAggregator } from './MonitorAggregator.js'
import type { MonitorWorkerRequest } from '@shared/performance/monitorSnapshot.js'

// utilityProcess runs in Electron's signed helper, including distributions
// whose RunAsNode fuse is disabled. No transcript/provider modules belong in
// this entry: the worker only receives numeric, already-normalized evidence.
const parent = (process as unknown as { parentPort: {
  on(event: 'message', listener: (event: { data: MonitorWorkerRequest }) => void): void
  postMessage(message: unknown): void
} }).parentPort
const aggregator = new MonitorAggregator()
parent.on('message', ({ data }) => {
  aggregator.accept(data.records)
  if (data.liveWindowIds) aggregator.reconcileWindows(data.liveWindowIds)
  parent.postMessage({ sequence: data.sequence, snapshot: aggregator.snapshot(Date.now(), process.memoryUsage.rss()) })
})
