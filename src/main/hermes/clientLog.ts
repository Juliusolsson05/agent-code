// The client side of a Hermes conversation, on disk (#1527).
//
// WHY this exists: on 2026-10-15 a held message was lost after a reconnect,
// and the cause could be found ONLY from the Hermes server's log. Agent Code
// had nothing: the pane dropped the error object, the dev app wrote to the
// launching terminal, the packaged app keeps no log file at all. So every
// line here is shaped to be read NEXT TO Hermes' own log:
//   - `t` is ISO UTC, because Hermes logs in UTC (the VPS clock);
//   - `requestId` is the JSON-RPC id (`hh<n>`) Hermes prints as `rid=`;
//   - `conversation` is the stored session id Hermes prints in brackets.
//
// WHY never message text, only its length: debug bundles and log files get
// shared when something breaks; the user's words must not ride along. The
// writer drops any `text` field as a backstop, not as the primary rule.
//
// WHY rotation here when feedDebugLog deliberately refuses it: that log is a
// high-volume stream where rotation would hide a runaway renderer. This one
// records a handful of lines per connection event, so the risk is the
// opposite one: losing the line from yesterday's failure to today's noise.
// One previous file keeps the last ~1 MiB of history; 2 MiB is the ceiling.

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

export const HERMES_CLIENT_LOG_DIR = join(STATE_DIR, 'hermes', 'logs')
const DEFAULT_MAX_BYTES = 1024 * 1024

export type HermesClientLogEntry = {
  /** Which Settings → Hermes connection. */
  connectionId: string
  /** Hermes' stored conversation id, when known (matches the server log's `[…]`). */
  conversation?: string | null
  /** What happened, e.g. `hold-failed`, `connection-disconnected`. */
  event: string
  /** Event detail. Never message text: pass `textLength`. */
  [detail: string]: unknown
}

export type HermesClientLog = {
  write(entry: HermesClientLogEntry): void
  /** Resolves once every queued line is on disk (tests, shutdown). */
  flush(): Promise<void>
}

export function createHermesClientLog(options: { dir?: string; maxBytes?: number; now?: () => Date } = {}): HermesClientLog {
  const dir = options.dir ?? HERMES_CLIENT_LOG_DIR
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const now = options.now ?? (() => new Date())
  const file = join(dir, 'client.jsonl')
  const previous = join(dir, 'client.1.jsonl')
  // Size of the current file, learned from disk once, then tracked. null =
  // not yet known.
  let size: number | null = null
  // One append at a time, in order: concurrent appendFile calls could
  // interleave with a rotation and land a line in the file being renamed.
  let queue: Promise<void> = Promise.resolve()

  const writeLine = async (line: string): Promise<void> => {
    if (size === null) {
      await mkdir(dir, { recursive: true })
      size = await stat(file).then((info) => info.size, () => 0)
    }
    const bytes = Buffer.byteLength(line)
    if (size > 0 && size + bytes > maxBytes) {
      await rename(file, previous).catch(() => undefined)
      size = 0
    }
    await appendFile(file, line)
    size += bytes
  }

  return {
    write(entry) {
      const { text: _dropped, ...safe } = entry
      const line = `${JSON.stringify({ t: now().toISOString(), ...safe })}\n`
      queue = queue.then(() => writeLine(line)).catch((error: unknown) => {
        // A log that cannot be written must never break the pane; one
        // console line is all it gets.
        size = null
        console.warn('[hermes] client log write failed:', error instanceof Error ? error.message : String(error))
      })
    },
    flush() {
      return queue
    },
  }
}

let shared: HermesClientLog | null = null

/** The app's one Hermes client log. */
export function hermesClientLog(): HermesClientLog {
  shared ??= createHermesClientLog()
  return shared
}

/** Tests: swap the shared log (e.g. to a temp dir or an in-memory spy). */
export function setHermesClientLogForTests(log: HermesClientLog | null): void {
  shared = log
}

/**
 * The parts of an error worth a log line, in one shape for every caller:
 * class name, message, and the RPC code/request id when the error has them
 * (RpcError, HermesPromptError from hermes-headless).
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: clip(String(error)) }
  const fields: Record<string, unknown> = { error: clip(error.message), errorName: error.name }
  const record = error as unknown as Record<string, unknown>
  if (typeof record.code === 'number' || typeof record.code === 'string') fields.code = record.code
  if (typeof record.kind === 'string') fields.kind = record.kind
  if (typeof record.requestId === 'string') fields.requestId = record.requestId
  else if (typeof record.id === 'string') fields.requestId = record.id
  if (typeof record.method === 'string') fields.method = record.method
  if (typeof record.stage === 'string') fields.stage = record.stage
  return fields
}

/**
 * WHY messages are clipped: the RPC refusals are short and carry no user
 * text, but a lane error can wrap a REST failure, and an HTTP error message
 * may quote a response body (session titles come from the user's first
 * message). The diagnosis is in the first sentence; the rest is risk.
 */
const MAX_ERROR_CHARS = 300
function clip(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
}

/**
 * Collapses the repeating lines of an outage (review of #1529). Each
 * reconnect attempt writes attempt / connecting / failed / disconnected; at
 * the 15 s backoff cap that is ~70 KB an hour per pane, so a few hours
 * offline rotated the failure that started the outage out of both files,
 * the opposite of what rotation is for. Now a line identical to one already
 * written during this outage (same event, same details apart from the
 * attempt counter) is counted instead of written, and the count rides on
 * the line that ends the outage. The FIRST occurrence of every distinct
 * failure is always on disk.
 */
export function createOutageDeduper(): {
  /** True when the line should be written. */
  admit(event: string, details: Record<string, unknown>): boolean
  /** Ends the outage; returns how many lines were folded into it. */
  end(): number
} {
  const seen = new Set<string>()
  let folded = 0
  return {
    admit(event, details) {
      const { attempt: _attempt, ...rest } = details
      const signature = `${event} ${JSON.stringify(rest)}`
      if (seen.has(signature)) {
        folded += 1
        return false
      }
      seen.add(signature)
      return true
    },
    end() {
      const count = folded
      seen.clear()
      folded = 0
      return count
    },
  }
}
