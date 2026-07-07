// tsx bridge: run the PURE extraction core (redact + minimize + window +
// hard-gate) over one on-disk recording folder and print the resulting
// fixtures as JSON.
//
// WHY a tsx bridge instead of reimplementing redaction in the .mjs: the
// redaction regex, caps, and structural allowlist are the load-bearing safety
// gate. A second copy in plain JS could drift and let the gate pass a value
// the TS side considers a leak. So the .mjs stays a thin file-IO wrapper and
// shells to this bridge, which imports the ONE implementation
// (rendering/replay/redact.ts) — the exact same module the replay tests use.
// This mirrors how extract-rendering-fixtures.mjs shells to
// extract-codex-entries.mts to reuse the real in-app Codex mapper.
//
// Usage: tsx --tsconfig tsconfig.web.json scripts/extract-recording-core.mts \
//          <recordingDir> <mode> [windowRadius]
// Prints a JSON array of fixtures to stdout. Exits non-zero (with the reason
// on stderr) if the hard gate trips.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  extractRecordingFixture,
  type RecordingEvent,
  type RedactionMode,
} from '../src/renderer/src/rendering/replay/redact.ts'

const [dir, modeArg, radiusArg] = process.argv.slice(2)
if (!dir) {
  console.error('usage: extract-recording-core.mts <recordingDir> <mode> [windowRadius]')
  process.exit(2)
}
const mode = (modeArg ?? 'structure-only') as RedactionMode

// meta.json is a convenience header; the events stream is the source of truth.
// Tolerate a missing/torn meta so a crashed recording is still extractable.
let meta: Record<string, unknown> = {}
try {
  meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
} catch {
  /* header missing — reconstruct nothing; events carry sessionId etc. */
}

const events: RecordingEvent[] = []
const eventsPath = join(dir, 'events.jsonl')
const eventLines = readFileSync(eventsPath, 'utf8').split('\n')
// Torn-tail tolerance is ONLY for the final non-empty line: a recording read
// mid-write can leave a half-flushed last record, which is expected and benign.
// A malformed line ANYWHERE ELSE is real corruption — silently dropping it (the
// old blanket catch) splices a hole into the event stream and mints a
// plausible-but-wrong fixture the golden corpus would then inherit, so we warn
// loudly with file:line and continue best-effort instead of pretending the
// stream was intact.
let lastNonEmptyEvent = -1
for (let i = eventLines.length - 1; i >= 0; i--) {
  if (eventLines[i].trim()) {
    lastNonEmptyEvent = i
    break
  }
}
for (let i = 0; i < eventLines.length; i++) {
  const line = eventLines[i]
  if (!line.trim()) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    if (i === lastNonEmptyEvent) {
      /* torn tail line (recording read mid-write) — tolerated. */
    } else {
      console.error(
        `extract-recording-core: malformed JSON at ${eventsPath}:${i + 1} — skipping (non-tail line, possible corruption)`,
      )
    }
  }
}

const radius = radiusArg ? Number(radiusArg) : undefined
// Validate the window radius BEFORE it reaches extractRecordingFixture. It is
// an event COUNT (±N events around a note tick), so the only meaningful values
// are non-negative integers. Number() previously let 'nope' → NaN, '-5' → -5,
// and 'Infinity' → Infinity flow straight through as windowRadius: NaN silently
// disables windowing, negatives/Infinity produce nonsensical slices, and every
// one of these STILL exited 0 — a silent-garbage failure the caller and the
// golden corpus would inherit. Operator error must fail loudly here rather than
// mint a bogus fixture.
if (radius !== undefined && (!Number.isInteger(radius) || radius < 0)) {
  console.error(
    `extract-recording-core: invalid window radius ${JSON.stringify(radiusArg)} — expected a non-negative integer`,
  )
  process.exit(2)
}
// extractRecordingFixture THROWS if a SENSITIVE_KEY value survives — let it
// propagate as a non-zero exit so the .mjs skips this recording loudly.
const fixtures = extractRecordingFixture({ meta, events }, { mode, windowRadius: radius })
process.stdout.write(JSON.stringify(fixtures))
