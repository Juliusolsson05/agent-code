import type { WorktreeIdentity } from '@shared/types/git.js'
import type {
  IndexedTranscript,
  WorktreeActivityIndexFile,
  WorktreeActivityIndexStatus,
  WorktreeActivitySummary,
} from '@main/worktreeActivity/types.js'
import {
  discoverTranscriptCandidates,
} from '@main/worktreeActivity/transcriptDiscovery.js'
import {
  loadAllTranscriptsFromDisk,
  loadEntryFromDisk,
  loadWorktreeActivityIndex,
  saveWorktreeActivityIndex,
} from '@main/worktreeActivity/indexStore.js'
import { parseTranscriptForActivity } from '@main/worktreeActivity/transcriptParser.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { matchWorktree } from '@shared/work-context/matching.js'
import {
  emptyCounts,
  incrementCounts,
} from '@main/worktreeActivity/types.js'

// Polling UI surfaces call getSummary repeatedly. Even with mtime/size
// cache hits, discovery still readdir/stat-walks the provider session
// trees, so background refreshes need their own freshness gate. Manual
// refresh bypasses this through `force` because the user explicitly
// asked to pay the cost for newer data.
const BACKGROUND_REFRESH_MIN_INTERVAL_MS = 60_000

// Why this exists: the on-disk index grows monotonically with the
// number of transcripts ever observed (currently 30 MB+ on heavy
// users). The in-memory map mirrored that growth, contributing to
// long-session main-process OOMs. The on-disk file remains the source
// of truth; the in-memory map is now a hot LRU subset. Lookups for
// paths that aren't in memory must fall through to a disk read.
const IN_MEMORY_MAX_ENTRIES = 1000

// Minimal LRU. We intentionally don't pull a dependency for this —
// Map already preserves insertion order, so re-inserting on access
// gives us LRU semantics in ~20 lines. The cap is a soft maximum;
// we evict the oldest after each set() until size <= cap, so
// transient overshoots during a refresh are fine.
class LruMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly cap: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.cap) {
      const oldestKey = this.map.keys().next().value as K | undefined
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }
  keys(): IterableIterator<K> { return this.map.keys() }
  values(): IterableIterator<V> { return this.map.values() }
  get size(): number { return this.map.size }
}

export class WorktreeActivityIndex {
  // WorktreeActivityIndex is deliberately a main-process service, not a
  // renderer helper. The expensive operation here is not `git worktree
  // list`; it is walking Claude/Codex transcripts to answer "which
  // agent last touched this checkout?" If every UI surface did that
  // walk independently, opening a panel, running search, and later
  // adding cleanup automation would each rediscover and reparse the
  // same files. This class is the boundary: future features should ask
  // for summaries from here and never scan transcript directories
  // directly.
  //
  // Memory shape (post-OOM-mitigation): the in-memory `transcripts`
  // map is an LRU bounded to IN_MEMORY_MAX_ENTRIES. The on-disk JSON
  // is the source of truth — point lookups that miss the LRU fall
  // through to disk via loadEntryFromDisk; full iterations (e.g.
  // collectSummaries) load all transcripts transiently from disk and
  // let them go out of scope after the call. We track `totalOnDisk`
  // so we can short-circuit the disk iteration when the entire set
  // already lives in the LRU (light users get the original behavior;
  // heavy users get the bound).
  private loaded: Promise<void> | null = null
  private refreshing: Promise<void> | null = null
  private updatedAt = 0
  private readonly transcripts = new LruMap<string, IndexedTranscript>(
    IN_MEMORY_MAX_ENTRIES,
  )
  private totalOnDisk = 0
  private status: WorktreeActivityIndexStatus = {
    lastIndexedAt: null,
    refreshing: false,
    stale: true,
    cacheHits: 0,
    parsedFiles: 0,
    skippedFiles: 0,
  }

