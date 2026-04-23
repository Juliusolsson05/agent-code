import type { JsonlEntry } from 'claude-code-headless'

import { sendToMainWindow } from '@main/window/mainWindow.js'

// Per-session jsonl-entry coalescer.
//
// WHY: on a resumed Claude/Codex session, the headless `bootstrapTail`
// parses the last ~200 lines from the JSONL file synchronously and
// emits one `jsonl-entry` event per line. Forwarding each as its own
// IPC `webContents.send` produced ~200 round-trips per pane × N panes
// on restart — which on the renderer side became 200N React renders,
// 200N O(N) spreads, and 200N auto-scroll pins. That's the "feels
// like I'm being scrolled through the whole conversation" bug.
//
// Coalescing: we buffer entries per sessionId, schedule ONE
// setImmediate flush, and deliver the whole burst as a single
// `session:jsonl-entries` payload. setImmediate (not Promise.resolve
// or process.nextTick) runs after the current I/O tick finishes, so
// the whole bootstrapTail loop drains before we schedule a send. Live
// mid-conversation entries land one per tick and are flushed
// immediately after — no added latency for the streaming path.
//
// Singular `session:jsonl-entry` is intentionally NOT emitted here:
// we used to dual-emit (singular + coalesced) for "backward
// compatibility," but the singular IPC queue beat the coalescer to
// the renderer on every burst and the renderer's dedupe on the bulk
// path made it a no-op. Now everything goes bulk; live single entries
// become 1-element bulk messages with ~1ms latency from setImmediate
// — imperceptible.

type PendingJsonlBuffer = {
  entries: Array<{ entry: JsonlEntry; file: string }>
  flushScheduled: boolean
}

const jsonlPending = new Map<string, PendingJsonlBuffer>()

function flushJsonlFor(sessionId: string): void {
  const pending = jsonlPending.get(sessionId)
  if (!pending || pending.entries.length === 0) return
  const payload = {
    sessionId,
    entries: pending.entries,
  }
  pending.entries = []
  pending.flushScheduled = false
  sendToMainWindow('session:jsonl-entries', payload)
}

export function enqueueJsonl(
  sessionId: string,
  entry: JsonlEntry,
  file: string,
): void {
  let pending = jsonlPending.get(sessionId)
  if (!pending) {
    pending = { entries: [], flushScheduled: false }
    jsonlPending.set(sessionId, pending)
  }
  pending.entries.push({ entry, file })
  if (!pending.flushScheduled) {
    pending.flushScheduled = true
    setImmediate(() => flushJsonlFor(sessionId))
  }
}

/**
 * Drop any buffered entries for a session. Called on exit so the
 * final bulk message lands before the exit event and the map doesn't
 * leak buffers for dead sessions.
 */
export function flushAndDropJsonl(sessionId: string): void {
  flushJsonlFor(sessionId)
  jsonlPending.delete(sessionId)
}
