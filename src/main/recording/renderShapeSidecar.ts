import { readdir, readFile } from 'node:fs/promises'
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
/** Skip absurd single lines defensively — a sidecar line is a coalesced
 *  batch of ≤512 metadata sightings, far below this. */
const MAX_LINE_CHARS = 4 * 1024 * 1024

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
    let body: string
    try {
      body = await readFile(join(SESSION_RECORDING_DIR, dir, 'events.jsonl'), 'utf-8')
    } catch {
      continue // meta-only folder or torn recording — fine, skip
    }
    bytesRead += body.length
    for (const line of body.split('\n')) {
      // Cheap pre-filter before JSON.parse — the sidecar is a needle in a
      // haystack of feed events, and parsing every line of every recording
      // would make the sweep O(all recordings ever).
      if (line.length === 0 || line.length > MAX_LINE_CHARS) continue
      if (!line.includes('"__render_shape"')) continue
      try {
        const parsed = JSON.parse(line) as { ch?: unknown; sightings?: unknown }
        if (parsed.ch !== '__render_shape' || !Array.isArray(parsed.sightings)) continue
        for (const s of parsed.sightings) {
          if (sightings.length >= MAX_SIGHTINGS) {
            truncated = true
            break
          }
          // Inject the recording id so the inbox/report can point back at
          // the source recording (plan §Step 5 traceability). Injected here
          // because the writer deliberately doesn't know its recording id.
          sightings.push(
            typeof s === 'object' && s !== null ? { ...s, sourceRecordingId: dir } : s,
          )
        }
      } catch {
        continue // torn tail — recorder contract tolerates it, so do we
      }
      if (truncated) break
    }
  }
  return { sightings, recordingsScanned: scanned, truncated }
}
