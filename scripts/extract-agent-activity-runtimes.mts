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
// Usage (steering q79 — the tracked fixture is never a live output):
//   Stage a live extraction (into a fresh temp directory it prints; a person audits it before any copy):
//     npx tsx --tsconfig tsconfig.node.json scripts/extract-agent-activity-runtimes.mts
//   Reproduce the committed fixture from the one recorded corpus (the only writer of the tracked file):
//     npx tsx --tsconfig tsconfig.node.json scripts/extract-agent-activity-runtimes.mts --redact-from <15e43abe^ blob> --home-user <recorder>
//   Promotion of a staged live file into testing/fixtures/agent-activity/runtime-states.json is a
//   MANUAL copy after a key-by-key privacy audit, never a script step.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import {
  assertHomesBelongTo,
  assertNoForeignHome,
  createAgentActivityRedactor,
  requireHomeUser,
  RUNTIME_STATES_PROVENANCE,
} from './agent-activity-redaction-policy.js'

const BUNDLE_ROOTS = [
  join(homedir(), '.config/agent-code/debug-bundles'),
  join(homedir(), '.config/agent-code/debug-bundles/manual'),
  join(homedir(), '.config/agent-code/debug-bundles/autosave'),
]
const OUT = join(process.cwd(), 'testing/fixtures/agent-activity/runtime-states.json')
/**
 * Where a LIVE extraction writes: a fresh directory it creates itself under the system temp dir,
 * never an existing path and never the repository.
 *
 * WHY no output path at all (review of #1353; steering q79/q80 — a scope NARROWING after two
 * rounds of path validation each had a bypass): the live run wrote the tracked fixture directly,
 * then an `--out` staging path could be a symlink (or sit under one) that points back at it. A
 * directory `mkdtemp` has just created cannot already contain a link, and nothing about it needs
 * checking. The tracked `runtime-states.json` changes ONLY through `--redact-from` (the one
 * recorded corpus) or a person copying a staged file in after a key-by-key privacy audit.
 */
async function stagingFile(root: string): Promise<string> {
  const dir = await mkdtemp(join(root, 'agent-activity-staging-'))
  return join(dir, 'runtime-states.json')
}

/**
 * The real temp root, refused when it lies inside a git worktree.
 *
 * WHY (steering q81): `os.tmpdir()` follows `$TMPDIR`, so a hostile or careless TMPDIR (the repo
 * itself, or a symlink into it) put the staged, UNAUDITED file inside the working tree, where an
 * ordinary `git add -A` would commit it. The root is realpath'd first (so a symlink into a repo is
 * judged by where it lands), then git is asked whether that directory is in any worktree. Checked
 * before a single bundle is read, so a refusal leaves no bytes anywhere. If git cannot answer
 * (not installed), the run refuses: ambiguity fails closed.
 */
function stagingRoot(): string {
  const root = realpathSync(tmpdir())
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' })
  if (probe.error !== undefined) throw new Error('cannot run git to check the temp directory; refusing to stage')
  if (probe.status === 0) {
    throw new Error('the temp directory (TMPDIR) is inside a git worktree; point TMPDIR outside any repository')
  }
  return root
}

/** sha256 of `git show 15e43abe^:testing/fixtures/agent-activity/runtime-states.json` (blob d2653405). */
const RECORDED_CORPUS_SHA256 = '39d3fac8b937604410ca5f0728351ba5d684ac2ecfea31c35c790b3d1853f867'

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
  // Before any bundle is read (steering q81): a refused root leaves nothing behind.
  const root = stagingRoot()
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
    provenance: RUNTIME_STATES_PROVENANCE,
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

  const homeUser = homedir().split('/').pop() ?? ''
  assertHomesBelongTo(JSON.stringify(fixture), homeUser)
  const redacted = `${JSON.stringify(createAgentActivityRedactor(homeUser)(fixture), null, 2)}\n`
  assertNoForeignHome(redacted, homeUser)
  const out = await stagingFile(root)
  // 'wx': the file is new in a directory made a moment ago; anything already there is refused.
  await writeFile(out, redacted, { encoding: 'utf8', flag: 'wx' })
  console.log(`staged ${records.length} runtime states in ${out}: audit every key and string before copying it over ${OUT}`)
  console.log(fixture.totals)
}

