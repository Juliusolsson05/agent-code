import { mkdir, readFile, readdir, rm, rmdir, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import {
  AUTOSAVE_DEBUG_BUNDLE_DIR,
  DEBUG_BUNDLE_DIR,
  FEED_DEBUG_DIR,
  HEAP_SNAPSHOT_DIR,
  INCIDENT_RUNS_DIR,
  MANUAL_DEBUG_BUNDLE_DIR,
  PERFORMANCE_RUNS_DIR,
  PROXY_EVENTS_DIR,
  SESSION_RECORDING_DIR,
  STATE_DIR,
} from '@main/storage/paths.js'
import { DEBUG_BUNDLE_LOG_FILE, isAutosaveDebugBundleReason } from '@main/storage/debugBundleLog.js'
import type { DebugBundleLogEntry } from '@main/storage/debugBundleLog.js'

const GIB = 1024 * 1024 * 1024
const DEFAULT_TTL_HOURS = 48
const MIN_BUDGET_BYTES = 10 * GIB
const MAX_BUDGET_BYTES = 15 * GIB
const ACTIVE_GRACE_MS = 10 * 60 * 1000
const PRUNE_COOLDOWN_MS = 5 * 60 * 1000
const LEGACY_DEBUG_BUNDLE_DIR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-.+$/

export type DebugStorageBucket =
  | 'feed-debug'
  | 'debug-bundles-manual'
  | 'debug-bundles-autosave'
  | 'debug-bundles-legacy'
  | 'proxy'
  | 'performance'
  | 'incidents'
  | 'heap-snapshots'
  | 'session-recordings'

/** Exported so the pass logic can be unit-tested with in-memory artifacts. */
export type DebugStorageArtifact = {
  path: string
  bytes: number
  mtimeMs: number
  kind: 'file' | 'dir'
  bucket: DebugStorageBucket
  protected?: boolean
}
type Artifact = DebugStorageArtifact

export type DebugStoragePrunePolicy = {
  now: number
  ttlMs: number
  activeGraceMs: number
  budgetBytes: number
  caps: Record<DebugStorageBucket, number>
}

export type DebugStoragePrunePassesResult = {
  removed: number
  bytesFreed: number
  /** Bytes still accounted after all passes — what the old code reported as
   *  `scannedBytes` from its third re-scan. */
  remainingBytes: number
}

export type DebugStoragePruneResult = {
  reason: string
  budgetBytes: number
  ttlHours: number
  removed: number
  bytesFreed: number
  scannedBytes: number
}

let pruneInFlight: Promise<DebugStoragePruneResult> | null = null
let lastPruneStartedAt = 0

// Journal handle for debug-retention actions.
//
// WHY a module-level singleton, not a per-call parameter: scheduleDebugStoragePrune
// is called from many places (feed-debug appends, incident starts, boot, workspace
// autosaves). Threading a journal reference through every caller would touch a
// dozen files for a signal that is genuinely a global side-effect. Retention
// itself is a singleton scheduler already (see pruneInFlight above), so pinning
// the sink at that same level is consistent.
//
// WHY at all: before this hook the ONLY trace of a prune was a `console.info` or
// `console.warn` line. Those lines were the July 2026 crash forensics' single
// surviving hint that retention had done work (see issue #388) — but they never
// reached events.jsonl, so a forensic reader following the always-on incident
// spine could not see when retention had freed bytes or what buckets were pruned.
// The journal turns that opaque background sweep into a first-class breadcrumb.
type RetentionJournalSink = {
  record(input: {
    area: string
    name: string
    severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    data?: Record<string, unknown>
  }): void
}
let retentionJournal: RetentionJournalSink | null = null

export function setDebugRetentionJournal(journal: RetentionJournalSink | null): void {
  retentionJournal = journal
}

// Provider for the set of on-disk dirs of session recordings that are STILL
// live (recorder open in memory). Mirrors the retentionJournal singleton
// pattern above: retention runs from many hot paths, so threading the recorder
// manager through every caller would be noise for a genuinely global signal.
//
// WHY this exists (see isProtectedFromDebugPrune): a session-recording folder
// is aged by its mtime, but a quiet-but-live recording stops bumping mtime, so
// the ACTIVE_GRACE_MS guard can lapse and the cap/budget passes would rm -rf a
// folder the recorder is still appending to on the next event. mtime is the
// wrong liveness oracle for a recording that has merely gone idle; the
// authoritative signal is "the recorder is still in the manager's map". The
// provider is called at prune time (not cached) so it always reflects the
// current live set even across a long-running prune.
let liveRecordingDirsProvider: (() => Set<string>) | null = null

export function setLiveRecordingDirsProvider(fn: (() => Set<string>) | null): void {
  liveRecordingDirsProvider = fn
}


function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function defaultBudgetBytes(): Promise<number> {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    const fs = await statfs(STATE_DIR)
    const total = Number(fs.blocks) * Number(fs.bsize)
    if (Number.isFinite(total) && total > 0) {
      // Debug storage should scale with the host, but only inside a narrow
      // lane. Three percent gives a 460 GiB laptop about 13.8 GiB, while the
      // clamp stops small disks from losing all forensic context and large
      // disks from quietly growing a 100+ GiB cache again.
      return Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, Math.floor(total * 0.03)))
    }
  } catch {
    // Fall through to the conservative floor.
  }
  return MIN_BUDGET_BYTES
}

