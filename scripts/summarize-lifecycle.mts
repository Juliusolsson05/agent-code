#!/usr/bin/env npx tsx --tsconfig tsconfig.node.json
// Session-lifecycle ladder summarizer.
//
// Turns a run's `events.jsonl` into one readable phase ladder per session, and
// flags the ladders that ended somewhere they should not have.
//
// WHY this script exists at all: the lifecycle stream is only worth recording
// if a human can read it without a JSONL viewer and a lot of patience. Stage 3
// of docs/decomposition/agent-boot-readiness.md is "use the app normally for a
// week and collect real boots" — that is only tolerable if reading the result
// is one command.
//
//   npm run lifecycle:summarize                 # newest run
//   npm run lifecycle:summarize -- --run <id>   # a specific run id
//   npm run lifecycle:summarize -- --all        # every retained run
//   npm run lifecycle:summarize -- --stalled    # only sessions that look wrong
//   npm run lifecycle:summarize -- --dir <path> # read runs from elsewhere
//
// `--dir` exists so a journal copied off another machine (or out of a debug
// bundle) can be read without moving files into ~/.config, and so this script
// is verifiable against a fixture without touching real user data.
//
// It reads only; it never writes, prunes, or blesses anything.

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// Duplicated rather than imported from @main/storage/paths.js on purpose: that
// module pulls in Electron-adjacent imports, and a read-only forensics script
// must run from a plain `tsx` with no app context. The constant is a stable
// user-visible location, not an internal detail likely to drift.
const DEFAULT_RUNS_DIR = join(homedir(), '.config', 'agent-code', 'incidents', 'runs')
const LIFECYCLE_AREA = 'session.lifecycle'

type JournalEvent = {
  seq: number
  ts: number
  tsIso: string
  area: string
  name: string
  severity: string
  ids?: { sessionId?: string }
  data?: Record<string, unknown>
}

/**
 * Names that legitimately terminate a recovery ladder.
 *
 * A `recover.claim` with none of these following it is a STRANDED CLAIM: main
 * took ownership of a local session id and never resolved it. That state
 * presents to the user as "the agent never started", with nothing anywhere
 * explaining why — the exact failure this whole subsystem was built to make
 * visible.
 */
const RECOVERY_TERMINALS = new Set([
  'recover.adopted',
  'recover.spawned',
  'recover.conflict',
  'recover.cancelled',
  'recover.failed',
])

function parseArgs(argv: string[]): {
  run: string | null
  all: boolean
  stalledOnly: boolean
  dir: string
} {
  const runIndex = argv.indexOf('--run')
  const dirIndex = argv.indexOf('--dir')
  return {
    run: runIndex >= 0 ? (argv[runIndex + 1] ?? null) : null,
    all: argv.includes('--all'),
    stalledOnly: argv.includes('--stalled'),
    dir: dirIndex >= 0 ? (argv[dirIndex + 1] ?? DEFAULT_RUNS_DIR) : DEFAULT_RUNS_DIR,
  }
}

async function listRuns(runsDir: string): Promise<string[]> {
  const entries = await readdir(runsDir).catch(() => [] as string[])
  const withTimes = await Promise.all(
    entries.map(async name => {
      const info = await stat(join(runsDir, name)).catch(() => null)
      return info?.isDirectory() ? { name, mtime: info.mtimeMs } : null
    }),
  )
  return withTimes
    .filter((entry): entry is { name: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map(entry => entry.name)
}

async function readLifecycleEvents(runsDir: string, runId: string): Promise<JournalEvent[]> {
  const raw = await readFile(join(runsDir, runId, 'events.jsonl'), 'utf8').catch(() => '')
  const events: JournalEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as JournalEvent
      // A truncated final line is normal for an append-only file being read
      // while the app is still running; skip it rather than fail the report.
      if (parsed.area === LIFECYCLE_AREA) events.push(parsed)
    } catch {
      continue
    }
  }
  return events.sort((a, b) => a.seq - b.seq)
}

