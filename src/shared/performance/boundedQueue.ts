type Entry<T> = { value: T; bytes: number }

/** A ring, because shift() would make overload handling itself O(queue size). */
export class BoundedQueue<T> {
  private readonly entries: Array<Entry<T> | undefined>
  private head = 0
  private length = 0
  private bytes = 0
  private dropped = 0
  private droppedBytes = 0

  constructor(private readonly maxRecords: number, private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid queue limits')
    this.entries = new Array(maxRecords)
  }

  get stats() {
    return { records: this.length, bytes: this.bytes, dropped: this.dropped, droppedBytes: this.droppedBytes }
  }

  push(value: T, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxBytes) {
      this.dropped++
      if (Number.isSafeInteger(bytes) && bytes > 0) this.droppedBytes += bytes
      return false
    }
    // The newest tail explains the current incident. Preserve cumulative loss
    // separately so clearing/flushing the queue cannot make coverage look whole.
    while (this.length >= this.maxRecords || this.bytes + bytes > this.maxBytes) {
      const removed = this.remove()!
      this.dropped++
      this.droppedBytes += removed.bytes
    }
    this.entries[(this.head + this.length) % this.maxRecords] = { value, bytes }
    this.length++
    this.bytes += bytes
    return true
  }

  drain(maxRecords = this.maxRecords, maxBytes = this.maxBytes): T[] {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 0
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid drain limits')
    const result: T[] = []
    let bytes = 0
    while (this.length && result.length < maxRecords) {
      const next = this.entries[this.head]!
      if (bytes + next.bytes > maxBytes) break
      bytes += next.bytes
      result.push(this.remove()!.value)
    }
    return result
  }

  clear(): void {
    while (this.length) this.remove()
  }

  private remove(): Entry<T> | undefined {
    if (!this.length) return undefined
    const entry = this.entries[this.head]!
    this.entries[this.head] = undefined // Release references on drain, not eventual wraparound.
    this.head = (this.head + 1) % this.maxRecords
    this.length--
    this.bytes -= entry.bytes
    return entry
  }
}

