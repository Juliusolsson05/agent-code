#!/usr/bin/env npx tsx --tsconfig tsconfig.web.json
// Fingerprint → redacted shape-fixture DRAFT (Phase 3, PR #555).
//
// Follows the plan's §Step 7: take one structural fingerprint from the
// Unknown Shape Inbox, locate its sightings in local session recordings via
// the __render_shape sidecar lines, and emit the smallest safe evidence
// package into testing/fixtures/rendering-shapes/<provider>/<slug>/.
//
// The output is a DRAFT: draft.json holds the redacted ±window of real
// events around each sighting plus the sighting metadata itself. A human
// (or the next agent) curates it into the final/prefixes/expected files and
// the catalog entry — classification stays a reviewed code change (plan
// §Step 6), so this script never edits shapes.ts.
//
// SAFETY: redaction runs through the SAME redactRecording + the SAME
// findSensitiveSurvivors hard gate as recording extraction (one
// implementation — scripts/audit-sensitive-core.mts documents why a second
// copy is forbidden). If any SENSITIVE_KEY value survives, the script exits
// non-zero and writes NOTHING.
//
// Run: npx tsx --tsconfig tsconfig.web.json scripts/extract-rendering-shape.mts \
//        <fingerprint> [--recordings <dir>] [--window 8] [--mode full-text-capped|structure-only]

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  findSensitiveSurvivors,
  redactRecording,
  type Recording,
  type RecordingEvent,
  type RedactionMode,
} from '../src/renderer/src/rendering/replay/redact.ts'

const args = process.argv.slice(2)
const fingerprint = args[0]
if (!fingerprint || !/^fp1-[0-9a-f]{8}$/.test(fingerprint)) {
  console.error('usage: extract-rendering-shape.mts <fp1-xxxxxxxx> [--recordings <dir>] [--window 8] [--mode full-text-capped]')
  process.exit(2)
}
function flag(name: string, fallback: string): string {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const RECORDINGS_DIR = flag('--recordings', join(homedir(), '.config', 'agent-code', 'session-recordings'))
const WINDOW = Number(flag('--window', '8'))
// DEFAULT structure-only (review finding A2): full-text-capped keeps every
// non-secret-keyed string up to 8000 chars — prompts, commands, file
// contents — and the sensitive-survivor gate only detects values under
// secret-NAMED keys, so a token pasted into chat would sail through into a
// git-adjacent draft. structure-only is the safe default; full text is an
// explicit, warned opt-in for payloads whose parsing evidence needs prose.
const MODE_RAW = flag('--mode', 'structure-only')
if (MODE_RAW !== 'structure-only' && MODE_RAW !== 'full-text-capped') {
  console.error(`unknown --mode "${MODE_RAW}" (structure-only | full-text-capped)`)
  process.exit(2)
}
const MODE = MODE_RAW as RedactionMode
if (MODE === 'full-text-capped') {
  console.error(
    'WARNING: full-text-capped keeps free text (prompts/commands/outputs). The hard gate only\n' +
      'catches secret-NAMED keys — review draft.json line by line before it goes anywhere shared.',
  )
}

type Draft = {
  recordingId: string
  sighting: unknown
  /** Redacted real events around the sighting's sidecar line — the parsing
   *  evidence a fixture needs (plan §Step 7 "redacted and capped raw
   *  context needed to reproduce parsing"). */
  window: RecordingEvent[]
}

const drafts: Draft[] = []
let provider = 'unknown'

for (const dir of readdirSync(RECORDINGS_DIR, { withFileTypes: true }).filter(e => e.isDirectory())) {
  let lines: string[]
  let meta: Record<string, unknown> = {}
  try {
    lines = readFileSync(join(RECORDINGS_DIR, dir.name, 'events.jsonl'), 'utf-8').split('\n')
    meta = JSON.parse(readFileSync(join(RECORDINGS_DIR, dir.name, 'meta.json'), 'utf-8'))
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
    if (!line || line.ch !== '__render_shape') return
    const sightings = (line as { sightings?: unknown[] }).sightings ?? []
    for (const s of sightings) {
      const sighting = s as { structuralFingerprint?: string; provider?: string }
      if (sighting.structuralFingerprint !== fingerprint) continue
      provider = sighting.provider ?? provider
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
      const recording: Recording = { meta, events: [...realBefore, ...realAfter] }
      const redacted = redactRecording(recording, MODE)
      drafts.push({ recordingId: dir.name, sighting: s, window: redacted.events })
    }
  })
}

if (drafts.length === 0) {
  console.error(`no sightings of ${fingerprint} in ${RECORDINGS_DIR} — was capture armed?`)
  process.exit(1)
}

// THE HARD GATE — refuse to write anything carrying a sensitive survivor.
const survivors = findSensitiveSurvivors(drafts)
if (survivors.length > 0) {
  console.error(`REFUSING to write: ${survivors.length} sensitive value(s) survived redaction:\n  ${survivors.slice(0, 10).join('\n  ')}`)
  process.exit(3)
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
      redaction: MODE,
      extractedAt: new Date().toISOString(),
      drafts: drafts.slice(0, 5), // a handful of windows is plenty for curation
    },
    null,
    1,
  ),
)
console.log(`wrote ${join(outDir, 'draft.json')} (${drafts.length} sighting(s), ${Math.min(drafts.length, 5)} kept)`)
console.log('next: curate into final.json/prefixes.json/expected.json and land a catalog entry (reviewed change).')