/**
 * `--redact-from <pre-redaction.json> --home-user <recorder>` (both required): re-run ONLY the privacy pass over the
 * ONE recorded pre-redaction fixture (checked by sha256, see redactFrom) and write the result to OUT.
 *
 * WHY (review of #1353, steering q70/q72): the debug bundles the corpus came from are gone from
 * most machines, but the pre-redaction fixture is in git history (`15e43abe^`). This mode is how the
 * committed file was produced, and re-running it is how anyone proves the committed file is the
 * policy's output rather than a hand edit:
 *   git show 15e43abe^:testing/fixtures/agent-activity/runtime-states.json > /tmp/rs.json
 *   npx tsx scripts/extract-agent-activity-runtimes.mts --redact-from /tmp/rs.json --home-user <recorder>
 *   git diff --exit-code testing/fixtures/agent-activity/runtime-states.json
 * The recorder's home user has to be named because it is not this machine's user in general: the
 * mode refuses to run without it (steering q74), and refuses to write output that still names any
 * home directory other than the placeholder.
 */
async function redactFrom(source: string, homeUser: string): Promise<void> {
  const text = await readFile(source, 'utf8')
  assertHomesBelongTo(text, homeUser)
  // WHY only the one recorded corpus (manager, steering q78: "the last hardening round"): four
  // review rounds each found another input shape a pattern-based pass lets through (a private
  // project outside Development/, a hyphenated or placeholder-shaped foreign home, …). This mode
  // exists to REPRODUCE the committed file, not to redact arbitrary corpora, so it accepts exactly
  // the pre-redaction fixture it was audited against: `15e43abe^`, git blob d2653405. Its output was
  // audited key by key. A new corpus comes from the live extraction (main), and needs its own audit.
  const digest = createHash('sha256').update(text).digest('hex')
  if (digest !== RECORDED_CORPUS_SHA256) {
    throw new Error('--redact-from only accepts the recorded pre-redaction corpus (15e43abe^); refusing any other source')
  }
  const fixture = JSON.parse(text) as Record<string, unknown>
  fixture.provenance = RUNTIME_STATES_PROVENANCE
  const redacted = `${JSON.stringify(createAgentActivityRedactor(homeUser)(fixture), null, 2)}\n`
  assertNoForeignHome(redacted, homeUser)
  await writeFile(OUT, redacted, 'utf8')
  console.log(`re-redacted ${source} into ${OUT}`)
}

const argv = process.argv.slice(2)
if (argv.includes('--redact-from')) {
  // WHY the operand is checked here (review of #1353, round 3 a): a bare `--redact-from` used to
  // leave the source undefined and fall through to the LIVE extraction, which reads this machine's
  // bundles and overwrites the tracked fixture. Every part of the invocation is validated before
  // anything is read or written.
  const redactSource = argv[argv.indexOf('--redact-from') + 1]
  if (redactSource === undefined || redactSource.startsWith('--')) {
    console.error('--redact-from needs a source file; refusing to fall back to a live extraction')
    process.exit(2)
  }
  // Validated before anything is read or written (steering q74); see requireHomeUser.
  let homeUser: string
  try {
    homeUser = requireHomeUser(argv)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(2)
  }
  try {
    await redactFrom(redactSource, homeUser)
  } catch (error) {
    // Only the curated message: every refusal above names counts, never a path or user.
    console.error((error as Error).message)
    process.exit(2)
  }
} else if (argv.length > 0) {
  // A live extraction takes no arguments (steering q80): `--out`, or anything else, is refused
  // rather than guessed at.
  console.error(`a live extraction takes no arguments (got ${argv.length}); it stages into a fresh temp directory`)
  process.exit(2)
} else {
  try {
    await main()
  } catch (error) {
    console.error((error as Error).message)
    process.exit(2)
  }
}
