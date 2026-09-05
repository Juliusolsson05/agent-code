import type { WebSocket } from 'ws'
import type { HistoryChunk } from '@main/sessions/historyLoader.js'
import { REMOTE_OUTPUT_MAX_BYTES, REMOTE_HISTORY_MAX_BYTES } from '@shared/remoteOutputLimits.js'

export function sendBoundedRemoteOutput(ws: WebSocket, encoded: string, flushed?: (ok: boolean) => void): boolean {
  if (ws.readyState !== ws.OPEN) return false
  // bufferedAmount covers both the socket and ws sender queue. Reserve the
  // maximum frame header too. All writers run on this event loop, so nothing
  // can enqueue between this check and send. Do not queue a graceful close
  // behind the very backlog we're trying to release: terminate immediately.
  // Reconnection resets/backfills the client rather than hiding missing deltas.
  if (ws.bufferedAmount + Buffer.byteLength(encoded) + 16 > REMOTE_OUTPUT_MAX_BYTES) {
    ws.terminate()
    return false
  }
  if (flushed) {
    ws.send(encoded, error => {
      if (error) ws.terminate()
      flushed(!error)
    })
  } else ws.send(encoded)
  return true
}

export function boundRemoteHistory(chunk: HistoryChunk): HistoryChunk | null {
  let size = 2
  let start = chunk.entries.length
  // Keep the suffix nearest the requested cursor. Throwing away the newest
  // end of an older page would create an unpageable gap; moving the oldest
  // boundary instead lets the next request retrieve everything left behind.
  while (start > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(chunk.entries[start - 1])) + 1
    if (size + bytes > REMOTE_HISTORY_MAX_BYTES) break
    size += bytes
    start--
  }
  if (chunk.entries.length > 0 && start === chunk.entries.length) return null
  return {
    ...chunk,
    entries: chunk.entries.slice(start),
    offsets: chunk.offsets?.slice(start),
    hasMore: chunk.hasMore || start > 0,
  }
}
