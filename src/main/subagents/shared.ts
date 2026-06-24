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

export function readRange(path: string, from: number, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const stream = createReadStream(path, {
      start: from,
      end: size - 1,
      encoding: 'utf8',
    })
    stream.on('data', chunk => {
      out += chunk
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(out))
  })
}