async function budgetBytes(): Promise<number> {
  return Math.floor(envNumber('AGENT_CODE_DEBUG_MAX_GB', (await defaultBudgetBytes()) / GIB) * GIB)
}

function ttlHours(): number {
  return envNumber('AGENT_CODE_DEBUG_TTL_HOURS', DEFAULT_TTL_HOURS)
}

// ── The boot gate (#775) ───────────────────────────────────────────────
//
// WHY: the first prune of every run used to start about 1 s after launch
// (AppRunJournal.start), while the first window's workspace was still
// rehydrating, so its statfs, directory walk and rm -rf competed with the
// session herd coming back. In the owner's 50 journaled runs, 27 of the 30
// run-start prunes landed before that run's first `rehydrate.complete`
// (reported 2.2-70.5 s after start, excluding one run that slept mid-boot)
// and one landed 1.8 s after it, still inside the burst; the largest
// journaled one freed 1.98 GiB at 25.4 s. Nothing about retention is urgent at boot: the budget
// is 3% of the disk and the TTL is days, so waiting past recovery costs
// nothing.
//
// Closed only by holdDebugStoragePruneUntilRecovered() (the run's boot, once
// per process), so every other caller and test keeps the old behavior.
// While closed, requests coalesce into ONE pending prune, keeping the first
// reason. It opens a while after the first window reports
// `rehydrate.complete`, or after a fallback, so a run with no window (5 of
// the 50 journaled runs never reported one) still prunes.
//
// WHY 120 s after recovery (#1351 review c): session wakes continue past
// 60 s after `rehydrate.complete` in 19 of 45 journaled runs (the densest
// burst is inside 60 s; the tail runs to ~280 s and may be user-initiated).
// 120 s covers most of it; the 5-minute fallback bounds the whole wait.
export const DEBUG_PRUNE_AFTER_RECOVERY_MS = 120_000
export const DEBUG_PRUNE_BOOT_FALLBACK_MS = 5 * 60_000

type BootGate = {
  pendingReason: string | null
  fallback: ReturnType<typeof setTimeout>
  opening: ReturnType<typeof setTimeout> | null
}
let bootGate: BootGate | null = null
let bootGateUsed = false

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  // A pending prune must never keep a quitting process alive.
  (timer as { unref?: () => void }).unref?.()
}

/** Called once, at the start of a run, before its first prune request. */
export function holdDebugStoragePruneUntilRecovered(): void {
  if (bootGateUsed) return
  bootGateUsed = true
  const fallback = setTimeout(openDebugStoragePruneGate, DEBUG_PRUNE_BOOT_FALLBACK_MS)
  unrefTimer(fallback)
  bootGate = { pendingReason: null, fallback, opening: null }
}

/** The first window finished rehydrating its workspace; open the gate after
 *  the session-wake burst that follows. Later reports change nothing. */
export function noteWorkspaceRecovered(): void {
  if (!bootGate || bootGate.opening) return
  bootGate.opening = setTimeout(openDebugStoragePruneGate, DEBUG_PRUNE_AFTER_RECOVERY_MS)
  unrefTimer(bootGate.opening)
}

function openDebugStoragePruneGate(): void {
  const gate = bootGate
  if (!gate) return
  bootGate = null
  clearTimeout(gate.fallback)
  if (gate.opening) clearTimeout(gate.opening)
  if (gate.pendingReason) scheduleDebugStoragePrune(gate.pendingReason)
}

