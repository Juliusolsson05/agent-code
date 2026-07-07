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
for (const line of readFileSync(rolloutPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    continue // torn tail line
  }
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  if (!Number.isNaN(ts) && ts > cutoffMs) continue
  for (const entry of mapCodexRolloutToFeedEntries(record)) {
    entries.push(entry)
  }
}
process.stdout.write(JSON.stringify(entries))
