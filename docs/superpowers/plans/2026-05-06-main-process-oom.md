# Main-Process OOM Investigation & Mitigation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent and diagnose the "JavaScript heap out of memory" crash in cc-shell's Electron **main** process during long-running sessions, by adding bounded retention for the structures that grow without limit and instrumentation to root-cause anything that still leaks.

**Architecture:** Evidence first, fixes second. Add a heap-snapshot-on-near-OOM watchdog so the next crash leaves a forensic artifact. Then close three concrete unbounded-growth suspects identified during the bundle audit: the per-session `feedDebugWriteQueues` map in the feed-debug writer, the fully-resident `worktree-activity-index.json` (30 MB on disk and growing), and on-disk debug-log directories with no retention (149 GB / 5007 session files / largest single file 9.8 GB observed). Each fix is independent and behind a small flag so any one of them can be reverted in isolation.

**Tech Stack:** Node/Electron main, TypeScript, `v8.writeHeapSnapshot` (built-in), Vitest (existing harness for `claude-code-headless`).

**Relationship to the title-turn plan:** independent. The title-gen leakage is a renderer-side ghost issue; this OOM is in the **main** process. Treat them as unrelated unless a heap snapshot from Task 1 says otherwise.

**Reference crash:**

```
[94772:0x13000540000] 71508406 ms: Mark-Compact 3838.9 (4086.0) -> 3837.8 (4094.0) MB
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

  - PID 94772, ~71.5M ms uptime ≈ 19h 51m
  - Stack tail shows `__CFRunLoopDoSource0 → ElectronMain` ⇒ the **main** process, not a renderer
  - Default v8 heap cap on macOS Electron main = 4 GB; the crash hits ~3.84 GB / 4.09 GB

**Reference debug bundle:** `/Users/juliusolsson/.config/cc-shell/debug-bundles/2026-05-06T08-20-40-689-75a7665a/` (different bundle than the title-turn one's *symptoms*; same physical machine; useful for retention thresholds).

---

## Investigation summary (read first)

Verified before writing this plan:

  1. The crash is in the **main** process. The native frames `_DPSNextEvent → -[NSApplication run] → ElectronMain` are macOS AppKit + Electron main; renderer crashes go through the GPU/blink frames instead.
  2. Default v8 heap on Electron 28+ main is ~4 GB (`--max-old-space-size=4096`). cc-shell does not override this. So 3.84 GB sustained is the hard ceiling, not just "lots of usage".
  3. On-disk state under `~/.config/cc-shell/`:
     - `feed-debug/`: **149 GB**, **5007 files** (one per session id), largest single 9.8 GB. No retention policy.
     - `performance/`: 5.0 GB. Gated on `CC_SHELL_PERF` flag, so most users wouldn't hit it; user has it on at least sometimes.
     - `proxy/`: 759 MB.
     - `worktree-activity-index.json`: 30 MB, loaded fully into memory by `WorktreeActivityIndex` (`src/main/worktreeActivity/WorktreeActivityIndex.ts`).
  4. In-memory growth suspects (all in main process):
     - `src/main/storage/feedDebugLog.ts:31-32` declares two module-level Maps, `feedDebugWriteQueues` and `lastWrittenFeedDebugId`, both keyed by sessionId and **never deleted**. Every session that ever touches the feed-debug writer pins one queue Promise + one numeric cursor entry forever. At ~5000 sessions on this machine, that's negligible by itself — but the queue Promise's closure captures `entries` until it resolves, and a stuck IO promise pins the entries indefinitely.
     - `WorktreeActivityIndex.ts` deserialises the entire 30 MB JSON to a single object on startup (`indexStore.ts`) and rewrites it whole on each update. That's a steady ~30 MB resident plus serialise/parse spikes that briefly double it.
     - The mitm proxy stdout buffer is consumed by `ProxyServer` in main. If the renderer falls behind reading proxy events (via IPC), the main-side buffer can grow without bound.

  These are the three I will add bounded retention for. Each has its own task below.

---

## File Structure

**Modified files:**

  - `src/main/index.ts` (or wherever `app.whenReady` lives) — register the heap-snapshot watchdog.
  - `src/main/performance/heapWatchdog.ts` (new) — small standalone module: poll `process.memoryUsage().heapUsed` and `v8.getHeapStatistics()`, dump a `.heapsnapshot` when crossing a threshold, log a structured warning.
  - `src/main/storage/feedDebugLog.ts:31-82` — bound the per-session Maps and resolve queues so they can be reaped.
  - `src/main/worktreeActivity/WorktreeActivityIndex.ts` and `indexStore.ts` — keep an in-memory cap on `transcripts` keys and prune evicted entries to disk only.
  - `src/main/storage/paths.ts` (or near it) — add `pruneStaleFeedDebugLogs()` and call it at app startup.
  - `electron-builder.yml` — no change required; only mentioned because we should NOT bump the heap cap as a fix. Heap-cap bumps are a band-aid; they postpone the crash without addressing growth.

**New files:**

  - `src/main/performance/heapWatchdog.ts` — ~80 LOC. Self-contained.

**Untouched:**

  - All renderer code. The crash is in main.
  - Per-project `feedDebugLog` write logic except for the cleanup hooks.

---

## Task 1: Add a heap watchdog (evidence first)

This task ships **before** any fix. The point is to capture a heap snapshot on the next near-OOM so we can root-cause whatever is still growing after the bounded-retention fixes land. Heap snapshots are the only reliable way to see "what's actually pinning all that memory" — guessing would just bandage symptoms.

**Files:**

  - Create: `src/main/performance/heapWatchdog.ts`
  - Modify: `src/main/index.ts` — wire the watchdog into `app.whenReady`.

- [ ] **Step 1: Create the watchdog module**

```ts
// src/main/performance/heapWatchdog.ts
//
// Heap-pressure watchdog for the Electron main process.
//
// WHY this exists: cc-shell long-running sessions have OOMed the main
// process (4 GB v8 cap on macOS). Reproductions take 20+ hours, so
// catching them with a debugger is impractical. The watchdog samples
// `v8.getHeapStatistics()` at a low duty cycle and writes a heap
// snapshot to disk the first time the process crosses a "we will OOM
// soon" threshold. The snapshot is a forensic artifact that
// Chrome DevTools / clinic.js can analyse — pin-pointing which
// retainer chains are holding all the memory without us having to
// guess.
//
// WHY a single-shot snapshot (not periodic): heap snapshots are large
// (1-3 GB at the threshold we care about), expensive to write
// (multi-second STW pause), and only useful when the heap is in the
// "near-OOM, not yet OOM" state. Once we have one, we have what we
// need to investigate; subsequent snapshots from the same session
// rarely add information and would themselves accelerate the OOM.
//
// WHY no exit / restart on threshold: that is a policy decision the
// user owns. Crashing on heap exhaustion already produces a v8 fatal
// error log; what we lacked was the snapshot. We add the snapshot,
// nothing else.