export function scheduleDebugStoragePrune(reason: string): void {
  if (bootGate) {
    bootGate.pendingReason ??= reason
    return
  }
  const now = Date.now()
  if (pruneInFlight || now - lastPruneStartedAt < PRUNE_COOLDOWN_MS) return
  lastPruneStartedAt = now
  pruneInFlight = pruneDebugStorage(reason)
    .then(result => {
      if (result.removed > 0) {
        // eslint-disable-next-line no-console
        console.info(
          `[debug-retention] pruned ${result.removed} artifacts ` +
          `(${(result.bytesFreed / 1024 / 1024).toFixed(1)} MiB) ` +
          `reason=${result.reason} budget=${(result.budgetBytes / GIB).toFixed(1)}GiB`,
        )
        // Mirror the successful prune into the always-on journal so an offline
        // reader following events.jsonl can see when retention freed bytes and
        // why (reason= is the origin trigger, e.g. "feed-debug-append",
        // "incident-run-start", "startup"). Zero-removed prunes are intentionally
        // NOT journaled — retention runs on a 5-minute cooldown from many hot
        // paths, and a no-op event per trigger would drown the journal.
        try {
          retentionJournal?.record({
            area: 'storage.retention',
            name: 'debug_retention.prune',
            severity: 'info',
            data: {
              reason: result.reason,
              removed: result.removed,
              bytesFreed: result.bytesFreed,
              budgetBytes: result.budgetBytes,
              scannedBytes: result.scannedBytes,
              ttlHours: result.ttlHours,
            },
          })
        } catch {
          // Journal failures must never destabilize retention — the journal is
          // forensics, not product state, and the prune already ran.
        }
      }
      return result
    })
    .catch(err => {
      console.warn('[debug-retention] prune failed (non-fatal):', err)
      try {
        // Also mirror failed prunes: a broken sweep is exactly the case where the
        // console.warn easily gets lost in a busy log, and a forensic reader
        // needs a first-class breadcrumb explaining why disk usage crept up.
        retentionJournal?.record({
          area: 'storage.retention',
          name: 'debug_retention.prune_failed',
          severity: 'warn',
          data: {
            reason,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      } catch {
        // See above — never destabilize the retention scheduler.
      }
      return {
        reason,
        budgetBytes: 0,
        ttlHours: ttlHours(),
        removed: 0,
        bytesFreed: 0,
        scannedBytes: 0,
      }
    })
    .finally(() => {
      pruneInFlight = null
    })
}

export async function pruneDebugStorage(reason: string): Promise<DebugStoragePruneResult> {
  const budget = await budgetBytes()
  const ttl = ttlHours()
  // WHY exactly one scan per prune (#728): this runs every five minutes for
  // the life of the process, and collectArtifacts() re-reads the multi-MB
  // debug-bundle ledger and stats every tracked file. The passes used to
  // re-collect between themselves — three ledger parses and three walks per
  // prune, on the main thread.
  //
  // What that trades away: the re-scans also refreshed each artifact's bytes
  // and mtime and noticed files created or removed by someone else mid-prune.
  // For the seconds one prune takes that staleness is acceptable — the
  // active-grace window is ten minutes, an under-counted live run just makes
  // a pass stop early, and the next prune five minutes later corrects any of
  // it. `now` is taken after the scan so the grace is measured against the
  // mtimes actually collected.
  const artifacts = await collectArtifacts()
  const outcome = await runPrunePasses(
    artifacts,
    {
      now: Date.now(),
      ttlMs: ttl * 60 * 60 * 1000,
      activeGraceMs: ACTIVE_GRACE_MS,
      budgetBytes: budget,
      caps: bucketCaps(budget),
    },
    async artifact => (await removeArtifact(artifact)) > 0,
  )

  return {
    reason,
    budgetBytes: budget,
    ttlHours: ttl,
    removed: outcome.removed,
    bytesFreed: outcome.bytesFreed,
    scannedBytes: outcome.remainingBytes,
  }
}

/**
 * The three prune passes over ONE collected artifact list.
 *
 * Pass order and per-pass rules are unchanged from the re-scanning version:
 *   1. TTL — anything unprotected older than the TTL goes, regardless of
 *      size or bucket.
 *   2. Per-bucket cap — oldest first until the bucket fits, skipping the
 *      manual bundle bucket, protected artifacts and anything written within
 *      the active grace (a live session's run must not vanish under it).
 *   3. Global budget — oldest first across buckets until the total fits,
 *      with the same protected/active exemptions.
 *
 * `remove` answers whether the artifact is gone. A successful removal frees
 * the artifact's collected byte count — the same number the old code
 * subtracted between re-scans — and drops it from the working set. A failed
 * removal neither counts nor drops it: it stays for the next pass, as a
 * re-scan would have found it. (A boolean rather than a byte count keeps
 * the accounting consistent by construction; a partial `rm -rf` leaves the
 * artifact's full snapshot weight in place until the next prune.)
 *
 * Exported with the remover injected so the pass semantics can be tested
 * against in-memory artifacts; production wraps `removeArtifact`.
 */
export async function runPrunePasses(
  artifacts: readonly Artifact[],
  policy: DebugStoragePrunePolicy,
  remove: (artifact: Artifact) => Promise<boolean>,
): Promise<DebugStoragePrunePassesResult> {
  const cutoff = policy.now - policy.ttlMs
  const activeCutoff = policy.now - policy.activeGraceMs
  const live = new Set(artifacts)
  let removed = 0
  let bytesFreed = 0
  const drop = async (artifact: Artifact): Promise<number> => {
    if (!(await remove(artifact))) return 0
    live.delete(artifact)
    removed += 1
    bytesFreed += artifact.bytes
    return artifact.bytes
  }

  for (const artifact of artifacts) {
    if (isProtectedFromDebugPrune(artifact)) continue
    if (artifact.mtimeMs >= cutoff) continue
    await drop(artifact)
  }

  for (const bucket of Object.keys(policy.caps) as DebugStorageBucket[]) {
    if (bucket === 'debug-bundles-manual') continue
    const bucketArtifacts = [...live]
      .filter(artifact => artifact.bucket === bucket)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    let bucketBytes = sumBytes(bucketArtifacts)
    for (const artifact of bucketArtifacts) {
      if (bucketBytes <= policy.caps[bucket]) break
      // Honor protection in the per-bucket cap pass too. The TTL pass and the
      // global-budget pass both skip protected artifacts; without this line the
      // 4% incidents cap could still evict a "protected" recent incident run,
      // silently breaking the "keep the 50 newest runs regardless" guarantee
      // that collectIncidentRunDirs() establishes. (Manual debug bundles get
      // the same protection via the `continue` at the top of this loop.)
      if (isProtectedFromDebugPrune(artifact)) continue
      if (artifact.mtimeMs > activeCutoff) continue
      bucketBytes -= await drop(artifact)
    }
  }

  let totalBytes = sumBytes([...live])
  for (const artifact of [...live].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= policy.budgetBytes) break
    if (isProtectedFromDebugPrune(artifact)) continue
    if (artifact.mtimeMs > activeCutoff) continue
    totalBytes -= await drop(artifact)
  }

  return { removed, bytesFreed, remainingBytes: totalBytes }
}

function bucketCaps(totalBudget: number): Record<DebugStorageBucket, number> {
  return {
    'feed-debug': Math.floor(totalBudget * 0.22),
    // Manual debug bundles are user-intentional captures, often with notes
    // added seconds later. They are deliberately absent from TTL, per-bucket,
    // and global-budget deletion passes: if disk pressure is severe, pruning
    // should consume cache-like debug data before it erases the exact incident
    // captures the user asked to preserve. The cap value stays in the map only
    // to keep bucket accounting explicit and future UI budget displays honest.
    'debug-bundles-manual': Math.floor(totalBudget * 0.08),
    'debug-bundles-autosave': Math.floor(totalBudget * 0.20),
    'debug-bundles-legacy': Math.floor(totalBudget * 0.04),
    proxy: Math.floor(totalBudget * 0.28),
    performance: Math.floor(totalBudget * 0.10),
    // Incident runs are intentionally small: manifests, heartbeat, compact
    // lifecycle JSONL, and pointers to heavy artifacts. They still need an
    // explicit budget lane so the new always-on journal cannot become another
    // "small files forever" directory after months of development restarts.
    incidents: Math.floor(totalBudget * 0.04),
    // Heap snapshots are intentionally rare, but each one can be gigabytes.
    // They are not protected like manual bundles because the user-visible
    // action is "capture a diagnostic", not "archive an incident forever".
    // The active-grace check in the prune passes is the safety rail that keeps
    // a just-written snapshot around long enough to reveal/copy it.
    'heap-snapshots': Math.floor(totalBudget * 0.10),
    // Session recordings are the biggest continuous producer of the bunch: a
    // continuous per-session input-stream capture, up to 128 MiB PER
    // recording, one recording per session per app run. Left uncapped this is
    // exactly the "small files forever" / uncapped-growth directory that OOM'd
    // the app on 2026-07-04 (#388) and that #467 flagged as a must-fix before
    // the recorder sees heavy use. 12% gives room for a soak's worth of
    // recordings while the global budget + active-grace guards keep a live
    // recording safe. Not protected like manual bundles: a recording is a
    // diagnostic you replay locally, not a user-authored artifact to preserve
    // forever — once it ages out under pressure, dropping it whole is correct.
    'session-recordings': Math.floor(totalBudget * 0.12),
  }
}

/**
 * Which legacy root-level bundles were saved by hand, or 'unknown' when the
 * ledger cannot be read OR is absent (steering q109; review of #1417 round 2).
 *
 * WHY 'unknown' instead of an empty set: the manual/legacy split is what keeps
 * a hand-saved bundle out of the deletable `debug-bundles-legacy` bucket. An
 * empty set on a transient read failure (EACCES, EMFILE) classified every
 * manual bundle as deletable for that prune; with the cache below it would
 * have stayed that way until the file changed. 'unknown' makes every legacy
 * bundle protected for that prune instead.
 *
 * WHY an ABSENT ledger is 'unknown' too (review of #1417, round 2, a): a
 * ledger moved aside before a prune and back after it is indistinguishable,
 * from inside the prune, from one that never existed, and treating absence as
 * "no manual bundles" made every hand-saved legacy bundle deletable for that
 * prune. The ledger is the only record of which root-level bundles were
 * manual, so without it none can be proven disposable. Stated cost: with no
 * ledger at all, pre-split legacy bundles are never aged out; that is the
 * owner's "do not delete stuff often" applied to evidence we cannot classify.
 */
export type ManualLegacyBundlePaths = Set<string> | 'unknown'

// WHY the legacy ledger parse is cached by file identity (#1278): nothing has
// appended to the pre-split mixed ledger since manual and autosave bundles got
// their own folders (debugBundleLog.ts), yet it was re-read and re-parsed on
// every prune, every five minutes for the life of the process (18.4 MB on the
// author's machine).
//
// The identity is inode + ctime + mtime + size, not mtime + size alone
// (steering q109): a replacement by rename gets a new inode, and ctime moves on
// ANY content or metadata change and, unlike mtime, cannot be set back with
// utimes, so a same-size edit that restores the old mtime still re-parses.
// A failed stat or read ('unknown') is never cached: the next prune retries,
// exactly as it did before the cache existed.
let legacyLedgerCache: { key: string; paths: Set<string> } | null = null

export async function cachedManualLegacyBundlePaths(
  file: string = DEBUG_BUNDLE_LOG_FILE,
  load: (file: string) => Promise<ManualLegacyBundlePaths> = loadManualLegacyBundlePaths,
): Promise<ManualLegacyBundlePaths> {
  const identity = await ledgerIdentity(file)
  if (identity === 'unknown') return 'unknown'
  const key = `${file}\0${identity}`
  if (legacyLedgerCache?.key === key) return legacyLedgerCache.paths
  const paths = await load(file)
  // WHY a second stat (review of #1417, a): the load is a separate operation.
  // A ledger renamed away between the stat and the read made readFile hit
  // ENOENT, which the loader rightly calls "no ledger", and that empty set was
  // then cached under the identity of the file that WAS there, so a manual
  // bundle became deletable. The parse is trusted only if the file it read is
  // the file the stat saw, before and after; any change (gone, replaced,
  // edited mid-read) is 'unknown': protective for this prune, never cached.
  if (paths === 'unknown' || (await ledgerIdentity(file)) !== identity) {
    legacyLedgerCache = null
    return 'unknown'
  }
  legacyLedgerCache = { key, paths }
  return paths
}

async function ledgerIdentity(file: string): Promise<string> {
  try {
    const info = await stat(file)
    return `${info.ino}:${info.ctimeMs}:${info.mtimeMs}:${info.size}`
  } catch {
    // ENOENT included: an absent ledger classifies nothing (see
    // ManualLegacyBundlePaths), so it is never cached as an answer.
    return 'unknown'
  }
}

async function collectArtifacts(): Promise<Artifact[]> {
  const manualLegacyBundlePaths = await cachedManualLegacyBundlePaths()
  const [feed, manualBundles, autosaveBundles, legacyBundles, proxy, performance, incidents, heapSnapshots, sessionRecordings] = await Promise.all([
    collectFiles(FEED_DEBUG_DIR, 'feed-debug', name => name.endsWith('.jsonl')),
    collectImmediateDirs(MANUAL_DEBUG_BUNDLE_DIR, 'debug-bundles-manual'),
    collectImmediateDirs(AUTOSAVE_DEBUG_BUNDLE_DIR, 'debug-bundles-autosave'),
    collectLegacyDebugBundleDirs(DEBUG_BUNDLE_DIR, manualLegacyBundlePaths),
    collectProxyRunDirs(PROXY_EVENTS_DIR),
    collectImmediateDirs(PERFORMANCE_RUNS_DIR, 'performance'),
    collectIncidentRunDirs(),
    collectFiles(HEAP_SNAPSHOT_DIR, 'heap-snapshots', name => name.endsWith('.heapsnapshot')),
    collectSessionRecordingDirs(),
  ])
  return [
    ...feed,
    ...manualBundles,
    ...autosaveBundles,
    ...legacyBundles,
    ...proxy,
    ...performance,
    ...incidents,
    ...heapSnapshots,
    ...sessionRecordings,
  ]
}

// Collect each session-recording FOLDER as one dir-kind artifact.
//
// WHY a whole-folder dir artifact and NOT per-file (collectFiles):
// a recording is `session-recordings/<recordingId>/` = { meta.json,
// events.jsonl }. It MUST be evicted atomically — deleting events.jsonl while
// keeping meta.json (or vice-versa) leaves a half-recording the replay harness
// can't load and that no longer counts toward any bucket. Because we emit ONE
// `kind:'dir'` Artifact per folder, removeArtifact() takes the `rm -rf` branch
// and the whole folder is the unit of deletion by construction. Using
// collectFiles here would be the bug this shape exists to prevent — it would
// let a prune pass shed events.jsonl and orphan meta.json.
//
// WHY order by folder mtime (inherited from dirStats via collectImmediateDirs)
// and NOT meta.json.startedAtWall: a CONTINUOUS recorder appends for the whole
// life of a session, so a live recording's folder mtime is "just now" — which
// is exactly what we want, because the active-grace guard in the prune passes
// keys on mtimeMs and must protect a recording that is still being written.
// Ordering by startedAtWall would make a long-lived active recording look
// "old" and expose it to cap/budget eviction mid-write. Folder mtime ages
// closed recordings correctly (their last write == when they ended) while
// keeping live ones safe — the plan explicitly permits "the folder's mtime".
//
// `root` is a parameter (defaulting to the real dir) purely so the colocated
// test can point this at a temp dir without mocking the paths module — the
// prune framework's fs calls are otherwise hard-wired to STATE_DIR.
//
// Retention closes the #388/#467 disk-panic vector: a continuous stream
// re-opens the exact uncapped-growth wound that OOM'd the app on 2026-07-04.
// The per-recording 128 MiB cap bounds one file; this bucket bounds the whole
// directory so recordings can't accrete forever across app runs.
export function collectSessionRecordingDirs(
  root: string = SESSION_RECORDING_DIR,
): Promise<Artifact[]> {
  return collectImmediateDirs(root, 'session-recordings')
}

async function collectFiles(
  dir: string,
  bucket: DebugStorageBucket,
  include: (name: string) => boolean,
): Promise<Artifact[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const out: Artifact[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !include(entry.name)) continue
      const path = join(dir, entry.name)
      try {
        const stats = await stat(path)
        out.push({ path, bytes: stats.size, mtimeMs: stats.mtimeMs, kind: 'file', bucket })
      } catch {
        // File was removed between readdir and stat.
      }
    }
    return out
  } catch {
    return []
  }
}

