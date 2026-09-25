// extract-agent-activity-runtimes.mts — Stage 1 (runtime half) of
// docs/decomposition/agent-activity-redesign.md
//
// Pulls the REAL per-session runtime state out of the local debug-bundle
// corpus and writes it to testing/fixtures/agent-activity/ as the corpus the
// Stage 2 row model is graded against.
//
// WHY the debug bundles and not a new instrument
// ----------------------------------------------
// The decomposition's Stage 1 asks for "a runtime-side capture that records,
// for each session, the fields a row needs". Agent Code ALREADY writes exactly
// that: every debug bundle contains a `state-snapshot.json`, which is the
// renderer's own `SessionRuntime` for one session at the moment the bundle was
// taken, written by the app itself with no interpretation in between. Building
// a second recorder to collect fields that are already being recorded would add
// a instrument to maintain and would produce strictly less: the bundles span
// months of real use, four providers, and the failure states (a dead process, a
// usage limit, a compaction mid-turn, a queue that never went) that are the
// whole point of an attention bucket and that a capture taken on one afternoon
// would almost certainly miss.
//
// The control-MCP fleet recordings (live-fleet-*.json, owner-fleet-*.json) are
// the OTHER half: they carry identity and placement for a whole window at one
// instant, which is what fleet-level assertions (grouping, ordering, counts)
// need and what a bundle cannot give. Neither replaces the other.
//
// WHY the screen text is dropped
// ------------------------------
// `screen`, `screenMarkdown`, `recentScreen` and `recentScreenMarkdown` are the
// terminal's rendered output — ~10 KB each, four near-copies per snapshot, and
// the single most privacy-loaded field in the file (they contain whatever was on
// screen: file contents, prompts, stack traces). The row model never reads them:
// it branches on status, phase, process state, conditions, queue length and
// timestamps. Same argument, same shape, as scripts/extract-image-fixtures.mts —
// structure and every field the code reads kept verbatim, the one payload the
// code cannot see recorded as a length and removed.
//
// Everything else is verbatim, INCLUDING the ugly parts: `activityStatus`
// strings like "Honking…", `inputReadinessReason` tokens, half-populated
// `promptDelivery` objects. Those are the shapes a hand-written fixture would
// smooth over.
//
// Usage: npx tsx scripts/extract-agent-activity-runtimes.mts

import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const BUNDLE_ROOTS = [
  join(homedir(), '.config/agent-code/debug-bundles'),
  join(homedir(), '.config/agent-code/debug-bundles/manual'),
  join(homedir(), '.config/agent-code/debug-bundles/autosave'),
]
const OUT = join(process.cwd(), 'testing/fixtures/agent-activity/runtime-states.json')

/** The four screen mirrors. Recorded as lengths, then removed — see the header. */
const SCREEN_FIELDS = ['screen', 'screenMarkdown', 'recentScreen', 'recentScreenMarkdown'] as const

/**
 * The other unbounded payloads, trimmed to their COUNTS.
 *
 * Same rule as the screen mirrors, applied where the measurement sent me:
 * `subAgents[*].toolCalls` is 4.4 MB of the 11.6 MB raw corpus and
 * `workActivity.timeline` + `.recentKeys` are another 3 MB. A row says "3
 * subagents running" and "last active 4 minutes ago"; it never reads a
 * subagent's tool call or a touched-file timeline entry. Every structural
 * field AROUND them — each subagent's id, type, description, status,
 * startedAt, lastActivityAt, turnCount, droppedToolCalls; workActivity's
 * active/primary/touched/updatedAt — is kept verbatim, so the shapes stay and
 * only the arrays the model cannot see become numbers.
 *
 * The counts are recorded rather than dropped because "how many" is the part a
 * row could legitimately want, and a fixture that silently zeroed them would
 * make an agent with 40 running tool calls look identical to an idle one.
 */
function trimBulk(runtime: Snapshot): Record<string, number> {
  const trimmed: Record<string, number> = {}
  const subAgents = runtime.subAgents as Record<string, Record<string, unknown>> | undefined
  if (subAgents) {
    let toolCalls = 0
    for (const entry of Object.values(subAgents)) {
      const calls = entry.toolCalls
      if (Array.isArray(calls)) {
        toolCalls += calls.length
        entry.toolCallCount = calls.length
        delete entry.toolCalls
      }
    }
    trimmed.subAgentToolCalls = toolCalls
  }
  const workActivity = runtime.workActivity as Record<string, unknown> | undefined
  if (workActivity) {
    for (const field of ['timeline', 'recentKeys'] as const) {
      const value = workActivity[field]
      if (Array.isArray(value)) {
        trimmed[`workActivity.${field}`] = value.length
        workActivity[`${field}Count`] = value.length
        delete workActivity[field]
      }
    }
  }
  return trimmed
}

