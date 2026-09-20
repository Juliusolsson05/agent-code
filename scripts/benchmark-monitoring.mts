// Synthetic, content-free producer benchmark. This measures the code we own;
// it cannot claim full packaged-app CPU, UI latency, or utility-process RSS.
// The later Electron replay runner uses the same policy and reports those
// independently. No credentials, sessions, userData, or diagnostic logs are read.
import { performance } from 'node:perf_hooks'
import { cpus, platform, arch } from 'node:os'
import { BoundedQueue } from '../src/shared/performance/boundedQueue.ts'
import { LatencyHistogram } from '../src/shared/performance/latencyHistogram.ts'
import { MONITOR_POLICY } from '../src/shared/performance/monitorPolicy.ts'
import { MONITOR_RECORD_BYTES, parseMonitorRendererRecord } from '../src/shared/performance/monitorContracts.ts'

const iterations = 100_000
const samples: number[] = []
const queue = new BoundedQueue<unknown>(MONITOR_POLICY.sourceQueueRecords, MONITOR_POLICY.sourceQueueBytes)
const histogram = new LatencyHistogram()
const record = { kind: 'operation', name: 'transcript.fold', durationMs: 12, outcome: 'success', sessionId: 'synthetic-agent' }
for (let i = 0; i < 10_000; i++) parseMonitorRendererRecord(record)
const cpuBefore = process.cpuUsage()
const started = performance.now()
for (let i = 0; i < iterations; i++) {
  const start = performance.now()
  const admitted = parseMonitorRendererRecord(record)
  if (!admitted) throw new Error('Synthetic fixture was rejected')
  queue.push(admitted, MONITOR_RECORD_BYTES)
  histogram.observe(record.durationMs)
  if (i % 64 === 0) queue.drain(64, MONITOR_POLICY.batchBytes)
  samples.push((performance.now() - start) * 1000)
}
const elapsedMs = performance.now() - started
const cpu = process.cpuUsage(cpuBefore)
samples.sort((a, b) => a - b)
process.stdout.write(`${JSON.stringify({
  scope: 'synthetic producer validation + bounded queue + histogram, not whole-app overhead',
  node: process.version, platform: platform(), arch: arch(), logicalCpus: cpus().length,
  iterations, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
  p50Us: samples[Math.floor(samples.length * 0.50)],
  p95Us: samples[Math.floor(samples.length * 0.95)],
  p99Us: samples[Math.floor(samples.length * 0.99)],
  queue: queue.stats,
}, null, 2)}\n`)
