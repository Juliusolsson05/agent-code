import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { SESSION_RECORDING_DIR } from '@main/storage/paths.js'

// Read side of the `__render_shape` sidecar (Phase 2/3, PR #555).
//
// The Unknown Shape Inbox is DERIVED state: recordings on disk + checked-in
// catalogs, no second database (plan §Step 5 — "survives restart through
// the recording sidecars"). This module is that derivation's disk half: it
// sweeps every recording folder for sidecar lines and returns the parsed
// sightings, leaving classification (fingerprint→catalog comparison) to the
// renderer where the typed catalogs live.
//
// BOUNDED BY CONSTRUCTION, like everything else in this system: recordings
// are scanned newest-first (recordingId sorts chronologically) and the sweep
// stops at hard caps rather than loading a season of soaks into one IPC
// reply. The caller sees `truncated: true` and can archive/prune old
// recordings if it needs deeper history.

const MAX_SIGHTINGS = 20_000
const MAX_RECORDINGS = 60
/**
 * Total-bytes budget for one sweep (review finding: 200 recordings at the
 * 128 MiB per-recording cap meant a dev-panel open could read ~25 GiB on
 * the MAIN process — the exact whole-file pattern behind the 2026-07-07
 * OOM). Newest-first means the budget always covers recent captures;
 * hitting it flags `truncated` so the inbox says so instead of lying about
 * coverage.
 */
const MAX_SWEEP_BYTES = 256 * 1024 * 1024
/** A total budget alone does not protect the first selected recording: the old
 *  readFile call allocated that whole file before checking the aggregate. Keep
 *  each stream independently bounded so a manually copied/corrupt multi-GiB
 *  events file cannot turn opening Dev Debug into a main-process OOM. */
const MAX_RECORDING_BYTES = 64 * 1024 * 1024
/** Skip absurd single lines defensively — a sidecar line is a coalesced
 *  batch of ≤512 metadata sightings, far below this. This is deliberately a
 *  byte limit, not a JavaScript-character limit: the allocation we are
 *  defending is the stream buffer, and a Unicode string can require several
 *  bytes per code point before decoding. */
const MAX_LINE_BYTES = 4 * 1024 * 1024
const RENDER_SHAPE_MARKER = Buffer.from('"__render_shape"')

/**
 * Split a byte stream without ever retaining more than one policy-sized line.
 *
 * Node's readline API looks streaming, but it buffers until it sees a newline.
 * A corrupt 64 MiB newline-free recording could therefore occupy the whole
 * per-recording allowance before the old post-read 4 MiB check got a chance to
 * reject it. Once this splitter crosses MAX_LINE_BYTES it drops the retained
 * slices immediately and merely scans future chunks for the next LF. That
 * distinction is the memory invariant: a bad line may consume bounded I/O,
 * but it can never turn the outer file cap into an equally large allocation.
 *
 * A clipped stream must not expose its final fragment. JSON.parse can accept
 * a coincidentally complete prefix, but without the newline (or real EOF) it
 * was never a committed JSONL record. Complete files retain the historical
 * tolerance for one final record without a trailing newline.
 */
async function* splitBoundedJsonlLines(
  input: AsyncIterable<Buffer | string>,
  includeFinalFragment: boolean,
): AsyncGenerator<Buffer> {
  let pieces: Buffer[] = []
  let retainedBytes = 0
  let discardingOversizedLine = false

  for await (const rawChunk of input) {
    const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk
    let cursor = 0

    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor)
      const segmentEnd = newline === -1 ? chunk.length : newline

      if (!discardingOversizedLine && segmentEnd > cursor) {
        const segment = chunk.subarray(cursor, segmentEnd)
        if (retainedBytes + segment.length <= MAX_LINE_BYTES) {
          pieces.push(segment)
          retainedBytes += segment.length
        } else {
          // Drop every retained slice as soon as the policy is exceeded. Do
          // not keep a truncated prefix: it is not authoritative JSON and it
          // would make an oversized line look like a torn-but-usable record.
          pieces = []
          retainedBytes = 0
          discardingOversizedLine = true
        }
      }

      if (newline === -1) break

      if (!discardingOversizedLine) {
        yield Buffer.concat(pieces, retainedBytes)
      }
      pieces = []
      retainedBytes = 0
      discardingOversizedLine = false
      cursor = newline + 1
    }
  }

  if (includeFinalFragment && !discardingOversizedLine && retainedBytes > 0) {
    yield Buffer.concat(pieces, retainedBytes)
  }
}

