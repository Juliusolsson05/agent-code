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

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RecordingEvent } from '../src/renderer/src/rendering/replay/redact.ts'

const args = process.argv.slice(2)
const fingerprint = args[0]
if (!fingerprint || !/^fp2-[0-9a-f]{8}$/.test(fingerprint)) {
  console.error('usage: extract-rendering-shape.mts <fp2-xxxxxxxx> [--recordings <dir>] [--window 8]')
  process.exit(2)
}
function flag(name: string, fallback: string): string {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const RECORDINGS_DIR = flag('--recordings', join(homedir(), '.config', 'agent-code', 'session-recordings'))
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
let provider = 'unknown'
const PROVIDERS = new Set(['claude', 'codex', 'opencode', 'unknown'])
const MAX_RECORDINGS = 200
const MAX_RECORDING_BYTES = 64 * 1024 * 1024
const MAX_DRAFTS_SCANNED = 20

for (const dir of readdirSync(RECORDINGS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).slice(0, MAX_RECORDINGS)) {
  if (drafts.length >= MAX_DRAFTS_SCANNED) break
  let lines: string[]
  try {
    const eventPath = join(RECORDINGS_DIR, dir.name, 'events.jsonl')
    if (statSync(eventPath).size > MAX_RECORDING_BYTES) continue
    lines = readFileSync(eventPath, 'utf-8').split('\n')
  } catch {
    continue
  }
  const parsed: (RecordingEvent | null)[] = lines.map(l => {
    try {
      return l ? (JSON.parse(l) as RecordingEvent) : null
    } catch {
      return null // torn tail tolerated, same as replay
    }
  })
  parsed.forEach((line, i) => {
    if (drafts.length >= MAX_DRAFTS_SCANNED) return
    if (!line || line.ch !== '__render_shape') return
    const sightings = (line as { sightings?: unknown[] }).sightings ?? []
    for (const s of sightings) {
      if (drafts.length >= MAX_DRAFTS_SCANNED) break
      const sighting = s as { structuralFingerprint?: string; provider?: string }
      if (sighting.structuralFingerprint !== fingerprint) continue
      if (!sighting.provider || !PROVIDERS.has(sighting.provider)) continue
      if (provider !== 'unknown' && provider !== sighting.provider) continue
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
        recordingId: dir.name,
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

const outDir = join(process.cwd(), 'testing', 'fixtures', 'rendering-shapes', provider, fingerprint)
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'draft.json'),
  JSON.stringify(
    {
      v: 1,
      kind: 'render-shape-draft',
      fingerprint,
      provider,
      redaction: 'none',
      extractedAt: new Date().toISOString(),
      drafts: drafts.slice(0, 5), // a handful of windows is plenty for curation
    },
    null,
    1,
  ),
)
console.log(`wrote ${join(outDir, 'draft.json')} (${drafts.length} sighting(s), ${Math.min(drafts.length, 5)} kept)`)
console.log('next: curate into final.json/prefixes.json/expected.json and land a catalog entry (reviewed change).')