async function collectImmediateDirs(
  dir: string,
  bucket: DebugStorageBucket,
): Promise<Artifact[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const dirs = entries.filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
    return Promise.all(dirs.map(path => collectDirArtifact(path, bucket)))
      .then(items => items.filter((item): item is Artifact => item !== null))
  } catch {
    return []
  }
}

async function collectIncidentRunDirs(): Promise<Artifact[]> {
  const runs = await collectImmediateDirs(INCIDENT_RUNS_DIR, 'incidents')
  const sorted = [...runs].sort((a, b) => b.mtimeMs - a.mtimeMs)
  // WHY protect a count instead of making incident runs immortal:
  //
  // A tiny clean-run journal is useful after restart, but dev machines can
  // launch the app hundreds of times. Keeping the most recent runs preserves
  // the crash window people actually investigate while still letting the
  // global disk budget clear out stale journals once they age out of the
  // recent set. Heavy artifacts remain in their existing capped buckets.
  return sorted.map((artifact, index) => ({
    ...artifact,
    protected: index < 50,
  }))
}

async function collectLegacyDebugBundleDirs(
  dir: string,
  manualLegacyBundlePaths: ManualLegacyBundlePaths,
): Promise<Artifact[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    // WHY legacy root folders are still collected: old versions wrote both
    // manual and autosave bundles directly under debug-bundles/. The mixed
    // JSONL ledger is the only durable source that knows which root-level
    // timestamp folders were user-triggered, so retention rehydrates that
    // distinction here. We also require the old timestamp folder shape instead
    // of treating every unknown sibling as disposable cache; otherwise a future
    // debug-bundles/<feature>/ directory could be silently pruned as "legacy."
    const dirs = entries
      .filter(entry =>
        entry.isDirectory() &&
        entry.name !== 'manual' &&
        entry.name !== 'autosave' &&
        LEGACY_DEBUG_BUNDLE_DIR_RE.test(entry.name),
      )
      .map(entry => join(dir, entry.name))
    return Promise.all(dirs.map(path => {
      const bucket = legacyDebugBundleBucketForPath(path, manualLegacyBundlePaths)
      return collectDirArtifact(path, bucket)
    }))
      .then(items => items.filter((item): item is Artifact => item !== null))
  } catch {
    return []
  }
}

