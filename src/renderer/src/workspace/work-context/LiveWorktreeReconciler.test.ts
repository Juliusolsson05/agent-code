import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'

import type { WorktreeRuntimeProjection } from './LiveWorktreeReconciler'
import { LiveWorktreeReconciler } from './LiveWorktreeReconciler'

type RecordedFixture = {
  git: {
    main: { path: string; branch: string }
    grid?: { path: string; branch: string }
    ui?: { path: string; branch: string }
  }
  records: Array<Record<string, unknown>>
}

type GitFixture = {
  worktrees: Array<{
    path: string
    branch: string
    detached: boolean
  }>
}

const emptyProjection = (): WorktreeRuntimeProjection => ({
  workActivity: null,
  workContext: null,
})

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(
    process.cwd(),
    'testing',
    'fixtures',
    'worktree-live-attribution',
    name,
  ), 'utf8')) as T
}

function catalog() {
  return fixture<GitFixture>('git-worktree-identities.json').worktrees
    .map(worktree => ({ ...worktree, head: null }))
}

describe('LiveWorktreeReconciler recorded cache ordering', () => {
  it('replays the Codex worktree window when entries beat Git IPC', async () => {
    const codex = fixture<RecordedFixture>('codex-0151-worktree-window.json')
    let resolveCatalog!: (value: { ok: true; worktrees: ReturnType<typeof catalog> }) => void
    const pendingCatalog = new Promise<{
      ok: true
      worktrees: ReturnType<typeof catalog>
    }>(resolve => { resolveCatalog = resolve })
    let projection = emptyProjection()
    let reconciler!: LiveWorktreeReconciler
    reconciler = new LiveWorktreeReconciler({
      loadWorktrees: () => pendingCatalog,
      onCatalogReady: cwd => {
        projection = reconciler.project({
          sessionId: 'codex-recorded',
          cwd,
          projection,
        })
      },
    })

    const refreshing = reconciler.refresh(codex.git.main.path)
    const wrapped = codex.records.map(entry => ({ entry }))
    projection = reconciler.observe(
      'codex-recorded',
      codex.git.main.path,
      wrapped,
      projection,
    )
    expect(projection.workContext).toBeNull()

    resolveCatalog({ ok: true, worktrees: catalog() })
    await refreshing

    expect(projection.workActivity?.active).toMatchObject({
      worktreePath: codex.git.ui?.path,
      branch: codex.git.ui?.branch,
    })
    expect(projection.workContext?.worktreePath).toBe(codex.git.ui?.path)
  })

  it('ingests the Claude disagreement after Git IPC is already cached', async () => {
    const claude = fixture<RecordedFixture>(
      'claude-cwd-tool-branch-conflict.json',
    )
    let projection = emptyProjection()
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: async () => ({ ok: true, worktrees: catalog() }),
      onCatalogReady: () => undefined,
    })
    await reconciler.refresh(claude.git.main.path)
    const wrapped = [{ entry: claude.records[0] }]
    projection = reconciler.observe(
      'claude-recorded',
      claude.git.main.path,
      wrapped,
      projection,
    )

    expect(projection.workActivity?.active).toMatchObject({
      worktreePath: claude.git.grid?.path,
      branch: claude.git.grid?.branch,
      source: 'tool:Write:path',
    })
  })

  it('coalesces an in-flight catalog request for one cwd', async () => {
    const codex = fixture<RecordedFixture>('codex-0151-worktree-window.json')
    let resolveCatalog!: (value: { ok: true; worktrees: ReturnType<typeof catalog> }) => void
    const pendingCatalog = new Promise<{
      ok: true
      worktrees: ReturnType<typeof catalog>
    }>(resolve => { resolveCatalog = resolve })
    const loadWorktrees = vi.fn(() => pendingCatalog)
    const onCatalogReady = vi.fn()
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees,
      onCatalogReady,
    })

    const first = reconciler.refresh(codex.git.main.path)
    const second = reconciler.refresh(codex.git.main.path)
    expect(loadWorktrees).toHaveBeenCalledTimes(1)
    resolveCatalog({ ok: true, worktrees: catalog() })
    await Promise.all([first, second])
    expect(onCatalogReady).toHaveBeenCalledTimes(1)
  })

  it('retries a failed probe and replays evidence after a stale catalog expands', async () => {
    const claude = fixture<RecordedFixture>(
      'claude-cwd-tool-branch-conflict.json',
    )
    let now = 1_000
    const fullCatalog = catalog()
    const mainOnly = fullCatalog.filter(
      worktree => worktree.path === claude.git.main.path,
    )
    const loadWorktrees = vi.fn()
      .mockResolvedValueOnce({ ok: false, gitMissing: false })
      .mockResolvedValueOnce({ ok: true, worktrees: mainOnly })
      .mockResolvedValueOnce({ ok: true, worktrees: fullCatalog })
    let projection = emptyProjection()
    let reconciler!: LiveWorktreeReconciler
    reconciler = new LiveWorktreeReconciler({
      loadWorktrees,
      now: () => now,
      cacheTtlMs: 100,
      recentRawLimit: 2,
      onCatalogReady: cwd => {
        projection = reconciler.project({
          sessionId: 'catalog-expanded',
          cwd,
          projection,
        })
      },
    })

    expect(await reconciler.refresh(claude.git.main.path)).toBe('failed')
    expect(await reconciler.refresh(claude.git.main.path)).toBe('ready')
    const wrapped = [
      { entry: claude.records[0] },
      { entry: { type: 'event_msg', payload: { type: 'assistant_message' } } },
      { entry: { type: 'event_msg', payload: { type: 'token_count' } } },
    ]
    projection = reconciler.observe(
      'catalog-expanded',
      claude.git.main.path,
      wrapped,
      projection,
    )
    expect(projection.workContext?.worktreePath).toBe(claude.git.main.path)

    now += 101
    expect(await reconciler.refresh(claude.git.main.path)).toBe('ready')
    expect(reconciler.summarize({
      sessionId: 'catalog-expanded',
      cwd: claude.git.main.path,
      projection,
    })).toMatchObject({ catalogCount: 3, recentEvidenceCount: 1 })
    expect(projection.workActivity?.timeline.map(event => ({
      kind: event.kind,
      path: event.path,
    }))).toEqual([
      {
        kind: 'session-cwd',
        path: claude.git.main.path,
      },
      {
        kind: 'file-write',
        path: expect.stringContaining(claude.git.grid?.path ?? ''),
      },
    ])
    expect(projection.workActivity?.active).toMatchObject({
      worktreePath: claude.git.grid?.path,
      source: 'tool:Write:path',
      confidence: 'strong',
    })
    expect(loadWorktrees).toHaveBeenCalledTimes(3)
  })

  it('retains live evidence when stale initial history resolves before Git IPC', async () => {
    const claude = fixture<RecordedFixture>(
      'claude-cwd-tool-branch-conflict.json',
    )
    const fullCatalog = catalog()
    const mainOnly = fullCatalog.filter(
      worktree => worktree.path === claude.git.main.path,
    )
    let resolveCatalog!: (value: {
      ok: true
      worktrees: ReturnType<typeof catalog>
    }) => void
    const pendingCatalog = new Promise<{
      ok: true
      worktrees: ReturnType<typeof catalog>
    }>(resolve => { resolveCatalog = resolve })
    let projection = emptyProjection()
    let reconciler!: LiveWorktreeReconciler
    reconciler = new LiveWorktreeReconciler({
      loadWorktrees: () => pendingCatalog,
      onCatalogReady: cwd => {
        projection = reconciler.project({
          sessionId: 'history-race',
          cwd,
          projection,
        })
      },
    })
    const refreshing = reconciler.refresh(claude.git.main.path)

    projection = reconciler.observe(
      'history-race',
      claude.git.main.path,
      [{ entry: claude.records[0] }],
      projection,
    )
    expect(projection.workContext).toBeNull()

    // WHY hydrate against a deliberately smaller catalog: the original race
    // involved two independent loaders. A test that gives both the same full
    // catalog cannot prove that adopting history preserves the stronger live
    // path until renderer Git IPC finishes.
    const hydratedActivity = ingestWorktreeRawEvent({
      state: null,
      raw: claude.records[0],
      worktrees: mainOnly,
      sessionCwd: claude.git.main.path,
    })
    projection = {
      workActivity: hydratedActivity,
      workContext: deriveAgentWorkContext(hydratedActivity),
    }
    expect(projection.workContext?.worktreePath).toBe(claude.git.main.path)

    resolveCatalog({ ok: true, worktrees: fullCatalog })
    await refreshing

    expect(projection.workActivity?.active).toMatchObject({
      worktreePath: claude.git.grid?.path,
      source: 'tool:Write:path',
    })
    expect(reconciler.summarize({
      sessionId: 'history-race',
      cwd: claude.git.main.path,
      projection,
    })).toMatchObject({ recentEvidenceCount: 1, catalogCount: 3 })
  })

  it('bounds metadata-only diagnostics and suppresses late callbacks after dispose', async () => {
    const codex = fixture<RecordedFixture>('codex-0151-worktree-window.json')
    let resolveCatalog!: (value: { ok: true; worktrees: ReturnType<typeof catalog> }) => void
    const pendingCatalog = new Promise<{
      ok: true
      worktrees: ReturnType<typeof catalog>
    }>(resolve => { resolveCatalog = resolve })
    const onCatalogReady = vi.fn()
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: () => pendingCatalog,
      onCatalogReady,
      recentRawLimit: 2,
    })
    const projection = reconciler.observe(
      'disposed-session',
      codex.git.main.path,
      codex.records.slice(0, 4).map(entry => ({ entry })),
      emptyProjection(),
    )
    const summary = reconciler.summarize({
      sessionId: 'disposed-session',
      cwd: codex.git.main.path,
      projection,
    })
    expect(summary).toEqual({
      cacheState: 'missing',
      catalogCount: 0,
      recentEvidenceCount: 2,
      activeSource: null,
      primarySource: null,
      projectedPath: null,
      projectedBranch: null,
    })
    expect(JSON.stringify(summary)).not.toContain('command')

    const refreshing = reconciler.refresh(codex.git.main.path)
    reconciler.forgetSession('disposed-session')
    reconciler.dispose()
    resolveCatalog({ ok: true, worktrees: catalog() })
    expect(await refreshing).toBe('disposed')
    expect(onCatalogReady).not.toHaveBeenCalled()
  })
})
