#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Fingerprint → complete local shape-fixture DRAFT (Phase 3, PR #555).
//
// Follows the plan's §Step 7: take one structural fingerprint from the
// Unknown Shape Inbox, locate its sightings in local session recordings via
// the __render_shape sidecar lines, and emit the smallest useful evidence
// package into testing/fixtures/rendering-shapes/<provider>/<slug>/.
//
// The output is a DRAFT: draft.json holds the exact bounded ±window of real
// events around each sighting plus the sighting metadata itself. A human
// (or the next agent) curates it into the final/prefixes/expected files and
// the catalog entry — classification stays a reviewed code change (plan
// §Step 6), so this script never edits shapes.ts.
//
// DEV-EVIDENCE CONTRACT: do not redact or structurally collapse this local
// draft. Session recording is an explicit developer-mode action and the
// entire point of the extractor is to preserve the provider evidence needed
// to understand a shape we did not anticipate. The draft is not a checked-in
// fixture; curation remains the deliberate boundary before anything enters
// the repository.
//
// Run: npx tsx --tsconfig tsconfig.web.json scripts/extract-rendering-shape.mts \
//        <fingerprint> [--recordings <dir>] [--window 8]

import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RecordingEvent } from '../src/renderer/src/rendering/replay/redact.ts'

const args = process.argv.slice(2)
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const fingerprint = args[0]
if (!fingerprint || !/^fp2-[0-9a-f]{8}$/.test(fingerprint)) {
  console.error(
    'usage: extract-rendering-shape.mts <fp2-xxxxxxxx> [--recordings <dir>] [--window 8]',
  )
  process.exit(2)
}
function flag(name: string, fallback: string): string {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  const value = args[i + 1]
  // Treat another option as a missing value. The previous helper swallowed
  // `--window` as the recordings directory in `--recordings --window 8`, then
  // failed later with a misleading ENOENT (and interpreted 8 as no option at
  // all). Fail at the argument boundary where the operator can fix the call.
  if (!value || value.startsWith('--')) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return value
}
const RECORDINGS_DIR = resolve(
  process.cwd(),
  flag('--recordings', join(homedir(), '.config', 'agent-code', 'session-recordings')),
)
const WINDOW = Number(flag('--window', '8'))
if (!Number.isInteger(WINDOW) || WINDOW < 0 || WINDOW > 100) {
  console.error('--window must be an integer from 0 through 100')
  process.exit(2)
}
type Draft = {
  recordingId: string
  sighting: unknown
  /** Exact real events around the sighting's sidecar line. The window is
   *  bounded for script/runtime safety, but its admitted events are not
   *  altered: an unknown renderer shape often depends on the very scalar
   *  content a structure-only transform would erase. */
  window: RecordingEvent[]
}

const drafts: Draft[] = []
let provider: string | null = null
const PROVIDERS = new Set(['claude', 'codex', 'opencode', 'unknown'])
const MAX_RECORDINGS = 200
const MAX_RECORDING_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_DRAFTS_SCANNED = 20
let malformedRecords = 0

function readBoundedRecordingLines(eventPath: string): Buffer[] {
  const fileBytes = statSync(eventPath).size
  const admittedBytes = Math.min(fileBytes, MAX_RECORDING_BYTES)
  if (admittedBytes === 0) return []

  // WHY an explicit bounded read instead of readFileSync-after-stat: a live
  // recording can grow after stat, and readFileSync would then allocate/read
  // beyond the same 64 MiB contract used by the inbox and audit. The extractor
  // needs source-event windows, so it materializes the admitted prefix, but it
  // must never admit more bytes than those other two evidence consumers.
  const fd = openSync(eventPath, 'r')
  const buffer = Buffer.allocUnsafe(admittedBytes)
  let offset = 0
  try {
    while (offset < admittedBytes) {
      const read = readSync(fd, buffer, offset, admittedBytes - offset, offset)
      if (read === 0) break
      offset += read
    }
  } finally {
    closeSync(fd)
  }

  const admitted = buffer.subarray(0, offset)
  const lines: Buffer[] = []
  let start = 0
  while (start < admitted.length) {
    const newline = admitted.indexOf(0x0a, start)
    if (newline === -1) break
    const raw = admitted.subarray(start, newline)
    const framed = raw.length > 0 && raw[raw.length - 1] === 0x0d
      ? raw.subarray(0, raw.length - 1)
      : raw
    // Count the CR framing byte exactly as the inbox and audit splitters do.
    // Stripping it before applying the policy made a CRLF record with exactly
    // 4 MiB of JSON bytes extractor-visible but invisible to the other two
    // consumers. Newline framing is excluded everywhere; the optional CR is
    // retained for the byte admission decision and removed only before parse.
    if (raw.length <= MAX_LINE_BYTES) lines.push(framed)
    else malformedRecords += 1
    start = newline + 1
  }
  // A complete, uncapped file may legally omit its final newline. A capped
  // prefix may not: decoding that tail could accept split UTF-8 or a
  // coincidentally complete JSON prefix that was never a committed record.
  if (fileBytes <= offset && start < admitted.length) {
    const tail = admitted.subarray(start)
    if (tail.length <= MAX_LINE_BYTES) lines.push(tail)
    else malformedRecords += 1
  }
  return lines
}

