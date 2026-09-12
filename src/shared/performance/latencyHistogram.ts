// Fixed, non-cumulative buckets are cheap to merge across workers and time
// rollups. Averaging p95s would overweight quiet periods and invent a latency
// distribution that no user experienced. The final bucket is overflow; its
// percentile is explicitly unbounded, never mislabeled as 60 seconds.
export const LATENCY_BUCKETS_MS = [1, 4, 8, 16, 32, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000] as const
export type LatencyHistogramSnapshot = { counts: number[]; count: number; sumMs: number; maxMs: number }

export class LatencyHistogram {
  private counts: number[] = Array(LATENCY_BUCKETS_MS.length + 1).fill(0)
  private count = 0
  private sumMs = 0
  private maxMs = 0

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(this.sumMs + ms)
      || !Number.isSafeInteger(this.count + 1)) return
    const index = LATENCY_BUCKETS_MS.findIndex(bound => ms <= bound)
    this.counts[index < 0 ? LATENCY_BUCKETS_MS.length : index]++
    this.count++
    this.sumMs += ms
    this.maxMs = Math.max(this.maxMs, ms)
  }

  merge(snapshot: LatencyHistogramSnapshot): boolean {
    if (!isLatencyHistogram(snapshot)) return false
    const sum = this.sumMs + snapshot.sumMs
    if (!Number.isFinite(sum) || !Number.isSafeInteger(this.count + snapshot.count)) return false
    this.counts = this.counts.map((count, index) => count + snapshot.counts[index])
    this.count += snapshot.count
    this.sumMs = sum
    this.maxMs = Math.max(this.maxMs, snapshot.maxMs)
    return true
  }

  snapshot(): LatencyHistogramSnapshot {
    return { counts: [...this.counts], count: this.count, sumMs: this.sumMs, maxMs: this.maxMs }
  }
}

export function isLatencyHistogram(input: unknown): input is LatencyHistogramSnapshot {
  if (!input || typeof input !== 'object') return false
  const value = input as LatencyHistogramSnapshot
  return Array.isArray(value.counts) && value.counts.length === LATENCY_BUCKETS_MS.length + 1
    && value.counts.every(count => Number.isSafeInteger(count) && count >= 0)
    && Number.isSafeInteger(value.count) && value.count >= 0
    && value.counts.reduce((sum, count) => sum + count, 0) === value.count
    && Number.isFinite(value.sumMs) && value.sumMs >= 0
    && Number.isFinite(value.maxMs) && value.maxMs >= 0
}

export function latencyQuantile(snapshot: LatencyHistogramSnapshot, quantile: number): {
  upperBoundMs: number | null; overflow: boolean
} | null {
  if (!isLatencyHistogram(snapshot) || snapshot.count === 0
    || !Number.isFinite(quantile) || quantile <= 0 || quantile > 1) return null
  const rank = Math.ceil(snapshot.count * quantile)
  let seen = 0
  for (let index = 0; index < snapshot.counts.length; index++) {
    seen += snapshot.counts[index]
    if (seen >= rank) return { upperBoundMs: LATENCY_BUCKETS_MS[index] ?? null, overflow: index === LATENCY_BUCKETS_MS.length }
  }
  return null
}
