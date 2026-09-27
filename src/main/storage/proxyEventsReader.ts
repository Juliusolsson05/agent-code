import { open, readFile, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'path'

import { PROXY_EVENTS_DIR } from '@main/storage/paths.js'
import { canonicalizePath, sanitizePathSegment } from '@shared/runtime/projectDir.js'

// Reader for the on-disk proxy-events.jsonl files.
//
// WHY this exists:
//   Both Claude (via mitmproxy + ProxyServer in claude-code-headless)
//   and Codex (via ResponsesProxy after PR feat/codex-proxy-capture)
//   write per-session-run JSONL logs under
//     ~/.config/agent-code/proxy/<project-segment>/<session-segment>/<run-ts>/proxy-events.jsonl
//
//   These contain the wire-level capture of every API request and
//   response chunk: headers, request body (up to 2 MiB), pre-parsed
//   request_shape, response chunks. They're the authoritative
//   forensic record of "what was actually sent and received". Without
//   them in the bundle, debugging "why did this sidecar leak?" or
//   "what was the prompt that caused this output?" requires the user
//   to manually find the right run dir on disk and decode bodies by
//   hand.
//
//   This module provides a main-process reader that the
//   debug-bundle assembler can call (via IPC) to pull the latest run
//   for a given session into the bundle.
//
// WHY a separate file from debugBundle.ts:
//   The bundle assembler runs in the renderer; it can't read disk.
//   File reading is a main-process concern, exposed over IPC. Keeping
//   the reader in its own module means the assembler can call it
//   without bringing in the bundle's disk-write logic, and the
//   reader's tests (when we have them) don't need the bundle harness.

const PROXY_ROOT = PROXY_EVENTS_DIR

// Cap on the proxy-events.jsonl content shipped into a bundle. Long
// sessions can produce 100+ MB of wire log; bundles aren't the right
// storage for that. We tail the most recent N MiB which covers
// "the recent traffic that's relevant to whatever the user just
// observed" without ballooning bundles.
//
// WHY tail and not full:
//   The interesting events for any "I just saw this break" report
//   are within the last few minutes of traffic. Older traffic is
//   useful for trend analysis but not bundle-immediacy. If the user
//   needs the full log they can grab it directly from
//   ~/.config/agent-code/proxy/.../proxy-events.jsonl — the run dir
//   path goes into the bundle's manifest so they know where to look.
const PROXY_EVENTS_BUNDLE_MAX_BYTES = 5 * 1024 * 1024


export type ProxyEventsBundleSection = {
  /** Trimmed contents of the latest run's proxy-events.jsonl, or
   *  null if no log was found for the session. Capped at
   *  PROXY_EVENTS_BUNDLE_MAX_BYTES; if the file is larger, only the
   *  tail bytes are included and a synthetic
   *  `{kind:'truncated', dropped_bytes}` header line is prepended
   *  so consumers know they're not seeing the start of the run. */
  proxyEvents: string | null
  /** Path of the run directory whose JSONL we sampled. Goes into
   *  the bundle manifest so the user can find the full log on disk
   *  if the truncated tail isn't enough. Null if no run was found. */
  runDir: string | null
  /** session-meta.json from the same run dir, when present.
   *  Carries the cwd / sessionKey / createdAt context the proxy
   *  recorded at start. Null if file is missing or unreadable. */
  sessionMeta: string | null
  /** Forensic match quality for the bundled payload. `exact` means the
   * requested sessionKey matched a proxy session directory. `fallback` is only
   * possible when the caller explicitly opts into broader project scanning.
   * `none` means no payload was included. */
  match: 'exact' | 'fallback' | 'none'
  requestedSessionKey: string | null
  matchedSessionSegment: string | null
}


/** Find the latest proxy run dir matching the given session, read
 *  its events file (tailing if oversized), and return the section
 *  shape for inclusion in a debug bundle.
 *
 *  Search strategy:
 *    1. Compute the project segment from `cwd` using the SAME
 *       sanitiser the proxy writers use (sanitizePath →
 *       collapse-dashes → trim). Mismatched sanitiser would silently
 *       miss every bundle.
 *    2. Optionally narrow to a session-segment subdir matching
 *       `sessionKey`. If absent or the dir doesn't exist, return no
 *       payload unless the caller explicitly opts into fallback.
 *       Bundles are evidence; missing proxy evidence is safer than
 *       silently attaching a different session's wire log.
 *    3. Of all run subdirs containing a proxy-events.jsonl, pick the
 *       one with the newest mtime on its events file.
 *
 *  Returns a `match:'none'` section when no matching log exists. Never
 *  throws — bundle save must not fail because the proxy log is missing
 *  or unreadable.
 */
export async function readProxyEventsForBundle(opts: {
  cwd: string
  sessionKey?: string | null
  allowFallback?: boolean
}): Promise<ProxyEventsBundleSection> {
  const empty: ProxyEventsBundleSection = {
    proxyEvents: null,
    runDir: null,
    sessionMeta: null,
    match: 'none',
    requestedSessionKey: opts.sessionKey ?? null,
    matchedSessionSegment: null,
  }
  try {
    const canonical = await canonicalizePath(opts.cwd)
    const projectSegment = sanitiseSegment(canonical)
    if (!projectSegment) return empty
    const projectDir = join(PROXY_ROOT, projectSegment)
    const selection = await pickSessionSegments(projectDir, opts.sessionKey ?? null, opts.allowFallback === true)
    if (selection.segments.length === 0) return empty

    const latest = await findLatestRun(projectDir, selection.segments)
    if (!latest) return empty

    // The selection's size is deliberately not passed: the file may have
    // rotated since (see readEventsTail).
    const tail = await readEventsTail(latest.runDir)
    const newestBody = await readLatestRequestBody(latest.runDir)
    const proxyEvents = tail === null ? newestBody : newestBody ? `${tail.replace(/\n?$/, '\n')}${newestBody}` : tail
    const sessionMeta = await readSessionMeta(join(latest.runDir, 'session-meta.json'))

    return {
      proxyEvents,
      runDir: latest.runDir,
      sessionMeta,
      match: selection.match,
      requestedSessionKey: opts.sessionKey ?? null,
      matchedSessionSegment: latest.sessionSegment,
    }
  } catch {
    // Bundle save must NEVER fail because of an unreadable proxy
    // log. Empty section is the documented "no record found" signal.
    return empty
  }
}


// Reader segment sanitiser MUST match the proxy writers' segment exactly or a
// bundle silently misses the proxy log. Keep the same empty-input fallback as
// the writers so a degenerate but valid writer segment does not become an
// unreadable bundle path.
function sanitiseSegment(value: string): string {
  return sanitizePathSegment(value) || 'unknown'
}


async function pickSessionSegments(
  projectDir: string,
  sessionKey: string | null,
  allowFallback: boolean,
): Promise<{ segments: string[]; match: 'exact' | 'fallback' }> {
  // Debug bundles are evidence. If the caller asked for a specific
  // sessionKey, an unrelated latest run from the same project is more
  // dangerous than an omitted proxy payload: it looks authoritative while
  // describing a different provider conversation. Fallback remains an
  // explicit opt-in for local troubleshooting, but the normal bundle path
  // requires exact session provenance.
  if (sessionKey) {
    const segment = sanitiseSegment(sessionKey)
    if (segment) {
      try {
        const stats = await stat(join(projectDir, segment))
        if (stats.isDirectory()) return { segments: [segment], match: 'exact' }
      } catch {
        if (!allowFallback) return { segments: [], match: 'fallback' }
      }
    }
    if (!allowFallback) return { segments: [], match: 'fallback' }
  }
  if (!allowFallback) return { segments: [], match: 'fallback' }

  try {
    const entries = await readdir(projectDir, { withFileTypes: true })
    return {
      segments: entries.filter(e => e.isDirectory()).map(e => e.name),
      match: 'fallback',
    }
  } catch {
    return { segments: [], match: 'fallback' }
  }
}


async function findLatestRun(
  projectDir: string,
  sessionSegments: string[],
): Promise<{ runDir: string; size: number; mtimeMs: number; sessionSegment: string } | null> {
  let best: { runDir: string; size: number; mtimeMs: number; sessionSegment: string } | null = null
  for (const sessionSegment of sessionSegments) {
    const sessionDir = join(projectDir, sessionSegment)
    let runEntries: string[]
    try {
      runEntries = await readdir(sessionDir)
    } catch {
      continue
    }
    for (const runName of runEntries) {
      const runDir = join(sessionDir, runName)
      const eventsPath = join(runDir, 'proxy-events.jsonl')
      try {
        const stats = await stat(eventsPath)
        if (!stats.isFile()) continue
        if (best === null || stats.mtimeMs > best.mtimeMs) {
          best = { runDir, size: stats.size, mtimeMs: stats.mtimeMs, sessionSegment }
        }
      } catch {
        // events file missing — empty run dir or fresh proxy that
        // hasn't fired any requests yet. Skip silently.
      }
    }
  }
  return best
}


// The previous generation of a rotated events file. Both providers' writers
// rotate `proxy-events.jsonl` to this name and start a fresh file: the Codex
// mirror at 64 MiB (codex-headless `rotatedMirrorPath`, #372) and the Claude
// mitm addon (claude-code-headless `_rotated_path()`, #1273). The name must
// match both. This reader is the one owner of reading across it (steering
// q54): provider wiring builds on it rather than re-implementing it.
const LIVE_EVENTS_FILE = 'proxy-events.jsonl'
const ROTATED_EVENTS_FILE = 'proxy-events.1.jsonl'

/**
 * The last PROXY_EVENTS_BUNDLE_MAX_BYTES of a run's wire log, read across a
 * rotation as if the previous generation and the live file were one file.
 *
 * WHY across the rotation: right after a rotation the live file holds a few
 * lines, so a bundle made then would carry almost none of the recent traffic
 * a bug report is about. When the live file is under the budget, the rest is
 * filled from the END of the previous generation, which is the traffic
 * immediately before the live file's first line.
 *
 * WHY every size comes from fstat on the handle we read (steering q54): the
 * writers rotate by rename while we read. A size taken earlier (the run
 * selection's stat) can belong to an inode that has since become `.1`, while
 * the path now opens a new, empty file. Reading that saved size from the new
 * file returned a buffer of NULs (never-read bytes), or a header with no
 * lines. One handle, sized by its own fstat, is always one consistent file.
 *
 * WHY the inode check: if the rotation lands between opening the live file
 * and opening `.1`, both handles are the SAME file (the live one we opened
 * was just renamed to `.1`). Reading both would duplicate every line, so the
 * second is skipped; the bundle is then a consistent snapshot as of the first
 * open, which is the best a reader without a lock can do.
 */
async function readEventsTail(runDir: string): Promise<string | null> {
  const livePath = join(runDir, LIVE_EVENTS_FILE)
  const rotatedPath = join(runDir, ROTATED_EVENTS_FILE)
  const live = await openForTail(livePath)
  const rotated = await openForTail(rotatedPath)
  try {
    if (!live && !rotated) return null
    const liveTail = live ? await readTailLines(live, PROXY_EVENTS_BUNDLE_MAX_BYTES) : null
    const room = PROXY_EVENTS_BUNDLE_MAX_BYTES - (liveTail ? Buffer.byteLength(liveTail.text) : 0)
    const sameFile = live && rotated && live.ino === rotated.ino && live.dev === rotated.dev
    // Only a live file that fit whole leaves room that `.1` may fill: when the
    // live tail was cut, the older generation is not adjacent to it.
    const older = rotated && !sameFile && room > 0 && (liveTail?.droppedBytes ?? 0) === 0
      ? await readTailLines(rotated, room)
      : null
    const droppedBytes = (liveTail?.droppedBytes ?? 0) + (older?.droppedBytes ?? 0) +
      (rotated && !sameFile && !older ? rotated.size : 0)
    const text = `${older?.text ?? ''}${liveTail?.text ?? ''}`
    if (droppedBytes === 0) return text
    const onDisk = rotated && !sameFile ? `${rotatedPath} + ${livePath}` : livePath
    return `${truncatedHeader(droppedBytes, onDisk)}\n${text}`
  } catch {
    return null
  } finally {
    await live?.handle.close().catch(() => undefined)
    await rotated?.handle.close().catch(() => undefined)
  }
}

type TailHandle = { handle: FileHandle; size: number; ino: number; dev: number }

async function openForTail(path: string): Promise<TailHandle | null> {
  let handle: FileHandle
  try { handle = await open(path, 'r') } catch { return null }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) { await handle.close(); return null }
    return { handle, size: stats.size, ino: stats.ino, dev: stats.dev }
  } catch {
    await handle.close().catch(() => undefined)
    return null
  }
}

