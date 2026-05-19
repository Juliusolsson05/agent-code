import { mkdir, readFile, readdir, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  AUTOSAVE_DEBUG_BUNDLE_DIR,
  DEBUG_BUNDLE_DIR,
  FEED_DEBUG_DIR,
  MANUAL_DEBUG_BUNDLE_DIR,
  PERFORMANCE_RUNS_DIR,
  PROXY_EVENTS_DIR,
  STATE_DIR,
} from '@main/storage/paths.js'
import { ghostLogDir } from '@main/ghostJournal.js'
import {
  DEBUG_BUNDLE_LOG_FILE,
  isAutosaveDebugBundleReason,
  type DebugBundleLogEntry,
} from '@main/storage/debugBundleLog.js'

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
  | 'ghost-logs'

type Artifact = {
  path: string
  bytes: number
  mtimeMs: number
  kind: 'file' | 'dir'
  bucket: DebugStorageBucket
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

export function scheduleDebugStoragePrune(reason: string): void {
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
      }
      return result
    })
    .catch(err => {
      console.warn('[debug-retention] prune failed (non-fatal):', err)
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
  const cutoff = Date.now() - ttl * 60 * 60 * 1000
  const activeCutoff = Date.now() - ACTIVE_GRACE_MS
  const caps = bucketCaps(budget)
  let artifacts = await collectArtifacts()
  let removed = 0
  let bytesFreed = 0

  for (const artifact of artifacts) {
    // Ghost logs are recovery state. Age alone is not enough evidence that a
    // log is disposable: a user can resume an older crashed session and still
    // need those provisional rows during bootstrap. Keep ghost cleanup on the
    // budget/cap passes below, where pressure is explicit and active recent
    // files still get the ACTIVE_GRACE_MS guard.
    if (isProtectedFromDebugPrune(artifact)) continue
    if (artifact.mtimeMs >= cutoff) continue
    const freed = await removeArtifact(artifact)
    if (freed === 0) continue
    removed += 1
    bytesFreed += freed
  }

  artifacts = await collectArtifacts()
  for (const bucket of Object.keys(caps) as DebugStorageBucket[]) {
    if (bucket === 'debug-bundles-manual') continue
    const bucketArtifacts = artifacts
      .filter(artifact => artifact.bucket === bucket)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    let bucketBytes = sumBytes(bucketArtifacts)
    for (const artifact of bucketArtifacts) {
      if (bucketBytes <= caps[bucket]) break
      if (artifact.mtimeMs > activeCutoff) continue
      const freed = await removeArtifact(artifact)
      if (freed === 0) continue
      removed += 1
      bytesFreed += freed
      bucketBytes -= freed
    }
  }

  artifacts = await collectArtifacts()
  let totalBytes = sumBytes(artifacts)
  for (const artifact of [...artifacts].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= budget) break
    if (isProtectedFromDebugPrune(artifact)) continue
    if (artifact.mtimeMs > activeCutoff) continue
    const freed = await removeArtifact(artifact)
    if (freed === 0) continue
    removed += 1
    bytesFreed += freed
    totalBytes -= freed
  }

  return {
    reason,
    budgetBytes: budget,
    ttlHours: ttl,
    removed,
    bytesFreed,
    scannedBytes: totalBytes,
  }
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
    // Ghost logs are recovery state, not user data. They deserve enough
    // budget to survive a recent crash/reload, but not a hidden unlimited
    // directory outside the normal debug-retention accounting. Compaction
    // keeps live logs small; this cap handles abandoned session files.
    'ghost-logs': Math.floor(totalBudget * 0.08),
  }
}

async function collectArtifacts(): Promise<Artifact[]> {
  const manualLegacyBundlePaths = await loadManualLegacyBundlePaths()
  const [feed, manualBundles, autosaveBundles, legacyBundles, proxy, performance, ghostLogs] = await Promise.all([
    collectFiles(FEED_DEBUG_DIR, 'feed-debug', name => name.endsWith('.jsonl')),
    collectImmediateDirs(MANUAL_DEBUG_BUNDLE_DIR, 'debug-bundles-manual'),
    collectImmediateDirs(AUTOSAVE_DEBUG_BUNDLE_DIR, 'debug-bundles-autosave'),
    collectLegacyDebugBundleDirs(DEBUG_BUNDLE_DIR, manualLegacyBundlePaths),
    collectProxyRunDirs(PROXY_EVENTS_DIR),
    collectImmediateDirs(PERFORMANCE_RUNS_DIR, 'performance'),
    collectFiles(ghostLogDir(), 'ghost-logs', name => name.endsWith('.ghost.jsonl')),
  ])
  return [
    ...feed,
    ...manualBundles,
    ...autosaveBundles,
    ...legacyBundles,
    ...proxy,
    ...performance,
    ...ghostLogs,
  ]
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

async function collectLegacyDebugBundleDirs(
  dir: string,
  manualLegacyBundlePaths: Set<string>,
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
  manualLegacyBundlePaths: Set<string>,
): DebugStorageBucket {
  return manualLegacyBundlePaths.has(resolve(bundlePath))
    ? 'debug-bundles-manual'
    : 'debug-bundles-legacy'
}

function isProtectedFromDebugPrune(artifact: Artifact): boolean {
  return artifact.bucket === 'ghost-logs' || artifact.bucket === 'debug-bundles-manual'
}

async function loadManualLegacyBundlePaths(): Promise<Set<string>> {
  const manual = new Set<string>()
  let raw: string
  try {
    raw = await readFile(DEBUG_BUNDLE_LOG_FILE, 'utf8')
  } catch {
    return manual
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: DebugBundleLogEntry
    try {
      entry = JSON.parse(trimmed) as DebugBundleLogEntry
    } catch {
      continue
    }
    if (entry.event !== 'saved') continue
    if (isAutosaveDebugBundleReason(entry.reason)) continue
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

async function collectProxyRunDirs(root: string): Promise<Artifact[]> {
  const out: Artifact[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isFile() && entry.name === 'proxy-events.jsonl')) {
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
  let current = dirname(path)
  while (current.startsWith(PROXY_EVENTS_DIR) && current !== PROXY_EVENTS_DIR) {
    try {
      const entries = await readdir(current)
      if (entries.length > 0) return
      await rm(current, { recursive: false, force: true })
      current = dirname(current)
    } catch {
      return
    }
  }
}

function sumBytes(artifacts: Artifact[]): number {
  return artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
}
