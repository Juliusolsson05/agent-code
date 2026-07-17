/**
 * Apply async work in input order while limiting how many items may be in
 * flight at once.
 *
 * WHY this lives beside the shared editor workbench: Global Editor and AI
 * Workspace both expose Save All, and both can legally contain many large
 * buffers. `Promise.all(items.map(...))` turns one user action into an
 * unbounded burst of IPC payloads and filesystem writes. A small shared pool
 * keeps the disk busy without making either editor host invent subtly
 * different scheduling and result-order semantics.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let nextIndex = 0

  const runNext = async (): Promise<void> => {
    while (true) {
      // JavaScript runs until the next await, so claiming the next index here
      // is atomic across these cooperative workers without another lock.
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  }

  // Treat an accidental zero/NaN/fraction as one worker. Save All must degrade
  // to sequential progress rather than silently returning an unfilled result
  // array because a future caller passed a computed limit.
  const workerCount = Math.min(
    items.length,
    Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 1),
  )
  // Promise.all rejects as soon as one worker fails while its siblings keep
  // writing in the background. Save All would then clear its busy state and
  // accept another bulk action on top of those invisible writes. Wait for
  // every worker to settle, then preserve ordinary rejection semantics.
  const settlements = await Promise.allSettled(
    Array.from({ length: workerCount }, () => runNext()),
  )
  const rejected = settlements.find(
    (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
  )
  if (rejected) throw rejected.reason
  return results
}
