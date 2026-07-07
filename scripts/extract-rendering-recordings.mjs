#!/usr/bin/env node
// Extract check-in-safe rendering fixtures from LOCAL session recordings.
//
// The successor to scripts/extract-rendering-fixtures.mjs (which mined frozen
// debug bundles). A session recording is the full rendering INPUT STREAM of a
// live session — a folder `session-recordings/<id>/` with meta.json + an
// append-only events.jsonl of the 9 SessionFeed channels (plan §§2-6). This
// script turns one (or many) local recording folders into redacted, minimized
// fixtures under testing/fixtures/rendering-recordings/, which the golden
// replay suite (recordingCorpus.test.ts) then replays through the real
// pipeline.
//
// The heavy lifting — redaction, structure-only minimization, windowing around
// __note markers, and the HARD GATE that refuses to emit a fixture still
// carrying a SENSITIVE_KEY value — lives in the PURE core
// (src/renderer/src/rendering/replay/redact.ts), reached through the tsx bridge
// scripts/extract-recording-core.mts. This file is only the file-IO wrapper:
// enumerate folders, invoke the core, write outputs, print a summary. Keeping
// the safety logic in one TS module (also exercised by redact.test.ts) is why
// there is no second copy of the regex/caps here to drift.
//
// Redaction mode (plan §5 two-tier model):
//   --mode structure-only   (default) drop free-text bodies, keep the
//                           identity/structure the pipeline keys on. The
//                           innovation — makes most recordings check-in-safe.
//   --mode full-text-capped keep prose truncated to the corpus tiers.
//
// Windowing: with --window <N>, a recording that has __note markers emits one
// fixture per reserved note, each ±N events around the reaction tick, with the
// note's fill text as the fixture description. Without it (or with no notes),
// the whole recording becomes one fixture.
//
// Usage:
//   node scripts/extract-rendering-recordings.mjs [--in <dir>] [--out <dir>]
//        [--only <recordingId>] [--mode structure-only|full-text-capped]
//        [--window <N>]
//
// After extracting, populate each fixture's golden `expected` rows by blessing:
//   AGENT_CODE_RECORDING_BLESS=1 NODE_ENV=test npx vitest run --project unit \
//     src/renderer/src/rendering/__tests__/recordingCorpus.test.ts

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
function flag(name, fallback = null) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}

// Local recordings live in userData (macOS: ~/Library/Application Support/
// agent-code/session-recordings). Overridable so the script can run over an
// exported recording dir. Mirrors extract-rendering-fixtures.mjs's default
// paths.
const IN =
  flag('--in') ??
  join(homedir(), 'Library/Application Support/agent-code/session-recordings')
const OUT = flag('--out') ?? join(process.cwd(), 'testing/fixtures/rendering-recordings')
const ONLY = flag('--only')
const MODE = flag('--mode', 'structure-only')
const WINDOW = flag('--window')

if (!['structure-only', 'full-text-capped'].includes(MODE)) {
  console.error(`invalid --mode ${MODE} (structure-only | full-text-capped)`)
  process.exit(2)
}

// Validate --window here too. The tsx core (extract-recording-core.mts) is the
// AUTHORITATIVE gate, but flag() hands us the raw string and without this check
// we'd spawn `npx tsx` once per recording only for each child to exit 2 — fail
// fast with one clear message instead. --window is an event COUNT (±N events
// around a note tick); Number('nope')→NaN, '-5', and 'Infinity' are all operator
// error that must not silently produce nonsensical fixtures, so only
// non-negative integers pass. WINDOW is a string here; parse then check
// integrality.
if (WINDOW != null) {
  const w = Number(WINDOW)
  if (!Number.isInteger(w) || w < 0) {
    console.error(`invalid --window ${JSON.stringify(WINDOW)} — expected a non-negative integer`)
    process.exit(2)
  }
}

if (!existsSync(IN)) {
  console.log(`no recordings dir at ${IN} — nothing to extract (this is normal until a session is recorded).`)
  process.exit(0)
}

// A recording folder is any child dir with an events.jsonl.
const recordingDirs = readdirSync(IN)
  .map(name => join(IN, name))
  .filter(p => {
    try {
      return statSync(p).isDirectory() && existsSync(join(p, 'events.jsonl'))
    } catch {
      return false
    }
  })

mkdirSync(OUT, { recursive: true })
const summary = []

for (const dir of recordingDirs) {
  const id = dir.split('/').pop()
  if (ONLY && id !== ONLY) continue
  try {
    // The core throws (non-zero exit) if the hard gate trips; execFileSync
    // then throws here and we record the skip loudly — a recording that can't
    // be scrubbed is NEVER written.
    const coreArgs = [
      'tsx',
      '--tsconfig',
      'tsconfig.web.json',
      'scripts/extract-recording-core.mts',
      dir,
      MODE,
    ]
    if (WINDOW) coreArgs.push(WINDOW)
    const out = execFileSync('npx', coreArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
    const fixtures = JSON.parse(out)

    fixtures.forEach((fixture, i) => {
      // One fixture per note-window gets a suffix; a whole-session extraction
      // is just `<id>.json`.
      const suffix = fixtures.length > 1 ? `-w${i}` : ''
      const outPath = join(OUT, `${id}${suffix}.json`)
      writeFileSync(outPath, JSON.stringify(fixture))
      summary.push({
        id: `${id}${suffix}`,
        mode: MODE,
        events: fixture.events.length,
        note: (fixture.meta.note ?? '').slice(0, 40),
        kb: Math.round(JSON.stringify(fixture).length / 1024),
      })
    })
  } catch (err) {
    // execFileSync surfaces the core's stderr (gate reason) in err.stderr.
    const reason = err?.stderr ? String(err.stderr).trim() : String(err).slice(0, 160)
    summary.push({ id, error: reason.slice(0, 160) })
  }
}

console.table(summary)
const ok = summary.filter(s => !s.error).length
console.log(`wrote ${ok}/${summary.length} fixtures to ${OUT}`)
console.log(
  `next: AGENT_CODE_RECORDING_BLESS=1 NODE_ENV=test npx vitest run --project unit ` +
    `src/renderer/src/rendering/__tests__/recordingCorpus.test.ts  (fills golden expected rows)`,
)