export function legacyDebugBundleBucketForPath(
  bundlePath: string,
  manualLegacyBundlePaths: ManualLegacyBundlePaths,
): DebugStorageBucket {
  // An unreadable ledger protects every legacy bundle; see ManualLegacyBundlePaths.
  if (manualLegacyBundlePaths === 'unknown') return 'debug-bundles-manual'
  return manualLegacyBundlePaths.has(resolve(bundlePath))
    ? 'debug-bundles-manual'
    : 'debug-bundles-legacy'
}

function isProtectedFromDebugPrune(artifact: Artifact): boolean {
  // A live session recording is protected regardless of its folder mtime — see
  // setLiveRecordingDirsProvider for WHY mtime is the wrong liveness oracle
  // here (an idle-but-open recording ages past ACTIVE_GRACE_MS while still being
  // written). resolve() both sides so a relative-vs-absolute mismatch can't
  // defeat the comparison; retention keys everything else off resolve(path) too
  // and liveRecordingDirs() already resolve()s its entries.
  if (artifact.bucket === 'session-recordings' && liveRecordingDirsProvider) {
    if (liveRecordingDirsProvider().has(resolve(artifact.path))) return true
  }
  return artifact.protected === true ||
    artifact.bucket === 'debug-bundles-manual'
}

async function loadManualLegacyBundlePaths(file: string = DEBUG_BUNDLE_LOG_FILE): Promise<ManualLegacyBundlePaths> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    // Every failure, including ENOENT, is unknown and fails closed (steering
    // q109, review of #1417 round 2); see ManualLegacyBundlePaths.
    return 'unknown'
  }
  return parseManualLegacyBundlePaths(raw)
}