function describe(event: JournalEvent): string {
  const data = event.data ?? {}
  const parts: string[] = []
  // `unresolvedSessionIds` is here because a restore that never completes is
  // the failure this summarizer exists to make readable, and the count alone
  // ('3 of 4') does not tell you which pane to go look at.
  for (const key of ['caller', 'kind', 'gate', 'reason', 'code', 'disposition', 'status', 'cause', 'unresolvedSessionIds']) {
    const value = data[key]
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${String(value)}`)
  }
  if (typeof data.ready === 'boolean') parts.push(`ready=${data.ready}`)
  if (typeof data.ok === 'boolean') parts.push(`ok=${data.ok}`)
  if (typeof data.durationMs === 'number') parts.push(`${Math.round(data.durationMs)}ms`)
  if (typeof data.elapsedMs === 'number' && data.elapsedMs > 0) {
    parts.push(`stalled ${Math.round(data.elapsedMs / 1000)}s`)
  }
  return parts.join(' ')
}

/**
 * The diagnoses this report can make without a human reading every rung.
 *
 * Each corresponds to a shape named in the decomposition. They are deliberately
 * conservative: a flag here should mean "look at this", never "this is the bug".
 */
function diagnose(events: JournalEvent[]): string[] {
  const names = events.map(e => e.name)
  const findings: string[] = []

  const claims = names.filter(n => n === 'recover.claim').length
  const terminals = names.filter(n => RECOVERY_TERMINALS.has(n)).length
  if (claims > terminals) {
    findings.push('STRANDED CLAIM — recovery began and never resolved')
  }

  const loadStarts = names.filter(n => n === 'history.load.start').length
  const loadEnds = names.filter(n => n === 'history.load.end').length
  if (loadStarts > loadEnds) {
    findings.push('TRANSCRIPT LOAD NEVER ENDED — the #283 stuck-at-loading shape')
  }
  for (const event of events) {
    if (event.name !== 'history.load.end') continue
    const status = String(event.data?.status ?? '')
    if (status.startsWith('dropped') || status === 'no-terminal-write') {
      findings.push(`TRANSCRIPT TERMINAL WRITE LOST (${status})`)
    }
  }

  // A ladder whose ONLY readiness fact is the seeded 'starting' is the
  // fingerprint of "the agent takes minutes to start": publishPromptGate is
  // edge-triggered, so a provider that never reaches its composer boundary
  // emits nothing further and the renderer waits forever.
  const readiness = events.filter(e => e.name === 'readiness.publish')
  if (readiness.length > 0 && !readiness.some(e => e.data?.ready === true)) {
    findings.push('NEVER BECAME READY — no readiness.publish ever reported ready=true')
  }

  const longestStall = events
    .filter(e => e.name === 'gate.eval')
    .map(e => Number(e.data?.elapsedMs ?? 0))
    .reduce((max, value) => Math.max(max, value), 0)
  if (longestStall >= 30_000) {
    const gate = events.filter(e => e.name === 'gate.eval').at(-1)?.data
    findings.push(
      `LONG GATE STALL — ${Math.round(longestStall / 1000)}s at ` +
      `${String(gate?.gate ?? '?')}/${String(gate?.reason ?? '?')}`,
    )
  }

  for (const event of events) {
    if (event.name !== 'delivery.reject') continue
    findings.push(`DELIVERY REJECTED — ${String(event.data?.reason ?? event.data?.code ?? '?')}`)
  }
  if (names.includes('submit.unwound')) {
    findings.push('SUBMIT UNWOUND — a prompt failed with nothing written (pre-fix this wedged the pane)')
  }

  // Many wakes collapsing onto few recoveries is the #596 remount-storm shape.
  const wakes = names.filter(n => n === 'wake.request').length
  if (wakes >= 5 && wakes > claims * 3) {
    findings.push(`WAKE STORM — ${wakes} wake requests for ${claims} recoveries`)
  }

  return findings
}

function report(runId: string, events: JournalEvent[], stalledOnly: boolean): void {
  const bySession = new Map<string, JournalEvent[]>()
  const global: JournalEvent[] = []
  for (const event of events) {
    const sessionId = event.ids?.sessionId
    if (sessionId === undefined) {
      global.push(event)
      continue
    }
    const list = bySession.get(sessionId) ?? []
    list.push(event)
    bySession.set(sessionId, list)
  }

  console.log(`\n═══ run ${runId} — ${events.length} lifecycle events, ${bySession.size} sessions`)
  for (const event of global) {
    console.log(`  · ${event.name} ${describe(event)}`.trimEnd())
  }

  let flagged = 0
  for (const [sessionId, sessionEvents] of bySession) {
    const findings = diagnose(sessionEvents)
    if (stalledOnly && findings.length === 0) continue
    if (findings.length > 0) flagged += 1

    const first = sessionEvents[0]
    console.log(`\n  ── ${sessionId}  (${first.tsIso})`)
    for (const event of sessionEvents) {
      // Offset from the session's first event: absolute timestamps are noise
      // when the question is always "how long after the previous rung".
      const offset = ((event.ts - first.ts) / 1000).toFixed(1).padStart(7)
      const detail = describe(event)
      console.log(`   ${offset}s  ${event.name}${detail ? `  ${detail}` : ''}`)
    }
    for (const finding of findings) console.log(`      ⚠ ${finding}`)
  }

  if (stalledOnly && flagged === 0) {
    console.log('  (no session in this run tripped a diagnosis)')
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runs = await listRuns(args.dir)
  if (runs.length === 0) {
    console.log(`No runs under ${args.dir}. Launch Agent Code once and retry.`)
    return
  }

  const selected = args.run !== null
    ? runs.filter(id => id === args.run)
    : args.all
      ? runs
      : runs.slice(0, 1)

  if (selected.length === 0) {
    console.log(`Run ${args.run} not found. Available: ${runs.slice(0, 10).join(', ')}`)
    process.exitCode = 1
    return
  }

  for (const runId of selected) {
    const events = await readLifecycleEvents(args.dir, runId)
    if (events.length === 0 && args.all) continue
    report(runId, events, args.stalledOnly)
  }
  console.log('')
}

await main()
