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
  private loaded: Promise<void> | null = null
  private refreshing: Promise<void> | null = null
  private index: WorktreeActivityIndexFile | null = null
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

    return {
      summaries: this.collectSummaries(params.worktrees),
      status: { ...this.status, refreshing: Boolean(this.refreshing) },
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loaded
    this.loaded = (async () => {
      this.index = await loadWorktreeActivityIndex()
      this.status.lastIndexedAt = this.index.updatedAt || null
      this.status.stale = true
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
      const current = this.index!
      const candidates = await discoverTranscriptCandidates()
      const nextTranscripts: Record<string, IndexedTranscript> = {}

      for (const candidate of candidates) {
        const previous = current.transcripts[candidate.file]
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

      this.index = {
        version: current.version,
        updatedAt: Date.now(),
        transcripts: nextTranscripts,
      }
      await saveWorktreeActivityIndex(this.index)
      this.status.lastIndexedAt = this.index.updatedAt
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

  private collectSummaries(worktrees: WorktreeIdentity[]): WorktreeActivitySummary[] {
    const index = this.index
    if (!index) return []
    return collectWorktreeActivitySummaries(index, worktrees)
  }
}

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