export function parseManualLegacyBundlePaths(raw: string): Set<string> {
  const manual = new Set<string>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    // WHY a shape check and not only the JSON.parse guard (#1251 row 13): a
    // line can be valid JSON and still not an entry (`null`, a number, a row
    // from a build that wrote bundlePath differently). Such a row threw here,
    // which rejected collectArtifacts and stopped every prune pass for every
    // bucket. Skipping it can only fail to protect a bundle the row does not
    // name, so it never exposes a manual bundle to deletion.
    if (typeof parsed !== 'object' || parsed === null) continue
    const entry = parsed as Partial<DebugBundleLogEntry> & { bundlePath?: unknown; reason?: unknown }
    if (entry.event !== 'saved' || typeof entry.bundlePath !== 'string') continue
    if (isAutosaveDebugBundleReason(typeof entry.reason === 'string' ? entry.reason : null)) continue
    // WHY manual legacy classification comes from the old mixed ledger instead
    // of folder contents: every bundle contains a manifest, but reading
    // thousands of manifests during retention would turn a cheap directory
    // sweep into a burst of random I/O. The append-only ledger was designed as
    // the operator index for "what did I save and why?", so it is the right
    // source for separating pre-split manual incidents from autosave cache.
    manual.add(resolve(entry.bundlePath))
  }
  return manual
}

