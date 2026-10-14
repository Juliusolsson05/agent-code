// Live tool results per Hermes connection, kept in main for the app's
// lifetime (owner's debug bundle 2026-10-14T16-26-49, #1499 follow-up).
//
// WHY: Hermes' history projection drops tool output (recorded S4); the only
// copy is what hermes-headless saw stream live. Reload Agent and crash
// recovery build a NEW HermesSession, and with it a new client whose map was
// empty, so after the owner's reload 187 of 206 tool chips said "Output is
// kept on your Hermes server". One cache per connection that outlives the
// sessions fixes that for anything observed since the app started.
//
// WHY memory-only, never disk: tool output can hold secrets read from the
// server (an .env, a token check); persisting it would be a new place those
// live at rest. After an app restart the chips honestly say the output is on
// the server.
//
// Bounded (least recently set first out): a long session produces megabytes
// of tool output, and this must never become the next memory leak.

import type { ToolResultCache } from 'hermes-headless'

const MAX_TOTAL_CHARS = 8 * 1024 * 1024
const MAX_ENTRY_CHARS = 256 * 1024

type Result = { content: string; isError: boolean }

export class BoundedToolResultCache implements ToolResultCache {
  private readonly entries = new Map<string, Result>()
  private total = 0

  constructor(private readonly maxTotalChars = MAX_TOTAL_CHARS, private readonly maxEntryChars = MAX_ENTRY_CHARS) {}

  get(id: string): Result | undefined {
    return this.entries.get(id)
  }

  set(id: string, result: Result): void {
    // One huge output (a whole file read) must not evict everything else;
    // the chip keeps a truncated copy and says so.
    const content = result.content.length > this.maxEntryChars
      ? `${result.content.slice(0, this.maxEntryChars)}\n… (output truncated in Agent Code; the full output is on the Hermes server)`
      : result.content
    const previous = this.entries.get(id)
    if (previous) {
      this.total -= previous.content.length
      this.entries.delete(id)
    }
    this.entries.set(id, { content, isError: result.isError })
    this.total += content.length
    for (const [key, value] of this.entries) {
      if (this.total <= this.maxTotalChars) break
      this.entries.delete(key)
      this.total -= value.content.length
    }
  }

  get size(): number {
    return this.entries.size
  }
}

const caches = new Map<string, BoundedToolResultCache>()

/** The cache shared by every session (and every reload) of one connection. */
export function toolResultCacheFor(connectionId: string): BoundedToolResultCache {
  let cache = caches.get(connectionId)
  if (!cache) {
    cache = new BoundedToolResultCache()
    caches.set(connectionId, cache)
  }
  return cache
}
