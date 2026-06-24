import { createReadStream } from 'node:fs'
import type { SubAgentToolCall } from '@preload/api/types.js'

/** Cap the timeline so large subagent transcripts cannot bloat IPC payloads. */
export const SUBAGENT_TOOL_CALLS_MAX = 40

export const DEFAULT_SUBAGENT_HEADLINE_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'description',
] as const

export function tsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

export function headlineFromInput(
  input: Record<string, unknown> | null | undefined,
  keys: readonly string[] = DEFAULT_SUBAGENT_HEADLINE_KEYS,
  suffix = '…',
): string | null {
  if (!input) return null
  for (const key of keys) {
    const value = input[key]
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.length <= 80) return value
    // V8 SLICE-TRAP: `bigString.slice(0, 80)` can retain the whole parent
    // string, and subagent headlines are deliberately retained in small
    // per-child state after the raw transcript/rollout entry is dropped. The
    // Buffer round-trip forces a flat, parent-independent string so the retained
    // 80-character preview cannot pin a multi-hundred-KB command/message body in
    // the main-process heap. This helper is shared by Claude and Codex because a
    // previous Claude-only fix left the Codex twin leaking the same way.
    return Buffer.from(value.slice(0, 80), 'utf16le').toString('utf16le') + suffix
  }
  return null
}

export function capToolCalls<T extends SubAgentToolCall>(
  calls: readonly T[],
  max = SUBAGENT_TOOL_CALLS_MAX,
): { kept: readonly T[]; dropped: number } {
  const dropped = calls.length > max ? calls.length - max : 0
  return {
    kept: dropped > 0 ? calls.slice(dropped) : calls,
    dropped,
  }
}

export function readRange(
  path: string,
  from: number,
  size: number,
): Promise<{ text: string; nextOffset: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(path, {
      start: from,
      end: size - 1,
    })
    stream.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    stream.on('error', reject)
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks)
      const completeLength = completeUtf8PrefixLength(buffer)
      resolve({
        text: buffer.subarray(0, completeLength).toString('utf8'),
        nextOffset: from + completeLength,
      })
    })
  })
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  const length = buffer.length
  if (length === 0) return 0

  let continuationCount = 0
  let leadIndex = length - 1
  while (
    leadIndex >= 0 &&
    (buffer[leadIndex] & 0b1100_0000) === 0b1000_0000 &&
    continuationCount < 3
  ) {
    continuationCount += 1
    leadIndex -= 1
  }

  // If the chunk begins with continuation bytes, the reader was already handed
  // an unsafe offset from an older version or from a truncated file. Decode the
  // bytes we have instead of pinning the watcher forever at the same offset.
  if (leadIndex < 0) return length

  const lead = buffer[leadIndex]
  const expectedLength =
    (lead & 0b1000_0000) === 0 ? 1 :
      (lead & 0b1110_0000) === 0b1100_0000 ? 2 :
        (lead & 0b1111_0000) === 0b1110_0000 ? 3 :
          (lead & 0b1111_1000) === 0b1111_0000 ? 4 :
            1
  const actualLength = length - leadIndex

  // WHY return the lead byte position, not just drop trailing continuation
  // bytes: Node's UTF-8 decoder flushes an incomplete final code point as U+FFFD
  // at stream end. These incremental readers persist the byte offset after each
  // poll, so decoding a partial emoji/accent once would permanently corrupt the
  // transcript preview. Keeping the whole partial sequence unread lets the next
  // poll decode it after the remaining bytes land.
  return expectedLength > actualLength ? leadIndex : length
}
