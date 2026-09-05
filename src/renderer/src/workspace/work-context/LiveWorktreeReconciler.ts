import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import { asRecord } from '@shared/lib/asRecord'
import {
  canonicalizeWorktreeActivity,
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
  withFallbackWorktreeActivity,
} from '@shared/work-context/tracker'
import { extractWorktreeActivityEvents } from '@shared/work-context/extractors'
import type { WorktreeIdentity } from '@shared/work-context/types'

export type GitWorktreeCatalogResult =
  | { ok: true; worktrees: WorktreeIdentity[] }
  | { ok: false; gitMissing?: boolean }

export type WorktreeRuntimeProjection = Pick<
  SessionRuntime,
  'workActivity' | 'workContext'
>

export type WorktreeReconciliationDebug = {
  cacheState: 'missing' | 'loading' | 'ready' | 'stale'
  catalogCount: number
  recentEvidenceCount: number
  activeSource: string | null
  primarySource: string | null
  projectedPath: string | null
  projectedBranch: string | null
}

type CacheEntry = {
  worktrees: WorktreeIdentity[]
  refreshedAt: number
  inflight: Promise<RefreshOutcome> | null
}

type RefreshOutcome = 'cached' | 'ready' | 'failed' | 'disposed'

type SessionEvidence = {
  baseline: WorktreeRuntimeProjection
  recentRaw: unknown[]
  revision: number
  lastEmitted: WorktreeRuntimeProjection
  replay?: {
    cwd: string
    baseline: WorktreeRuntimeProjection
    revision: number
    catalog: WorktreeIdentity[] | undefined
    projection: WorktreeRuntimeProjection
  }
}

type Options = {
  loadWorktrees(cwd: string): Promise<GitWorktreeCatalogResult>
  onCatalogReady(cwd: string): void
  now?: () => number
  cacheTtlMs?: number
  recentRawLimit?: number
}

const DEFAULT_CACHE_TTL_MS = 5000
const DEFAULT_RECENT_RAW_LIMIT = 500

/**
 * Own the asynchronous seam between provider records and Git worktree truth.
 *
 * WHY this is a stateful renderer module instead of more shared tracker code:
 * provider parsing/reconciliation is deterministic and shared, but cache age,
 * in-flight IPC, bounded replay, and effect teardown exist only in the live
 * renderer. Keeping those concerns here leaves `useIpcSubscriptions` as the
 * sole consumer without making React's subscription megafile the policy owner.
 */
export class LiveWorktreeReconciler {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly evidenceBySession = new Map<SessionId, SessionEvidence>()
  private readonly loadWorktrees: Options['loadWorktrees']
  private readonly onCatalogReady: Options['onCatalogReady']
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly recentRawLimit: number
  private disposed = false

  constructor(options: Options) {
    this.loadWorktrees = options.loadWorktrees
    this.onCatalogReady = options.onCatalogReady
    this.now = options.now ?? Date.now
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.recentRawLimit = options.recentRawLimit ?? DEFAULT_RECENT_RAW_LIMIT
  }

