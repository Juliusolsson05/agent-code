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
  if (!Array.isArray(value.counts) || value.counts.length !== LATENCY_BUCKETS_MS.length + 1
    || !Number.isSafeInteger(value.count) || value.count < 0
    || !Number.isFinite(value.sumMs) || value.sumMs < 0
    || !Number.isFinite(value.maxMs) || value.maxMs < 0) return false
  // Structured clone preserves sparse arrays. Array.every/reduce skip holes,
  // which would admit missing buckets and permanently poison a merge with NaN.
  // Validate every index before allowing any mutation of accumulated evidence.
  let total = 0
  let lastOccupied = -1
  let minimumSum = 0
  let maximumSum = 0
  for (let i = 0; i < value.counts.length; i++) {
    const count = value.counts[i]
    if (!Number.isSafeInteger(count) || count < 0) return false
    total += count
    if (!Number.isSafeInteger(total)) return false
    if (count > 0) lastOccupied = i
    minimumSum += count * (i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1])
    maximumSum += count * Math.min(value.maxMs, LATENCY_BUCKETS_MS[i] ?? value.maxMs)
  }
  if (total !== value.count) return false
  if (total === 0) return value.sumMs === 0 && value.maxMs === 0
  const maxBucket = LATENCY_BUCKETS_MS.findIndex(bound => value.maxMs <= bound)
  // An empty window cannot contribute latency, and a nonempty window's maximum
  // must belong to its last occupied bucket. Allow roundoff in the sum of many
  // floating-point observations without accepting impossible aggregate totals.
  const tolerance = Number.EPSILON * Math.max(1, value.sumMs) * value.count
  // At least one sample actually attained maxMs. Bucket populations also
  // constrain the sum: 100 samples in (30s, 60s] cannot have a 600ms mean.
  minimumSum += value.maxMs - (lastOccupied === 0 ? 0 : LATENCY_BUCKETS_MS[lastOccupied - 1])
  return lastOccupied === (maxBucket < 0 ? LATENCY_BUCKETS_MS.length : maxBucket)
    && value.sumMs + tolerance >= minimumSum
    && value.sumMs <= maximumSum + tolerance
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
