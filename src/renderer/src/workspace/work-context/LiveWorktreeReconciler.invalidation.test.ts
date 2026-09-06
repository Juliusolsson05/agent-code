import { describe, expect, it, vi } from 'vitest'
import { canonicalizeWorktreeActivity, ingestWorktreeRawEvent } from '@shared/work-context/tracker'
import { LiveWorktreeReconciler, type WorktreeRuntimeProjection } from './LiveWorktreeReconciler'

const main = { path: '/repo', branch: 'main', head: null, detached: false }
const linked = { path: '/repo/linked', branch: 'feature', head: null, detached: false }
const write = {
  type: 'assistant', timestamp: '2026-09-01T00:00:00Z', cwd: '/repo',
  message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/repo/linked/file.ts' } }] },
}
const empty = (): WorktreeRuntimeProjection => ({ workActivity: null, workContext: null })

describe('worktree reconciliation invalidation boundaries', () => {
  it('keeps canonical state and context identities unless Git changes their values', () => {
    const state = ingestWorktreeRawEvent({ state: null, raw: write, sessionCwd: '/repo', worktrees: [main, linked] })
    const canonical = canonicalizeWorktreeActivity(state, [main, linked])
    expect(canonicalizeWorktreeActivity(canonical, [{ ...main }, { ...linked }])).toBe(canonical)
    const detached = canonicalizeWorktreeActivity(canonical, [main, { ...linked, branch: null, detached: true }])
    expect(detached).not.toBe(canonical)
    expect(detached.primary?.branch).toBeNull()
    expect(detached.timeline).toBe(canonical.timeline)
  })

  it('keeps quiet-session projection identity across identical successful refreshes', async () => {
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees: [{ ...main }] }),
      onCatalogReady: () => undefined, cacheTtlMs: 0,
    })
    await reconciler.refresh('/repo')
    const projection = reconciler.project({ sessionId: 'quiet', cwd: '/repo', projection: empty() })
    await reconciler.refresh('/repo')
    expect(reconciler.project({ sessionId: 'quiet', cwd: '/repo', projection })).toBe(projection)
  })

  it('does not re-read retained records for empty/irrelevant batches or identical catalogs', async () => {
    // A getter counts actual provider-record reads without spying on private
    // cache fields. A value-equality assertion alone would miss wasteful replay
    // that eventually compares equal; wall-clock assertions would be flaky.
    const readMessage = vi.fn(() => write.message)
    const raw = { ...write, get message() { return readMessage() } }
    const onCatalogReady = vi.fn()
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees: [{ ...main }, { ...linked }] }),
      onCatalogReady, cacheTtlMs: 0,
    })
    await reconciler.refresh('/repo')
    const projection = reconciler.observe('busy', '/repo', [{ entry: raw }], empty())
    expect(readMessage).toHaveBeenCalled()
    readMessage.mockClear()
    expect(reconciler.observe('busy', '/repo', [], projection)).toBe(projection)
    expect(reconciler.observe('busy', '/repo', [{ entry: { type: 'irrelevant' } }], projection)).toBe(projection)
    await reconciler.refresh('/repo')
    expect(reconciler.project({ sessionId: 'busy', cwd: '/repo', projection })).toBe(projection)
    expect(readMessage).not.toHaveBeenCalled()
    // Must still notify: history may have replaced the caller's projection.
    expect(onCatalogReady).toHaveBeenCalledTimes(2)
  })

  it('corrects external stale hydration even when the catalog did not change', async () => {
    let projection = empty()
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees: [{ ...main }, { ...linked }] }),
      cacheTtlMs: 0,
      onCatalogReady: cwd => { projection = reconciler.project({ sessionId: 'race', cwd, projection }) },
    })
    await reconciler.refresh('/repo')
    projection = reconciler.observe('race', '/repo', [{ entry: write }], projection)
    const expectedTouches = projection.workActivity?.touched
    const stale = ingestWorktreeRawEvent({ state: null, raw: write, sessionCwd: '/repo', worktrees: [main] })
    projection = { workActivity: stale, workContext: stale.primary }
    await reconciler.refresh('/repo')
    expect(projection.workContext?.worktreePath).toBe('/repo/linked')
    expect(projection.workActivity?.touched['/repo/linked'].score).toBe(expectedTouches?.['/repo/linked'].score)
    expect(projection.workActivity?.touched['/repo'].writeCount ?? 0).toBe(0)
  })

  it('invalidates on cwd change even when both directories share the same catalog', async () => {
    const worktrees = [main, linked]
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees }),
      onCatalogReady: () => undefined,
    })
    await reconciler.refresh('/repo')
    await reconciler.refresh('/repo/linked')
    const first = reconciler.observe('moved', '/repo', [], empty())
    expect(first.workContext?.worktreePath).toBe('/repo')
    const moved = reconciler.observe('moved', '/repo/linked', [], first)
    expect(moved.workContext?.worktreePath).toBe('/repo/linked')
    expect(reconciler.observe('moved', '/repo/linked', [], moved)).toBe(moved)
  })

  it('distinguishes a successfully loaded empty catalog from a pending catalog', async () => {
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees: [] }),
      onCatalogReady: () => undefined,
    })
    let projection = reconciler.observe('empty-catalog', '/repo', [], empty())
    expect(projection.workActivity).toBeNull()
    await reconciler.refresh('/repo')
    projection = reconciler.project({ sessionId: 'empty-catalog', cwd: '/repo', projection })
    expect(projection.workActivity).not.toBeNull()
    expect(reconciler.observe('empty-catalog', '/repo', [], projection)).toBe(projection)
  })

  it('invalidates replay on catalog expansion/removal, branch changes and evidence eviction', async () => {
    let worktrees = [main]
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees }),
      onCatalogReady: () => undefined, cacheTtlMs: 0, recentRawLimit: 1,
    })
    await reconciler.refresh('/repo')
    let projection = reconciler.observe('change', '/repo', [{ entry: write }], empty())
    expect(projection.workContext?.worktreePath).toBe('/repo')
    worktrees = [main, linked]
    await reconciler.refresh('/repo')
    projection = reconciler.project({ sessionId: 'change', cwd: '/repo', projection })
    expect(projection.workContext?.worktreePath).toBe('/repo/linked')
    worktrees = [main, { ...linked, branch: 'renamed' }]
    await reconciler.refresh('/repo')
    projection = reconciler.project({ sessionId: 'change', cwd: '/repo', projection })
    expect(projection.workContext?.branch).toBe('renamed')
    worktrees = [main]
    await reconciler.refresh('/repo')
    projection = reconciler.project({ sessionId: 'change', cwd: '/repo', projection })
    expect(projection.workContext?.worktreePath).toBe('/repo')
    const another = { ...write, timestamp: '2026-09-01T00:01:00Z' }
    projection = reconciler.observe('change', '/repo', [{ entry: another }], projection)
    expect(projection.workActivity?.touched['/repo'].writeCount).toBe(2)
    expect(reconciler.observe('change', '/repo', [], projection)).toBe(projection)
    reconciler.forgetSession('change')
    const replacement = reconciler.observe('change', '/repo', [], empty())
    expect(replacement.workActivity?.touched['/repo']?.writeCount ?? 0).toBe(0)
  })
})