  observe(
    sessionId: SessionId,
    cwd: string,
    entries: ReadonlyArray<{ entry: unknown }>,
    projection: WorktreeRuntimeProjection,
  ): WorktreeRuntimeProjection {
    if (this.disposed) return projection
    let evidence = this.evidenceBySession.get(sessionId)
    if (evidence && !sameProjection(projection, evidence.lastEmitted)) {
      // WHY the external projection becomes the baseline but cannot erase the
      // retained window: initial-history hydration runs independently from both
      // live SessionFeed subscriptions and the full Git catalog. It can finish
      // with a main-checkout-only projection after a decisive linked-worktree
      // write was already buffered here. Replaying retained raw evidence is the
      // only way the later full catalog can recover that path; tracker event
      // keys must be released below because hydration may have included the
      // same record under a smaller catalog and therefore the wrong checkout.
      evidence = {
        baseline: this.releaseRetainedEvidenceKeys(
          projection,
          evidence.recentRaw,
        ),
        recentRaw: evidence.recentRaw,
        revision: evidence.revision,
        lastEmitted: projection,
      }
    }
    evidence ??= {
      // WHY retain the pre-window baseline instead of replaying onto the latest
      // runtime: a stale catalog can initially collapse a linked-worktree path
      // into its parent checkout. Replaying the same event onto that state hits
      // the dedupe key and cannot correct the lost path. Rebuilding the bounded
      // window from the state that existed before it makes Git catalog changes
      // genuinely re-evaluate evidence rather than merely canonicalize an
      // already-lossy projection.
      baseline: projection,
      recentRaw: [],
      revision: 0,
      lastEmitted: projection,
    }

    // WHY the bound counts evidence rather than transport records: most JSONL
    // entries cannot affect worktree attribution. Letting hundreds of assistant
    // messages evict one direct write made a later Git-catalog expansion
    // irreversible even though the advertised 500-record "evidence" window had
    // actually held only one relevant observation.
    const relevantRaw = entries
      .map(({ entry }) => entry)
      .filter(entry => extractWorktreeActivityEvents(entry, this.now()).length > 0)
    evidence.recentRaw.push(...relevantRaw)
    // Length is not a generation: after eviction this window stays at 500
    // while its contents keep changing. Irrelevant transport batches do not
    // advance it and must not re-extract/re-fold the retained provider records.
    if (relevantRaw.length > 0) evidence.revision += 1
    if (evidence.recentRaw.length > this.recentRawLimit) {
      const evicted = evidence.recentRaw.splice(
        0,
        evidence.recentRaw.length - this.recentRawLimit,
      )
      evidence.baseline = this.foldRaw(
        cwd,
        evidence.baseline,
        evicted,
      )
    }
    this.evidenceBySession.set(sessionId, evidence)
    const next = this.rebuild(cwd, evidence)
    evidence.lastEmitted = next
    return next
  }

  forgetSession(sessionId: SessionId): void {
    this.evidenceBySession.delete(sessionId)
  }

  refresh(cwd: string | null | undefined): Promise<RefreshOutcome> {
    if (!cwd || this.disposed) return Promise.resolve('disposed')
    const cached = this.cache.get(cwd)
    if (cached?.inflight) return cached.inflight
    if (cached && this.now() - cached.refreshedAt < this.cacheTtlMs) {
      return Promise.resolve('cached')
    }

    const inflight = this.loadWorktrees(cwd)
      .then(result => {
        if (this.disposed) return 'disposed' as const
        if (!result.ok) return 'failed' as const
        const previous = this.cache.get(cwd)
        this.cache.set(cwd, {
          // Freshness and content are separate. Git IPC returns new arrays
          // even on a cache hit. Keep content identity when every field and
          // ordering agree (the first checkout is the authoritative repo root).
          worktrees: previous && sameCatalog(previous.worktrees, result.worktrees)
            ? previous.worktrees
            : result.worktrees,
          refreshedAt: this.now(),
          inflight: null,
        })
        // WHY notify only after the catalog is committed: the consumer can now
        // replay every record that arrived while IPC was pending against one
        // stable Git snapshot. Calling before set would recreate the original
        // race with an empty catalog under a more testable class name. Notify
        // even for unchanged contents: an independent history load may have
        // replaced a caller's projection and still needs retained-evidence
        // correction. project() itself skips replay when its inputs agree.
        this.onCatalogReady(cwd)
        return 'ready' as const
      })
      .catch(() => 'failed' as const)
      .finally(() => {
        if (this.disposed) return
        const latest = this.cache.get(cwd)
        if (latest?.inflight === inflight) {
          this.cache.set(cwd, { ...latest, inflight: null })
        }
      })

    this.cache.set(cwd, {
      worktrees: cached?.worktrees ?? [],
      refreshedAt: cached?.refreshedAt ?? 0,
      inflight,
    })
    return inflight
  }