let recordingDirs: string[]
try {
  recordingDirs = readdirSync(RECORDINGS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    // Match the audit and inbox: recording IDs begin with an ISO timestamp,
    // so lexical newest-first ordering gives deterministic bounded selection
    // and prioritizes the drift the developer just observed.
    .sort()
    .reverse()
    .slice(0, MAX_RECORDINGS)
} catch {
  console.error(`no recordings directory at ${RECORDINGS_DIR}`)
  process.exit(1)
}

for (const dir of recordingDirs) {
  if (drafts.length >= MAX_DRAFTS_SCANNED) break
  let lines: Buffer[]
  try {
    const eventPath = join(RECORDINGS_DIR, dir, 'events.jsonl')
    lines = readBoundedRecordingLines(eventPath)
  } catch {
    continue
  }
  const parsed: (RecordingEvent | null)[] = lines.map(line => {
    try {
      if (line.length === 0) return null
      const value = JSON.parse(line.toString('utf8')) as unknown
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as { t?: unknown }).t !== 'number' ||
        !Number.isFinite((value as { t: number }).t) ||
        typeof (value as { wall?: unknown }).wall !== 'number' ||
        !Number.isFinite((value as { wall: number }).wall) ||
        typeof (value as { ch?: unknown }).ch !== 'string'
      ) {
        malformedRecords += 1
        return null
      }
      return value as RecordingEvent
    } catch {
      malformedRecords += 1
      return null // torn tail tolerated, same as replay
    }
  })
  parsed.forEach((line, i) => {
    if (drafts.length >= MAX_DRAFTS_SCANNED) return
    if (!line || line.ch !== '__render_shape') return
    const sightings = (line as unknown as { sightings?: unknown }).sightings
    if (!Array.isArray(sightings)) {
      malformedRecords += 1
      return
    }
    for (const s of sightings) {
      if (drafts.length >= MAX_DRAFTS_SCANNED) break
      if (typeof s !== 'object' || s === null || Array.isArray(s)) {
        malformedRecords += 1
        continue
      }
      const sighting = s as {
        structuralFingerprint?: string
        provider?: string
      }
      if (sighting.structuralFingerprint !== fingerprint) continue
      if (!sighting.provider || !PROVIDERS.has(sighting.provider)) continue
      if (provider !== null && provider !== sighting.provider) continue
      provider = sighting.provider
      // ±window of REAL channel events around the sidecar line. The sidecar
      // is appended within one flush interval of the paint, so its position
      // bounds the source events tightly enough for a draft.
      const realBefore: RecordingEvent[] = []
      for (let j = i - 1; j >= 0 && realBefore.length < WINDOW; j--) {
        const e = parsed[j]
        if (e && !e.ch.startsWith('__')) realBefore.unshift(e)
      }
      const realAfter: RecordingEvent[] = []
      for (let j = i + 1; j < parsed.length && realAfter.length < WINDOW; j++) {
        const e = parsed[j]
        if (e && !e.ch.startsWith('__')) realAfter.push(e)
      }
      drafts.push({
        recordingId: dir,
        sighting: s,
        window: [...realBefore, ...realAfter],
      })
    }
  })
}

if (drafts.length === 0) {
  console.error(`no sightings of ${fingerprint} in ${RECORDINGS_DIR} — was capture armed?`)
  process.exit(1)
}

if (malformedRecords > 0) {
  console.error(`ignored ${malformedRecords} malformed/torn recording records while extracting`)
}
const outDir = join(REPO_ROOT, 'testing', 'fixtures', 'rendering-shapes', provider!, fingerprint)
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'draft.json'),
  JSON.stringify(
    {
      v: 1,
      kind: 'render-shape-draft',
      fingerprint,
      provider: provider!,
      redaction: 'none',
      extractedAt: new Date().toISOString(),
      drafts: drafts.slice(0, 5), // a handful of windows is plenty for curation
    },
    null,
    1,
  ),
)
console.log(
  `wrote ${join(outDir, 'draft.json')} (${drafts.length} sighting(s), ${Math.min(drafts.length, 5)} kept)`,
)
console.log(
  'next: curate into final.json/prefixes.json/expected.json and land a catalog entry (reviewed change).',
)