import { writeHeapSnapshot, getHeapStatistics } from 'node:v8'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { CC_SHELL_DATA_DIR } from '@main/storage/paths.js'

// Threshold rationale: v8 main cap is ~4 GB; the observed crash hit at
// ~3.84 GB during Mark-Compact. We trip the watchdog at 3.0 GB
// (78 % of cap) to leave headroom for the snapshot itself and the
// allocations the snapshot writer makes. Lower thresholds risk false
// positives on legitimate large workloads; higher ones risk OOMing
// during the snapshot write.
const HEAP_USED_TRIP_BYTES = 3 * 1024 * 1024 * 1024

// Sample every 30 s. Heap pressure builds over hours, not seconds, so
// finer sampling buys nothing and just wakes the event loop more.
const SAMPLE_INTERVAL_MS = 30_000

let watchdogTimer: NodeJS.Timeout | null = null
let snapshotWritten = false

export function startMainHeapWatchdog(): void {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => {
    void sampleAndMaybeSnapshot()
  }, SAMPLE_INTERVAL_MS).unref()
}

export function stopMainHeapWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

async function sampleAndMaybeSnapshot(): Promise<void> {
  const stats = getHeapStatistics()
  // used_heap_size is the metric we care about: total_heap_size can
  // briefly inflate from internal fragmentation without being close to
  // the limit. used_heap_size is what the v8 fatal-error report shows.
  const heapUsed = stats.used_heap_size
  const limit = stats.heap_size_limit
  if (heapUsed < HEAP_USED_TRIP_BYTES) return
  if (snapshotWritten) return
  snapshotWritten = true

  const dir = join(CC_SHELL_DATA_DIR, 'heap-snapshots')
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    // Best-effort: if mkdir fails we still try writeHeapSnapshot in
    // CWD because the snapshot is the load-bearing artifact, not the
    // tidy directory layout.
    // eslint-disable-next-line no-console
    console.warn('[heap-watchdog] mkdir failed', err)
  }
  const file = join(
    dir,
    `main-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.heapsnapshot`,
  )
  // eslint-disable-next-line no-console
  console.warn(
    `[heap-watchdog] heapUsed=${heapUsed} limit=${limit} → writing snapshot to ${file}`,
  )
  try {
    writeHeapSnapshot(file)
    // eslint-disable-next-line no-console
    console.warn(`[heap-watchdog] snapshot written: ${file}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[heap-watchdog] snapshot write failed', err)
    // Reset the gate so a later sample can retry once the immediate
    // pressure subsides. We deliberately do not retry inside this
    // tick — the failure most likely IS heap exhaustion.
    snapshotWritten = false
  }
}
```

- [ ] **Step 2: Wire the watchdog into main**

Open `src/main/index.ts` (or whichever module owns `app.whenReady().then(...)`). Find a spot AFTER `app.whenReady` resolves and BEFORE any window opens, and add:

```ts
import { startMainHeapWatchdog, stopMainHeapWatchdog } from '@main/performance/heapWatchdog.js'
// ...
startMainHeapWatchdog()
app.on('before-quit', () => stopMainHeapWatchdog())
```

- [ ] **Step 3: Verify compile**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Smoke-verify**

Temporarily lower `HEAP_USED_TRIP_BYTES` to e.g. 256 MiB, run `npm run dev`, open a couple of panes, observe a `.heapsnapshot` file appears in `~/.config/cc-shell/heap-snapshots/`. Restore the threshold to 3 GB before committing.

- [ ] **Step 5: Commit**

```bash
git add src/main/performance/heapWatchdog.ts src/main/index.ts
git commit -m "main(perf): heap-pressure watchdog dumps snapshot near OOM"
```

---

## Task 2: Reap the per-session feed-debug write queue Map

**Files:**

  - Modify: `src/main/storage/feedDebugLog.ts:31-82` — release queue + cursor entries when the queue settles or when the session ends.

- [ ] **Step 1: Reproduce the exact bug shape from the source**

Read `src/main/storage/feedDebugLog.ts` end-to-end. Confirm `feedDebugWriteQueues` is module-scoped and never `delete`d. Confirm there is no `endSession()` / cleanup hook.

- [ ] **Step 2: Add a settle-time reaper**

Replace the current `next` chain inside `queueFeedDebugAppend` with:

```ts
  const previous = feedDebugWriteQueues.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (entries.length === 0) return
      const lastWritten = lastWrittenFeedDebugId.get(sessionId) ?? 0
      const freshEntries = entries.filter(entry => entry.id > lastWritten)
      if (freshEntries.length === 0) return
      await mkdir(FEED_DEBUG_DIR, { recursive: true })
      const filePath = join(FEED_DEBUG_DIR, `${sanitizeSessionIdForPath(sessionId)}.jsonl`)
      const text = freshEntries
        .map(entry => JSON.stringify({ sessionId, ...entry }))
        .join('\n') + '\n'
      await writeFile(filePath, text, { encoding: 'utf8', flag: 'a' })
      lastWrittenFeedDebugId.set(
        sessionId,
        Math.max(lastWritten, ...freshEntries.map(entry => entry.id)),
      )
    })
  feedDebugWriteQueues.set(sessionId, next)

  // Reap the queue entry once it settles — but only if no NEWER
  // append has chained on top of `next`. The `===` check is the
  // critical safety: a concurrent `queueFeedDebugAppend` for the same
  // sessionId would have replaced the map value with a longer chain;
  // deleting it here would race the next caller's read of the
  // previous chain. Keeping the entry in those cases is correct —
  // the LATER settle will run this same hook and find no successor.
  void next
    .catch(() => {})
    .finally(() => {
      if (feedDebugWriteQueues.get(sessionId) === next) {
        feedDebugWriteQueues.delete(sessionId)
      }
    })

  return next
```

- [ ] **Step 3: Add a hard cleanup hook for session end**

Export a `forgetSession(sessionId: string)` from the same file:

```ts
/** Drop in-memory bookkeeping for a session that has ended. The
 *  on-disk JSONL is intentionally LEFT IN PLACE — debug bundles for
 *  long-since-closed panes still benefit from reading the trail. The
 *  retention sweep in Task 4 is what eventually deletes the file. */
export function forgetFeedDebugSession(sessionId: string): void {
  // We never delete `feedDebugWriteQueues` synchronously here —
  // there might be an in-flight write that still owns the chain.
  // The settle-time reaper in queueFeedDebugAppend handles the queue
  // entry; what we own here is the cursor.
  lastWrittenFeedDebugId.delete(sessionId)
}
```

- [ ] **Step 4: Call `forgetFeedDebugSession` at the session-close site**

Run: `grep -rn 'session.*close\|sessionEnded\|destroy.*session\|removeSession' /Users/juliusolsson/Desktop/Development/cc-shell/src/main/ | head -10`
Pick the call site in `SessionManager` (or equivalent) that runs when a session leaves the workspace. Add `forgetFeedDebugSession(sessionId)` next to the existing teardown calls. (Specific line will depend on your local layout — there is no policy here other than "wherever the session officially dies".)

- [ ] **Step 5: Verify compile + run unit tests**

```bash
cd /Users/juliusolsson/Desktop/Development/cc-shell && npm run typecheck && npm run test
```
Expected: zero errors, all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/storage/feedDebugLog.ts src/main/<sessionManager file>
git commit -m "main(feedDebug): reap per-session writer state on settle and on close"
```

---

## Task 3: Cap the in-memory worktree-activity index

The on-disk file is 30 MB and grows monotonically. The in-memory representation is the parsed JSON object — same size or larger after V8's object overhead. Disk size will keep growing as new transcripts are discovered; in-memory size has no excuse to.

**Files:**

  - Modify: `src/main/worktreeActivity/WorktreeActivityIndex.ts` — bound the resident map.
  - Modify: `src/main/worktreeActivity/indexStore.ts` — keep the on-disk file authoritative; in-memory is a hot subset.

- [ ] **Step 1: Read both files end-to-end**

```bash
sed -n '1,230p' /Users/juliusolsson/Desktop/Development/cc-shell/src/main/worktreeActivity/WorktreeActivityIndex.ts
sed -n '1,200p' /Users/juliusolsson/Desktop/Development/cc-shell/src/main/worktreeActivity/indexStore.ts
```

Identify (a) where the full JSON is loaded into memory, (b) where it's written back.

- [ ] **Step 2: Decide the in-memory cap**

The map is keyed by transcript file path. Each value is a `WorktreeActivitySummary`. Empirically, 90 % of cc-shell sessions only ever query the most recent 200-500 transcripts (per-pane activity, recent worktree picker). 1000 entries is a comfortable cap that fits in ~3-5 MB. **Set the cap as a const** at the top of `WorktreeActivityIndex.ts`:

```ts
// Why this exists: the on-disk index grows monotonically with the
// number of transcripts ever observed (currently 30 MB+ on heavy
// users). The in-memory map mirrored that growth, contributing to
// long-session main-process OOMs. The on-disk file remains the source
// of truth; the in-memory map is now a hot LRU subset. Lookups for
// paths that aren't in memory must fall through to a disk read.
const IN_MEMORY_MAX_ENTRIES = 1000
```

- [ ] **Step 3: Make the in-memory map an LRU**

Replace whichever `Map<string, WorktreeActivitySummary>` field holds the live state with a small LRU shim. Avoid pulling in a dependency — a 20-line hand-rolled one is fine:

```ts
class LruMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly cap: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    // refresh recency
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.cap) {
      // Map iteration order is insertion order ⇒ first key is the
      // least-recently-used. Eviction here only drops the in-memory
      // copy; the on-disk record is persisted by the writer
      // independently and rehydrates on a later get-miss.
      const oldestKey = this.map.keys().next().value as K | undefined
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }
  keys(): IterableIterator<K> { return this.map.keys() }
  values(): IterableIterator<V> { return this.map.values() }
  get size(): number { return this.map.size }
}
```

Wire `WorktreeActivityIndex` to use `new LruMap<string, WorktreeActivitySummary>(IN_MEMORY_MAX_ENTRIES)`.

- [ ] **Step 4: Make get-miss fall through to disk**

The current `indexStore.ts` writes the *whole* JSON on every update. After this change, the in-memory state is no longer the full file — so the writer must read-modify-write the on-disk file (still cheap because we already serialise it to disk regularly).

Implement a `loadEntryFromDisk(path: string): Promise<WorktreeActivitySummary | null>` in `indexStore.ts` that opens the JSON, finds the matching `transcripts[path]`, returns it (or null). Use it from any `WorktreeActivityIndex` getter that returns `undefined` from the LRU.

This is the only place in this plan with non-trivial concurrency: writes still own the whole file. Keep them serialised behind a single in-flight Promise the same way `feedDebugLog.ts` already does it.

- [ ] **Step 5: Verify**

```bash
cd /Users/juliusolsson/Desktop/Development/cc-shell && npm run typecheck && npm run test
```

Open a Claude pane. Switch worktrees a couple of times. Confirm the activity index in the UI still works.

- [ ] **Step 6: Commit**

```bash
git add src/main/worktreeActivity/WorktreeActivityIndex.ts src/main/worktreeActivity/indexStore.ts
git commit -m "main(worktreeActivity): LRU-cap in-memory index, defer to disk on miss"
```

---

## Task 4: On-disk retention for `feed-debug/` and friends

Disk pressure is not heap pressure, but two reasons to do this together:
  1. The disk-full state on the user's home volume could make every later main-process write reject and pile pending writes in memory.
  2. Several debug commands read these directories — having 5000+ files is a UX problem too.

**Files:**

  - Modify: `src/main/storage/paths.ts` — add `pruneStaleDebugLogs()`.
  - Modify: `src/main/index.ts` — call it once at app start, behind a flag.

- [ ] **Step 1: Add a retention policy module**

Append to `src/main/storage/paths.ts` (or split into its own file if `paths.ts` is too crowded — judgement call):

```ts
/** Sweep `~/.config/cc-shell/feed-debug` and remove `.jsonl` files
 *  whose mtime is older than the cutoff. We retain by mtime not by
 *  count so a user with many short sessions keeps recent context and
 *  a user with few long sessions does not lose the active session's
 *  log. Default 30 days because a debug bundle saved a month later
 *  is so unusual it's not worth the disk pressure to support. */