  async getSummary(params: {
    worktrees: WorktreeIdentity[]
    refresh?: boolean
  }): Promise<{
    summaries: WorktreeActivitySummary[]
    status: WorktreeActivityIndexStatus
  }> {
    await this.ensureLoaded()
    // Non-forced reads are intentionally stale-while-revalidate. A
    // Worktrees bar should appear immediately using the last persisted
    // compact index, then the background refresh makes the next poll
    // fresher. Blocking the first render on a cold transcript scan is
    // exactly the latency trap this subsystem exists to avoid.
    if (params.refresh) {
      await this.refresh({ force: true })
    } else {
      this.refreshIfStale()
    }

    const summaries = await this.collectSummaries(params.worktrees)
    return {
      summaries,
      status: { ...this.status, refreshing: Boolean(this.refreshing) },
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loaded
    this.loaded = (async () => {
      const file = await loadWorktreeActivityIndex()
      this.updatedAt = file.updatedAt
      this.status.lastIndexedAt = file.updatedAt || null
      this.status.stale = true
      // Seed the LRU with the most-recently-indexed transcripts so
      // the first refresh has cache hits without pulling the entire
      // disk file into memory. Iterating Object.values is fine here
      // — the parsed object is already in scope from the load above
      // and will go out of scope after this function returns.
      this.totalOnDisk = Object.keys(file.transcripts).length
      const sortedByRecency = Object.entries(file.transcripts).sort(
        // Higher indexedAt = more recent. Insert oldest first so the
        // newest end up at the LRU's most-recently-used end.
        (a, b) => (a[1].indexedAt ?? 0) - (b[1].indexedAt ?? 0),
      )
      for (const [path, transcript] of sortedByRecency) {
        this.transcripts.set(path, transcript)
      }
    })()
    return this.loaded
  }

  private refreshIfStale(): void {
    const last = this.status.lastIndexedAt ?? 0
    if (Date.now() - last < BACKGROUND_REFRESH_MIN_INTERVAL_MS) return
    void this.refresh({ force: false }).catch(err => {
      console.warn('[worktree-activity] background refresh failed:', err)
    })
  }

  private async refresh(options: { force: boolean }): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (!options.force) {
      const last = this.status.lastIndexedAt ?? 0
      if (Date.now() - last < BACKGROUND_REFRESH_MIN_INTERVAL_MS) return
    }
    await this.ensureLoaded()
    this.refreshing = this.refreshNow().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async getTranscript(path: string): Promise<IndexedTranscript | null> {
    // LRU first, disk fallthrough on miss. The disk fallthrough is
    // load-bearing: with a 1000-entry LRU and 10 000 transcripts on
    // disk, the cache-hit check in refreshNow would otherwise see
    // every-evicted-entry as "new" and re-parse it on every refresh,
    // defeating the cache.
    //
    // CAVEAT: this method reparses the entire 30 MB+ JSON on every
    // miss. That's acceptable for one-off point lookups (no current
    // callers — kept for symmetry with the cache + future ad-hoc
    // queries), but FATAL inside a refresh loop where N misses
    // would multiply into N full reparses. `refreshNow` therefore
    // does NOT call this method on the hot path; it builds a single
    // disk snapshot once and looks up against that. See the comment
    // above the snapshot construction in `refreshNow`.
    const hit = this.transcripts.get(path)
    if (hit !== undefined) return hit
    const fromDisk = await loadEntryFromDisk(path)
    if (fromDisk) this.transcripts.set(path, fromDisk)
    return fromDisk
  }

  private async refreshNow(): Promise<void> {
    const span = performanceService.span('worktreeActivity.refresh')
    this.status = {
      ...this.status,
      refreshing: true,
      cacheHits: 0,
      parsedFiles: 0,
      skippedFiles: 0,
    }
    try {
      const candidates = await discoverTranscriptCandidates()
      const nextTranscripts: Record<string, IndexedTranscript> = {}

      // Build the disk snapshot ONCE when the on-disk set exceeds the
      // LRU's capacity. Without this, the per-candidate
      // `getTranscript()` would call `loadEntryFromDisk()` on every
      // LRU miss, and each call reparses the entire ~30 MB JSON. For
      // a heavy user with 5 000 transcripts and a 1 000-entry LRU
      // that's 4 000 reparses per refresh — ~120 GB of allocation
      // churn and the dominant cause of the main-process OOMs that
      // motivated this whole subsystem.
      //
      // For light users (everything fits in the LRU after seeding /
      // refresh) the snapshot is unnecessary work because every cache
      // lookup will hit the LRU. We skip the load entirely in that
      // case so they don't pay any cost for someone else's overflow.
      const diskSnapshot: Record<string, IndexedTranscript> | null =
        this.totalOnDisk > IN_MEMORY_MAX_ENTRIES
          ? await loadAllTranscriptsFromDisk()
          : null

      // Local lookup that mirrors `getTranscript` semantics but uses
      // the pre-loaded snapshot instead of hitting disk per call. We
      // still promote disk-snapshot hits into the LRU so that the
      // `nextTranscripts` write-back at the end of the refresh stays
      // correct (the LRU is repopulated from `nextTranscripts` below;
      // promoting the same entries here only matters as MRU
      // ordering, which is harmless).
      const lookupCached = (
        path: string,
      ): IndexedTranscript | null => {
        const hit = this.transcripts.get(path)
        if (hit !== undefined) return hit
        if (diskSnapshot !== null) {
          const fromSnapshot = diskSnapshot[path]
          if (fromSnapshot) {
            this.transcripts.set(path, fromSnapshot)
            return fromSnapshot
          }
        }
        return null
      }

      for (const candidate of candidates) {
        const previous = lookupCached(candidate.file)
        // Cache key is intentionally boring: path + provider identity +
        // mtime + size. We do not hash file contents because hashing
        // still requires reading the file, which is the expensive work
        // we are trying to skip. mtime+size is enough for local JSONL
        // transcripts: appends and rewrites change at least one of
        // them, and a missed same-size/same-mtime rewrite would only
        // make decorative activity metadata stale until the file moves
        // again. The transcript itself remains the provider's source
        // of truth.
        if (
          previous &&
          previous.provider === candidate.provider &&
          previous.providerSessionId === candidate.providerSessionId &&
          previous.mtimeMs === candidate.mtimeMs &&
          previous.size === candidate.size
        ) {
          nextTranscripts[candidate.file] = previous
          this.status.cacheHits += 1
          continue
        }

        try {
          nextTranscripts[candidate.file] = await parseTranscriptForActivity(
            candidate,
          )
          this.status.parsedFiles += 1
        } catch {
          this.status.skippedFiles += 1
        }
      }

      const updatedAt = Date.now()
      const indexFile: WorktreeActivityIndexFile = {
        version: 2,
        updatedAt,
        transcripts: nextTranscripts,
      }
      await saveWorktreeActivityIndex(indexFile)
      this.updatedAt = updatedAt
      this.totalOnDisk = Object.keys(nextTranscripts).length
      // Repopulate the LRU from the just-saved set. We don't clear
      // first: set() re-inserts existing keys at the MRU end and
      // evicts oldest once size exceeds the cap, so iterating the
      // freshly-built nextTranscripts in insertion order gives us a
      // self-cleaning refresh — entries that disappeared from
      // candidates (deleted transcripts) age out naturally as new
      // ones get inserted. Discovery order is good enough for MRU
      // ordering here: precise recency would need the candidate's
      // mtime, but we don't depend on perfect ordering — the LRU
      // is a hot cache, not a correctness boundary.
      for (const key of Object.keys(nextTranscripts)) {
        this.transcripts.set(key, nextTranscripts[key])
      }
      this.status.lastIndexedAt = updatedAt
      this.status.stale = false
      span.end({
        candidates: candidates.length,
        cacheHits: this.status.cacheHits,
        parsedFiles: this.status.parsedFiles,
        skippedFiles: this.status.skippedFiles,
      })
    } catch (err) {
      span.fail(err)
      throw err
    } finally {
      this.status.refreshing = false
    }
  }

  private async collectSummaries(
    worktrees: WorktreeIdentity[],
  ): Promise<WorktreeActivitySummary[]> {
    if (this.updatedAt === 0 && this.transcripts.size === 0) return []
    // Fast path: when every on-disk transcript fits in the LRU,
    // iterating the LRU gives the same answer as iterating disk
    // — and avoids the parse cost on every poll. This is the case
    // for light users (the OOM problem is heavy users). For heavy
    // users we pay the disk read on each summary call; this is
    // ~30 MB transient memory per call and is the cost of bounding
    // the resident set.
    let transcriptMap: Record<string, IndexedTranscript>
    if (this.totalOnDisk <= IN_MEMORY_MAX_ENTRIES) {
      // values() iterates without touching LRU ordering. We use the
      // transcript's `file` field as the key — it equals the LRU
      // map key by construction (refreshNow sets it that way).
      transcriptMap = {}
      for (const transcript of this.transcripts.values()) {
        transcriptMap[transcript.file] = transcript
      }
    } else {
      transcriptMap = await loadAllTranscriptsFromDisk()
    }
    const file: WorktreeActivityIndexFile = {
      version: 2,
      updatedAt: this.updatedAt,
      transcripts: transcriptMap,
    }
    return collectWorktreeActivitySummaries(file, worktrees)
  }
}

// Module-private since the only external caller used to be a unit
// test. Kept as a standalone function rather than inlined into
// `collectSummaries` because it remains a self-contained pure
// transform — the snapshot/disk-load path that builds the input is
// the messy part; the reduction itself reads more clearly when
// separate.
export function collectWorktreeActivitySummaries(
  index: WorktreeActivityIndexFile,
  worktrees: WorktreeIdentity[],
): WorktreeActivitySummary[] {
  const wanted = new Set(worktrees.map(w => w.path))
  const byPath = new Map<string, WorktreeActivitySummary>()

  for (const transcript of Object.values(index.transcripts)) {
    for (const event of transcript.events) {
      const matched = matchWorktree(event.path, worktrees)
      if (!matched || !wanted.has(matched.path)) continue
      const previous = byPath.get(matched.path)
      // The Worktrees bar's first question is "who was here last?",
      // not "aggregate every historical action ever performed here".
      // Resolve compact transcript events against the CURRENT
      // worktree set here, at query time. Persisting resolved
      // summaries made the cache depend on whichever project asked
      // first; storing path events keeps cache hits safe across
      // multiple repos and worktrees.
      // If a future feature needs richer history, it should add a
      // second query shape rather than making this overview heavier.
      const counts = incrementCounts(previous?.eventCounts ?? emptyCounts(), event.kind)
      const score = (previous?.score ?? 0) + event.primaryWeight
      if (!previous || event.ts > previous.lastActivityAt) {
        byPath.set(matched.path, {
          worktreePath: matched.path,
          branch: matched.branch ?? event.branch,
          lastActivityAt: event.ts,
          lastProvider: transcript.provider,
          lastProviderSessionId: transcript.providerSessionId,
          lastTranscriptFile: transcript.file,
          lastSource: event.source,
          score,
          eventCounts: counts,
        })
      } else {
        byPath.set(matched.path, {
          ...previous,
          score,
          eventCounts: counts,
        })
      }
    }
  }

  return [...byPath.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}