  project(params: {
    sessionId: SessionId
    cwd: string
    projection: WorktreeRuntimeProjection
  }): WorktreeRuntimeProjection {
    const cached = this.cache.get(params.cwd)
    if (this.disposed || !cached || cached.refreshedAt <= 0) {
      return params.projection
    }

    let evidence = this.evidenceBySession.get(params.sessionId)
    if (!evidence) {
      return this.canonicalProjection(
        params.cwd,
        params.projection,
        cached.worktrees,
      )
    }
    if (!sameProjection(params.projection, evidence.lastEmitted)) {
      // This is the catalog-ready half of the same hydration race handled in
      // observe(). The caller's history is authoritative as a new baseline,
      // while the live raw window remains the evidence needed to reinterpret a
      // path that the history loader saw through a smaller Git catalog.
      evidence = {
        baseline: this.releaseRetainedEvidenceKeys(
          params.projection,
          evidence.recentRaw,
        ),
        recentRaw: evidence.recentRaw,
        revision: evidence.revision,
        lastEmitted: params.projection,
      }
      this.evidenceBySession.set(params.sessionId, evidence)
    }
    const next = this.rebuild(params.cwd, evidence)
    evidence.lastEmitted = next
    return next
  }

  private rebuild(
    cwd: string,
    evidence: SessionEvidence,
  ): WorktreeRuntimeProjection {
    const cached = this.cache.get(cwd)
    const catalog = cached && cached.refreshedAt > 0 ? cached.worktrees : undefined
    const replay = evidence.replay
    // This is an input cache, not an output deep comparison. Replaying 500
    // records to discover an identical result still blocks input on the renderer
    // thread, and ingestion timestamps can make the output look different.
    // External hydration resets this cache when adopting its baseline above;
    // catalog changes still take the original full correction/reversal path.
    if (replay && replay.cwd === cwd && replay.baseline === evidence.baseline &&
      replay.revision === evidence.revision && replay.catalog === catalog) {
      return replay.projection
    }
    const folded = this.foldRaw(cwd, evidence.baseline, evidence.recentRaw)
    const projection = catalog ? this.canonicalProjection(cwd, folded, catalog) : folded
    evidence.replay = { cwd, baseline: evidence.baseline, revision: evidence.revision, catalog, projection }
    return projection
  }