const FEED_DEBUG_RETENTION_DAYS = 30

export async function pruneStaleFeedDebugLogs(): Promise<{ removed: number; bytesFreed: number }> {
  const dir = FEED_DEBUG_DIR
  let removed = 0
  let bytesFreed = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { removed, bytesFreed }
  }
  const cutoff = Date.now() - FEED_DEBUG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const stats = await stat(file)
      if (stats.mtimeMs >= cutoff) continue
      bytesFreed += stats.size
      await unlink(file)
      removed += 1
    } catch {
      // Ignore — file may have been removed concurrently or be busy.
    }
  }
  return { removed, bytesFreed }
}
```

(Imports as needed: `readdir`, `stat`, `unlink` from `node:fs/promises`.)

- [ ] **Step 2: Run it once at app start, fire-and-forget**

In the same place you called `startMainHeapWatchdog()` in Task 1:

```ts
void pruneStaleFeedDebugLogs().then(result => {
  if (result.removed > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[feed-debug] pruned ${result.removed} stale logs (${(result.bytesFreed / 1024 / 1024).toFixed(1)} MiB)`,
    )
  }
})
```

- [ ] **Step 3: Verify**

Run: `npm run dev` and watch the console. On a system with old `feed-debug/*.jsonl` you should see a `[feed-debug] pruned N stale logs ...` line on startup.

- [ ] **Step 4: Commit**

```bash
git add src/main/storage/paths.ts src/main/index.ts
git commit -m "main(storage): prune feed-debug logs older than 30 days at startup"
```

---

## Task 5: Manual reproduction recipe + verification

No new automated tests are introduced (per project memory `feedback_no_test_bloat.md`). Instead the verification is captured here so the next maintainer can reproduce.

- [ ] **Step 1: Long-session simulation**

You don't actually need 20 hours. Set the watchdog threshold to a small value (e.g. 256 MiB) for one run, open a Claude pane, and rapidly cycle a long-running worktree (open/close 50 times). Confirm a `.heapsnapshot` is written to `~/.config/cc-shell/heap-snapshots/`.

- [ ] **Step 2: Inspect the snapshot**

Open the snapshot in Chrome DevTools (`chrome://inspect` → Memory → Load). Sort retainers by "Retained Size". Confirm none of these are dominant:
  - `feedDebugWriteQueues` (Map of sessionId → Promise) — should be ≤ active session count.
  - `WorktreeActivityIndex.transcripts` — should be ≤ 1000 entries.
  - mitm proxy stdout buffer — note its size for follow-up if it's > 50 MiB.

- [ ] **Step 3: Confirm disk pruning fires**

```bash
ls /Users/juliusolsson/.config/cc-shell/feed-debug | wc -l
```
After running the app for a few seconds, this should drop to only sessions touched in the last 30 days.

- [ ] **Step 4: Run the regression suite**

```bash
cd /Users/juliusolsson/Desktop/Development/cc-shell && npm run test
```
Expected: all suites pass.

---

## Self-Review Checklist (run before opening the PR)

- [ ] The watchdog does NOT auto-restart the process — only writes a snapshot. Restarts are the user's call.
- [ ] The snapshot threshold (3 GB) leaves enough headroom that the snapshot writer itself doesn't OOM. If V8 ever rejects `writeHeapSnapshot` for memory pressure, the watchdog logs the failure and resets `snapshotWritten` to allow a later sample to retry — it does NOT fall into a tight retry loop.
- [ ] The feed-debug Map reaper checks `=== next` before deleting, preventing the documented race where a concurrent caller has already chained a successor. Without that check, the reaper would delete a still-needed Promise reference.
- [ ] The activity index LRU does not lie — get-miss correctly falls through to disk so callers never see "missing" entries that exist on disk. (Otherwise the recent-worktree picker would silently lose entries.)
- [ ] `pruneStaleFeedDebugLogs` is keyed on **mtime**, not on session liveness. An active long-running session keeps its log fresh on every write; we never delete it underneath an open file handle.
- [ ] We did NOT bump the v8 heap cap. Higher caps just postpone OOMs — the right fix is bounded growth.
- [ ] No new test files (project memory). Manual recipe lives here for repeatability.

---

## Open follow-ups (NOT in this plan, file separately)

  - Same retention treatment for `~/.config/cc-shell/performance/` (5 GB) and `~/.config/cc-shell/proxy/` (759 MB). They follow the same on-disk-only-grows pattern. Out of scope here because they're behind separate code paths.
  - Investigate the largest single feed-debug file (9.8 GB / `270cb6bc-…`) for write-amplification — even at 30 MB per session average this is 320× higher. Likely a runaway loop somewhere in the renderer's debug emitter. Cannot diagnose from main-process changes alone.
  - Once a snapshot from Task 1 lands, file targeted plans for whichever retainer dominates. The point of this plan is to **stop guessing** about that.