/**
 * The last `maxBytes` of an open file as whole JSONL lines, and how many of
 * its bytes were left out.
 *
 * Both ends are cut to line boundaries: a read that does not start at byte 0
 * drops its first partial line, and a trailing line without its newline (a
 * writer mid-append, or a file that shrank under us) is dropped too, so the
 * bundle is always parseable. Only `bytesRead` bytes are used: a file that is
 * shorter than its fstat by the time we read never yields padding.
 */
async function readTailLines(file: TailHandle, maxBytes: number): Promise<{ text: string; droppedBytes: number }> {
  const want = Math.min(maxBytes, file.size)
  const start = file.size - want
  const buf = Buffer.alloc(want)
  const { bytesRead } = want > 0 ? await file.handle.read(buf, 0, want, start) : { bytesRead: 0 }
  let bytes = buf.subarray(0, bytesRead)
  if (start > 0) {
    const firstNewline = bytes.indexOf(0x0a)
    bytes = firstNewline >= 0 ? bytes.subarray(firstNewline + 1) : bytes.subarray(bytes.length)
  }
  const lastNewline = bytes.lastIndexOf(0x0a)
  bytes = bytes.subarray(0, lastNewline + 1)
  return { text: bytes.toString('utf-8'), droppedBytes: file.size - bytes.length }
}

