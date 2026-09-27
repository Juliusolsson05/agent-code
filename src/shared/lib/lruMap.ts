/**
 * A Map bounded by least-recent use: `get` and `set` move a key to the newest
 * end, and `set` evicts from the oldest end past `maxEntries`.
 *
 * WHY one shared helper (#1278): the prompt folder's cache and the
 * conversation service's search cache each needed exactly this, and the
 * second one had been left unbounded because the first one's LRU lived in two
 * private functions nobody could reuse. Map iteration order is insertion
 * order, so delete-then-set is the whole mechanism; there is no linked list to
 * get wrong.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size
  }

  /** Reads and marks as most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /** Reads WITHOUT touching recency (inspection, tests). */
  peek(key: K): V | undefined {
    return this.entries.get(key)
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