/**
 * A proxy run is a directory holding the live events file OR only its rotated generation.
 *
 * WHY `.1` too (review of #1376, a): claude-code-headless#64 renames the live file to
 * `proxy-events.1.jsonl` before creating the next one. If that creation fails, or the addon dies in
 * between, the run holds only `.1`; matching the live name alone made such a run invisible to
 * TTL, cap and budget alike, so stranded runs could accumulate. The bundle reader already treats
 * `.1` as a run (proxyEventsReader.ts).
 */
const PROXY_RUN_MARKERS = new Set(['proxy-events.jsonl', 'proxy-events.1.jsonl'])

export async function collectProxyRunDirs(root: string): Promise<Artifact[]> {
  const out: Artifact[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isFile() && PROXY_RUN_MARKERS.has(entry.name))) {
      const artifact = await collectDirArtifact(dir, 'proxy')
      if (artifact) out.push(artifact)
      return
    }
    if (depth >= 4) return
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '_shared-conf') continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

async function collectDirArtifact(
  path: string,
  bucket: DebugStorageBucket,
): Promise<Artifact | null> {
  try {
    const { bytes, mtimeMs } = await dirStats(path)
    return { path, bytes, mtimeMs, kind: 'dir', bucket }
  } catch {
    return null
  }
}

