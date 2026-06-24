import { readFile, readdir, stat } from 'node:fs/promises'
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

    const eventsPath = join(latest.runDir, 'proxy-events.jsonl')
    const proxyEvents = await readEventsTail(eventsPath, latest.size)
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
// bundle silently misses the proxy log. Delegates to the shared helper (no
// fallback — an empty/no-match segment is the reader's "not found" signal).
function sanitiseSegment(value: string): string {
  return sanitizePathSegment(value)
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
  try {
    const entries = await readdir(projectDir, { withFileTypes: true })
    return {
      segments: entries.filter(e => e.isDirectory()).map(e => e.name),
      match: sessionKey ? 'fallback' : 'exact',
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


async function readEventsTail(path: string, size: number): Promise<string | null> {
  try {
    if (size <= PROXY_EVENTS_BUNDLE_MAX_BYTES) {
      return await readFile(path, 'utf-8')
    }
    // Read the trailing PROXY_EVENTS_BUNDLE_MAX_BYTES bytes. We can't
    // use readFile with a position arg (no slice option in fs.promises
    // readFile), so open + read directly.
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const start = size - PROXY_EVENTS_BUNDLE_MAX_BYTES
      const buf = Buffer.alloc(PROXY_EVENTS_BUNDLE_MAX_BYTES)
      await handle.read(buf, 0, PROXY_EVENTS_BUNDLE_MAX_BYTES, start)
      // Drop the first partial line so consumers always see a clean
      // JSONL boundary at byte 0 of the captured content.
      const content = buf.toString('utf-8')
      const firstNewline = content.indexOf('\n')
      const trimmed = firstNewline >= 0 ? content.slice(firstNewline + 1) : content
      const droppedBytes = size - trimmed.length
      const header = JSON.stringify({
        kind: 'truncated',
        reason: `proxy-events.jsonl exceeded ${PROXY_EVENTS_BUNDLE_MAX_BYTES} bytes; only the trailing portion is included in this bundle. Full log on disk: ${path}`,
        dropped_bytes: droppedBytes,
      })
      return `${header}\n${trimmed}`
    } finally {
      await handle.close()
    }
  } catch {
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
