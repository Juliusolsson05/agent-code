import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import { asRecord } from '@shared/lib/asRecord'
import {
  canonicalizeWorktreeActivity,
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
  withFallbackWorktreeActivity,
} from '@shared/work-context/tracker'
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
  private readonly evidenceBySession = new Map<SessionId, {
    baseline: WorktreeRuntimeProjection
    recentRaw: unknown[]
  }>()
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
    if (this.disposed || entries.length === 0) return projection
    const evidence = this.evidenceBySession.get(sessionId) ?? {
      // WHY retain the pre-window baseline instead of replaying onto the latest
      // runtime: a stale catalog can initially collapse a linked-worktree path
      // into its parent checkout. Replaying the same event onto that state hits
      // the dedupe key and cannot correct the lost path. Rebuilding the bounded
      // window from the state that existed before it makes Git catalog changes
      // genuinely re-evaluate evidence rather than merely canonicalize an
      // already-lossy projection.
      baseline: projection,
      recentRaw: [],
    }
    evidence.recentRaw.push(...entries.map(({ entry }) => entry))
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
    return this.rebuild(cwd, evidence)
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
        this.cache.set(cwd, {
          worktrees: result.worktrees,
          refreshedAt: this.now(),
          inflight: null,
        })
        // WHY notify only after the catalog is committed: the consumer can now
        // replay every record that arrived while IPC was pending against one
        // stable Git snapshot. Calling before set would recreate the original
        // race with an empty catalog under a more testable class name.
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

    const evidence = this.evidenceBySession.get(params.sessionId)
    if (!evidence) {
      return this.canonicalProjection(
        params.cwd,
        params.projection,
        cached.worktrees,
      )
    }
    return this.rebuild(params.cwd, evidence)
  }

  private rebuild(
    cwd: string,
    evidence: {
      baseline: WorktreeRuntimeProjection
      recentRaw: unknown[]
    },
  ): WorktreeRuntimeProjection {
    const projection = this.foldRaw(cwd, evidence.baseline, evidence.recentRaw)
    const cached = this.cache.get(cwd)
    if (!cached || cached.refreshedAt <= 0) return projection
    return this.canonicalProjection(cwd, projection, cached.worktrees)
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
    return {
      workActivity,
      workContext: deriveAgentWorkContext(workActivity),
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