async function dirStats(path: string): Promise<{ bytes: number; mtimeMs: number }> {
  const stats = await stat(path)
  if (!stats.isDirectory()) return { bytes: stats.size, mtimeMs: stats.mtimeMs }
  let bytes = 0
  let mtimeMs = stats.mtimeMs
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const child = join(path, entry.name)
    try {
      if (entry.isDirectory()) {
        const nested = await dirStats(child)
        bytes += nested.bytes
        mtimeMs = Math.max(mtimeMs, nested.mtimeMs)
      } else if (entry.isFile()) {
        const childStats = await stat(child)
        bytes += childStats.size
        mtimeMs = Math.max(mtimeMs, childStats.mtimeMs)
      }
    } catch {
      // Best-effort accounting; a concurrent writer/remover can race us.
    }
  }
  return { bytes, mtimeMs }
}

async function removeArtifact(artifact: Artifact): Promise<number> {
  try {
    if (artifact.kind === 'dir') {
      await rm(artifact.path, { recursive: true, force: true })
      await removeEmptyParents(artifact.path, artifact.bucket)
    } else {
      await rm(artifact.path, { force: true })
    }
    return artifact.bytes
  } catch {
    return 0
  }
}

async function removeEmptyParents(path: string, bucket: DebugStorageBucket): Promise<void> {
  if (bucket !== 'proxy') return
  await removeEmptyProxyParents(path, PROXY_EVENTS_DIR)
}

// WHY rmdir and not rm (#1278): this used to readdir() and then call
// rm(dir, { recursive: false }), which ALWAYS throws EISDIR on a directory, so
// the catch returned on the first parent and no emptied session or project
// dir was ever removed (2,978 of them on the author's machine, each walked by
// collectProxyRunDirs on every prune). rmdir removes a directory only while it
// is empty, and it does so atomically: a session that creates a new run dir
// between our check and the removal makes rmdir fail with ENOTEMPTY instead of
// deleting its fresh run, which the old readdir-then-remove shape could not
// promise. `root + sep` keeps a sibling like `proxy-old/` out of scope.
export async function removeEmptyProxyParents(path: string, root: string): Promise<void> {
  let current = dirname(path)
  while (current.startsWith(root + sep)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

function sumBytes(artifacts: Artifact[]): number {
  return artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
}