export type RenderShapeSidecarSweep = {
  /** Parsed sighting objects, newest recording first (line order within a
   *  recording preserved). Typed `unknown` at this trust boundary — the
   *  renderer validates shape before use. */
  sightings: unknown[]
  recordingsScanned: number
  truncated: boolean
}

export async function readRenderShapeSightings(): Promise<RenderShapeSidecarSweep> {
  let dirs: string[]
  try {
    dirs = (await readdir(SESSION_RECORDING_DIR, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
      // recordingId begins with an ISO timestamp → lexicographic sort IS
      // chronological; reverse for newest-first so caps bite the oldest.
      .sort()
      .reverse()
  } catch {
    // No recordings dir yet — nothing captured on this machine.
    return { sightings: [], recordingsScanned: 0, truncated: false }
  }

  const sightings: unknown[] = []
  let truncated = false
  let scanned = 0
  let bytesRead = 0
  for (const dir of dirs) {
    if (
      scanned >= MAX_RECORDINGS ||
      sightings.length >= MAX_SIGHTINGS ||
      bytesRead >= MAX_SWEEP_BYTES
    ) {
      truncated = true
      break
    }
    scanned += 1
    const eventPath = join(SESSION_RECORDING_DIR, dir, 'events.jsonl')
    let fileBytes: number
    try {
      fileBytes = (await stat(eventPath)).size
    } catch {
      continue // meta-only folder or torn recording — fine, skip
    }
    if (fileBytes === 0) continue
    const remainingBytes = MAX_SWEEP_BYTES - bytesRead
    const streamBytes = Math.min(fileBytes, MAX_RECORDING_BYTES, remainingBytes)
    const clipped = streamBytes < fileBytes
    if (clipped) truncated = true

    // The custom splitter enforces the line policy while bytes arrive. A
    // newline-oriented convenience API cannot provide that guarantee because
    // it must first retain the whole record before returning it to us.
    const input = createReadStream(eventPath, {
      start: 0,
      end: streamBytes - 1,
    })
    const consume = (lineBuffer: Buffer): void => {
      // JSONL permits CRLF. Strip exactly the framing CR, not arbitrary
      // whitespace that may be meaningful inside a JSON string.
      const framedLine =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d
          ? lineBuffer.subarray(0, lineBuffer.length - 1)
          : lineBuffer
      // Cheap pre-filter before JSON.parse — the sidecar is a needle in a
      // haystack of feed events, and parsing every line of every recording
      // would make the sweep O(all recordings ever).
      if (framedLine.length === 0 || !framedLine.includes(RENDER_SHAPE_MARKER)) return
      try {
        const line = framedLine.toString('utf8')
        const parsed = JSON.parse(line) as {
          ch?: unknown
          sightings?: unknown
        }
        if (parsed.ch !== '__render_shape' || !Array.isArray(parsed.sightings)) return
        for (const s of parsed.sightings) {
          if (sightings.length >= MAX_SIGHTINGS) {
            truncated = true
            break
          }
          // Inject the recording id so the inbox/report can point back at
          // the source recording (plan §Step 5 traceability). Injected here
          // because the writer deliberately doesn't know its recording id.
          sightings.push(typeof s === 'object' && s !== null ? { ...s, sourceRecordingId: dir } : s)
        }
      } catch {
        // Torn tails are part of the recorder contract. Interior malformed
        // records are equally non-authoritative at this disk trust boundary.
      }
    }
    try {
      for await (const line of splitBoundedJsonlLines(input, !clipped)) {
        consume(line)
        if (sightings.length >= MAX_SIGHTINGS) break
      }
    } catch {
      // A live recording can disappear between stat and stream open (manual
      // cleanup/retention). Treat it like the existing meta-only/torn cases;
      // the inbox is derived diagnostics and must not take down main.
    }
    input.destroy()
    bytesRead += streamBytes
  }
  return { sightings, recordingsScanned: scanned, truncated }
}
