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
for (const line of readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* torn tail line (recording read mid-write) — skip, same as the bundle
       extractor's readJsonl tolerance. */
  }
}

const radius = radiusArg ? Number(radiusArg) : undefined
// extractRecordingFixture THROWS if a SENSITIVE_KEY value survives — let it
// propagate as a non-zero exit so the .mjs skips this recording loudly.
const fixtures = extractRecordingFixture({ meta, events }, { mode, windowRadius: radius })
process.stdout.write(JSON.stringify(fixtures))