type Snapshot = Record<string, unknown>

async function bundleDirs(): Promise<string[]> {
  const found: string[] = []
  for (const root of BUNDLE_ROOTS) {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(root, entry)
      // A bundle directory is named <iso>-<shortid>; anything else (the
      // rolled-up .jsonl, the nested `manual`/`autosave` roots) is skipped by
      // the state-snapshot check below rather than by guessing from the name.
      try {
        if (!(await stat(dir)).isDirectory()) continue
      } catch {
        continue
      }
      found.push(dir)
    }
  }
  return found.sort()
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const records: unknown[] = []
  const seen = new Set<string>()

  for (const dir of await bundleDirs()) {
    const snapshot = await readJson(join(dir, 'state-snapshot.json'))
    const manifest = await readJson(join(dir, 'manifest.json'))
    if (!snapshot || !manifest) continue

    const sessionId = String(manifest.sessionId ?? '')
    if (!sessionId) continue
    // One record per (session, capture). The same session bundled twice is two
    // real observations of it, minutes apart, and both are worth keeping —
    // but the same directory read twice (the roots overlap) is not.
    const dedupeKey = `${sessionId}@${String(manifest.capturedAt ?? '')}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    // Structured-clone so trimBulk's in-place edits cannot reach the parsed
    // bundle another record might share.
    const runtime: Snapshot = JSON.parse(JSON.stringify(snapshot)) as Snapshot
    const screenLengths: Record<string, number> = {}
    for (const field of SCREEN_FIELDS) {
      const value = runtime[field]
      if (typeof value === 'string') screenLengths[field] = value.length
      delete runtime[field]
    }
    const trimmedCounts = trimBulk(runtime)

    records.push({
      sessionId,
      provider: manifest.kind ?? null,
      capturedAt: manifest.capturedAt ?? null,
      capturedAtIso: manifest.capturedAtIso ?? null,
      // `reason` says whether the user pressed the bundle key ('manual') or the
      // app caught something. An auto-captured bundle is, by construction, a
      // session in trouble — which is the population an attention bucket is for.
      reason: manifest.reason ?? null,
      projectDir: manifest.projectDir ?? null,
      appVersion: (manifest.build as Record<string, unknown> | undefined)?.version ?? null,
      screenLengths,
      trimmedCounts,
      runtime,
    })
  }

  const providers = new Map<string, number>()
  let withConditions = 0
  let withQueue = 0
  let exited = 0
  let withProcessError = 0
  let limitHit = 0
  for (const record of records as Array<{ provider: unknown; runtime: Snapshot }>) {
    const key = String(record.provider ?? 'unknown')
    providers.set(key, (providers.get(key) ?? 0) + 1)
    const conditions = record.runtime.conditions as { conditions?: Record<string, unknown> } | null
    if (conditions?.conditions && Object.keys(conditions.conditions).length > 0) withConditions++
    if (Array.isArray(record.runtime.queuedMessages) && record.runtime.queuedMessages.length > 0) withQueue++
    if (record.runtime.exited !== null && record.runtime.exited !== undefined) exited++
    if (record.runtime.processError) withProcessError++
    if (record.runtime.limitHit) limitHit++
  }

  const fixture = {
    provenance:
      'Every `state-snapshot.json` in the local debug-bundle corpus: the renderer\'s own SessionRuntime for one real session at the moment a bundle was taken, written by the app. Generated by scripts/extract-agent-activity-runtimes.mts — do not hand-edit, re-run it. The four screen mirrors are removed and their lengths recorded (see the script header); every other field is verbatim, including the ugly ones.',
    generatedBy: 'scripts/extract-agent-activity-runtimes.mts',
    totals: {
      records: records.length,
      byProvider: Object.fromEntries([...providers].sort()),
      withALiveCondition: withConditions,
      withAQueuedPrompt: withQueue,
      exited,
      withAProcessError: withProcessError,
      withAUsageLimit: limitHit,
    },
    records,
  }

  await writeFile(OUT, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  console.log(`wrote ${records.length} runtime states to ${OUT}`)
  console.log(fixture.totals)
}

await main()