  private releaseRetainedEvidenceKeys(
    projection: WorktreeRuntimeProjection,
    recentRaw: readonly unknown[],
  ): WorktreeRuntimeProjection {
    if (!projection.workActivity || recentRaw.length === 0) return projection
    const retainedKeys = new Set(recentRaw.flatMap(raw => (
      extractWorktreeActivityEvents(raw, this.now()).map(event => event.key)
    )))
    if (retainedKeys.size === 0) return projection
    const releasedEvents = projection.workActivity.timeline.filter(
      event => retainedKeys.has(event.key),
    )
    const timeline = projection.workActivity.timeline.filter(
      event => !retainedKeys.has(event.key),
    )
    const touched = { ...projection.workActivity.touched }
    for (const event of releasedEvents) {
      const path = event.resolvedWorktreePath
      if (!path) continue
      const touch = touched[path]
      if (!touch) continue
      const eventCount = touch.eventCount - 1
      if (eventCount <= 0) {
        delete touched[path]
        continue
      }
      let latestSurvivor: (typeof timeline)[number] | null = null
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        if (timeline[index]?.resolvedWorktreePath === path) {
          latestSurvivor = timeline[index]!
          break
        }
      }
      touched[path] = {
        ...touch,
        score: Math.max(0, touch.score - event.primaryWeight),
        eventCount,
        writeCount: Math.max(
          0,
          touch.writeCount - (event.kind === 'file-write' ? 1 : 0),
        ),
        commandCount: Math.max(
          0,
          touch.commandCount - (event.command ? 1 : 0),
        ),
        // If the released observation supplied the summary's latest source,
        // prefer surviving event provenance. Older events may already have
        // rotated out of the bounded timeline, so retaining the existing
        // source is more honest than inventing one when no survivor remains.
        source: touch.source === event.source && latestSurvivor
          ? latestSurvivor.source
          : touch.source,
        lastAt: touch.source === event.source && latestSurvivor
          ? latestSurvivor.ts
          : touch.lastAt,
      }
    }
    const releasedOwnsContext = (
      context: typeof projection.workActivity.active,
    ): boolean => !!context && releasedEvents.some(event => (
      event.resolvedWorktreePath === context.worktreePath &&
      event.source === context.source
    ))
    const workActivity = {
      ...projection.workActivity,
      // WHY reversal covers aggregates and contexts, not only dedupe keys: a
      // stale history catalog may have awarded the retained write's score to
      // main. Replaying without first subtracting that exact contribution
      // leaves primary/workContext corrupted even when active becomes correct.
      // resolvedWorktreePath is captured at ingestion specifically so this
      // transaction can identify the checkout that received the old score.
      active: releasedOwnsContext(projection.workActivity.active)
        ? null
        : projection.workActivity.active,
      primary: releasedOwnsContext(projection.workActivity.primary)
        ? null
        : projection.workActivity.primary,
      touched,
      timeline,
      recentKeys: projection.workActivity.recentKeys.filter(
        key => !retainedKeys.has(key),
      ),
    }
    return {
      workActivity,
      workContext: deriveAgentWorkContext(workActivity),
    }
  }

  private foldRaw(
    cwd: string,
    projection: WorktreeRuntimeProjection,
    rawEntries: readonly unknown[],
  ): WorktreeRuntimeProjection {
    const cached = this.cache.get(cwd)
    const hasCatalog = !!cached && cached.refreshedAt > 0
    let workActivity = projection.workActivity
    for (const raw of rawEntries) {
      // Claude's explicit worktree-state is useful before Git IPC resolves; its
      // provider path can seed state and is canonicalized on catalog arrival.
      // All other provider paths stay buffered rather than being guessed
      // against an empty worktree list.
      if (asRecord(raw)?.type !== 'worktree-state' && !hasCatalog) continue
      workActivity = ingestWorktreeRawEvent({
        state: workActivity,
        raw,
        worktrees: cached?.worktrees ?? [],
        sessionCwd: cwd,
      })
    }
    return {
      workActivity,
      workContext: deriveAgentWorkContext(workActivity),
    }
  }

  private canonicalProjection(
    cwd: string,
    projection: WorktreeRuntimeProjection,
    worktrees: WorktreeIdentity[],
  ): WorktreeRuntimeProjection {
    const workActivity = canonicalizeWorktreeActivity(
      withFallbackWorktreeActivity({
        state: projection.workActivity,
        sessionCwd: cwd,
        worktrees,
        source: 'fallback:session-cwd:worktree-cache',
      }),
      worktrees,
    )
    const workContext = deriveAgentWorkContext(workActivity)
    if (workActivity === projection.workActivity && workContext === projection.workContext) {
      return projection
    }
    return {
      workActivity,
      workContext,
    }
  }

  summarize(params: {
    sessionId: SessionId
    cwd: string
    projection: WorktreeRuntimeProjection
  }): WorktreeReconciliationDebug {
    const cached = this.cache.get(params.cwd)
    const age = cached ? this.now() - cached.refreshedAt : null
    const cacheState = !cached
      ? 'missing'
      : cached.inflight
        ? 'loading'
        : cached.refreshedAt <= 0
          ? 'missing'
          : age !== null && age >= this.cacheTtlMs
            ? 'stale'
            : 'ready'
    return {
      cacheState,
      catalogCount: cached?.worktrees.length ?? 0,
      recentEvidenceCount:
        this.evidenceBySession.get(params.sessionId)?.recentRaw.length ?? 0,
      activeSource: params.projection.workActivity?.active?.source ?? null,
      primarySource: params.projection.workActivity?.primary?.source ?? null,
      projectedPath: params.projection.workContext?.worktreePath ?? null,
      projectedBranch: params.projection.workContext?.branch ?? null,
    }
  }

  dispose(): void {
    // Promise continuations check `disposed` before publishing their catalog or
    // invoking React state. Clearing both maps also severs raw provider records
    // at the same atomic effect-teardown boundary as SessionFeed listeners.
    this.disposed = true
    this.cache.clear()
    this.evidenceBySession.clear()
  }
}

function sameCatalog(left: WorktreeIdentity[], right: WorktreeIdentity[]): boolean {
  return left.length === right.length && left.every((worktree, index) => {
    const other = right[index]!
    return worktree.path === other.path && worktree.branch === other.branch &&
      worktree.head === other.head && worktree.detached === other.detached
  })
}

function sameProjection(
  left: WorktreeRuntimeProjection,
  right: WorktreeRuntimeProjection,
): boolean {
  return left.workActivity === right.workActivity &&
    left.workContext === right.workContext
}