function truncatedHeader(droppedBytes: number, onDisk: string): string {
  return JSON.stringify({
    kind: 'truncated',
    reason: `proxy-events.jsonl exceeded ${PROXY_EVENTS_BUNDLE_MAX_BYTES} bytes; only the trailing portion is included in this bundle. Full log on disk: ${onDisk}`,
    dropped_bytes: droppedBytes,
  })
}


/**
 * The newest request body the Claude proxy addon kept after its events file
 * passed its body budget (#1273, claude-code-headless#62).
 *
 * The addon keeps one invariant: the sidecar, when it exists, is the newest
 * request body that is NOT in the log — past the budget (`body_omitted:
 * "file-budget"`) or over the 2 MiB per-body cap (`"body-cap"`). An inline
 * body removes it. So appending it never shows an older prompt as current.
 *
 * WHY it is appended to the events text rather than given its own bundle
 * field: past the budget the log's own request events carry no body, so the
 * 5 MiB tail above has no prompt text at all — the one thing a bug report
 * most needs. The sidecar line
 * (`kind: "request-body-latest"`, with the flow_id of its request) sits at
 * the end of the same JSONL, where every existing reader already looks,
 * without changing the bundle's shape. It is bounded by one request body
 * (2 MiB raw), and because a Claude request re-sends the whole conversation,
 * that single body holds every prompt so far.
 */
const LATEST_REQUEST_BODY_FILE = 'latest-request-body.json'

async function readLatestRequestBody(runDir: string): Promise<string | null> {
  try {
    const text = await readFile(join(runDir, LATEST_REQUEST_BODY_FILE), 'utf-8')
    return text.trim().length > 0 ? `${text.trim()}\n` : null
  } catch {
    // Absent is the normal case: the run never passed its budget.
    return null
  }
}


async function readSessionMeta(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}
