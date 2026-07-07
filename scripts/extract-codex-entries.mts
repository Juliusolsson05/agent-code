#!/usr/bin/env npx tsx
// Codex rollout → committed Entry[] for the rendering-fixture extractor.
//
// WHY a separate .mts helper instead of logic inside the .mjs extractor:
// the rollout→Entry mapping is ~500 lines of provider knowledge
// (mapCodexRolloutToFeedEntries) that already exists, is unit-tested, and
// is exactly what the app itself runs. Re-implementing it in the
// extractor would create a second mapper that drifts — the precise
// failure mode the rewrite exists to kill. tsx resolves the app's
// tsconfig path aliases, so we import the REAL mapper.
//
// Usage: npx tsx scripts/extract-codex-entries.mts <rollout.jsonl> <cutoffMs>
// Prints a JSON array of Entries (timestamp <= cutoff) to stdout.

import { readFileSync } from 'node:fs'

import { mapCodexRolloutToFeedEntries } from '../src/providers/codex/renderer/transcript/rollout'

const [rolloutPath, cutoffArg] = process.argv.slice(2)
if (!rolloutPath || !cutoffArg) {
  console.error('usage: extract-codex-entries.mts <rollout.jsonl> <cutoffMs>')
  process.exit(2)
}
const cutoffMs = Number(cutoffArg)

const entries: unknown[] = []
const rolloutLines = readFileSync(rolloutPath, 'utf8').split('\n')
// Torn-tail tolerance is ONLY for the final non-empty line (rollout read
// mid-write). A malformed line elsewhere is real corruption: silently skipping
// it (the old blanket `continue`) omits committed entries and shifts the
// extracted window, so we warn loudly with file:line before dropping it — the
// final line stays tolerated because a half-flushed tail is expected.
let lastNonEmptyRollout = -1
for (let i = rolloutLines.length - 1; i >= 0; i--) {
  if (rolloutLines[i].trim()) {
    lastNonEmptyRollout = i
    break
  }
}
for (let i = 0; i < rolloutLines.length; i++) {
  const line = rolloutLines[i]
  if (!line.trim()) continue
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    if (i !== lastNonEmptyRollout) {
      console.error(
        `extract-codex-entries: malformed JSON at ${rolloutPath}:${i + 1} — skipping (non-tail line, possible corruption)`,
      )
    }
    continue // torn tail (final line) or corrupt non-final line already reported
  }
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  if (!Number.isNaN(ts) && ts > cutoffMs) continue
  for (const entry of mapCodexRolloutToFeedEntries(record)) {
    entries.push(entry)
  }
}
process.stdout.write(JSON.stringify(entries))
