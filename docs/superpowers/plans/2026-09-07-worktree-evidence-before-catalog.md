### Task 3: Fix #822, evidence evicted before the first Git catalog is lost

**Files:**
- Modify: `src/renderer/src/workspace/work-context/LiveWorktreeReconciler.ts`
- Modify: `src/renderer/src/workspace/work-context/LiveWorktreeReconciler.test.ts`
- Create: `docs/superpowers/plans/2026-09-07-worktree-evidence-before-catalog.md` (this section)

**Interfaces:**
- Consumes: the recorded fixture `testing/fixtures/worktree-live-attribution/claude-cwd-tool-branch-conflict.json` (its `records[0]` and `records[1]` are assistant `Write` tool uses into `/fixture/project-1/.worktrees/worktree-1/...`, both relevant evidence) and `git-worktree-identities.json`.
- Produces: `SessionEvidence.deferredRaw: unknown[]`, `SessionEvidence.droppedBeforeCatalog: number`; `WorktreeReconciliationDebug` gains `deferredEvidenceCount: number` and `droppedBeforeCatalog: number`.

The defect, from the code on `origin/main`: `observe()` evicts records beyond `recentRawLimit` (500) into the baseline through `foldRaw()`. `foldRaw()` skips every record that is not a `worktree-state` record while the cwd has no catalog (`if (asRecord(raw)?.type !== 'worktree-state' && !hasCatalog) continue`). Records retained in `recentRaw` are safe because `rebuild()` re-folds them after the catalog arrives; records evicted before the catalog are gone. The fix keeps evicted-without-catalog records in a second bounded list and folds them into the baseline the first time `rebuild()` runs with a catalog. Overflow of that second list is counted, not silent.

- [ ] **Step 1: Create the worktree and commit the plan**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code
git worktree add .worktrees/worktree-evidence-before-catalog -b fix/worktree-evidence-before-catalog origin/main
cd .worktrees/worktree-evidence-before-catalog
git submodule update --init && ln -s ../../node_modules node_modules
# copy this Task 3 section into docs/superpowers/plans/2026-09-07-worktree-evidence-before-catalog.md
git add docs/superpowers/plans/2026-09-07-worktree-evidence-before-catalog.md
git commit -m "docs(worktrees): plan retaining evidence evicted before the first Git catalog

Refs #822

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd"
```

- [ ] **Step 2: Write the failing tests**

Append inside the existing `describe('LiveWorktreeReconciler recorded cache ordering', ...)` block in `LiveWorktreeReconciler.test.ts`:

```ts
  it('folds evidence evicted before the first catalog once the catalog arrives (#822)', async () => {
    const claude = fixture<RecordedFixture>('claude-cwd-tool-branch-conflict.json')
    let resolveCatalog!: (value: { ok: true; worktrees: ReturnType<typeof catalog> }) => void
    const pendingCatalog = new Promise<{ ok: true; worktrees: ReturnType<typeof catalog> }>(
      resolve => { resolveCatalog = resolve },
    )
    let projection = emptyProjection()
    let reconciler!: LiveWorktreeReconciler
    reconciler = new LiveWorktreeReconciler({
      loadWorktrees: () => pendingCatalog,
      // A window of one guarantees the first write is evicted by the second
      // while Git IPC is still pending, which is the #822 loss path.
      recentRawLimit: 1,
      onCatalogReady: cwd => {
        projection = reconciler.project({ sessionId: 'evicted-early', cwd, projection })
      },
    })

    const refreshing = reconciler.refresh(claude.git.main.path)
    projection = reconciler.observe('evicted-early', claude.git.main.path, [{ entry: claude.records[0] }], projection)
    projection = reconciler.observe('evicted-early', claude.git.main.path, [{ entry: claude.records[1] }], projection)
    expect(reconciler.summarize({ sessionId: 'evicted-early', cwd: claude.git.main.path, projection }))
      .toMatchObject({ recentEvidenceCount: 1, deferredEvidenceCount: 1, droppedBeforeCatalog: 0 })

    resolveCatalog({ ok: true, worktrees: catalog() })
    expect(await refreshing).toBe('ready')

    const writes = projection.workActivity?.timeline.filter(event => event.kind === 'file-write') ?? []
    expect(writes).toHaveLength(2)
    expect(writes.every(event => event.resolvedWorktreePath === claude.git.grid?.path)).toBe(true)
    expect(reconciler.summarize({ sessionId: 'evicted-early', cwd: claude.git.main.path, projection }))
      .toMatchObject({ deferredEvidenceCount: 0, droppedBeforeCatalog: 0 })
  })

  it('bounds the deferred window and reports what it dropped', async () => {
    const claude = fixture<RecordedFixture>('claude-cwd-tool-branch-conflict.json')
    const reconciler = new LiveWorktreeReconciler({
      loadWorktrees: () => new Promise(() => undefined),   // catalog never arrives
      recentRawLimit: 1,
      onCatalogReady: () => undefined,
    })
    let projection = emptyProjection()
    void reconciler.refresh(claude.git.main.path)
    for (let i = 0; i < 3; i += 1) {
      projection = reconciler.observe('never-catalog', claude.git.main.path, [{ entry: claude.records[i % 2] }], projection)
    }
    // Three relevant records, window of one: one live, one deferred, one dropped.
    expect(reconciler.summarize({ sessionId: 'never-catalog', cwd: claude.git.main.path, projection }))
      .toMatchObject({ recentEvidenceCount: 1, deferredEvidenceCount: 1, droppedBeforeCatalog: 1 })
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24
NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/work-context/LiveWorktreeReconciler.test.ts
```
Expected: the two new tests FAIL (`deferredEvidenceCount` is undefined; the first test finds 1 write instead of 2). The existing six tests still pass.

- [ ] **Step 4: Implement**

In `LiveWorktreeReconciler.ts`:

1. Extend the debug type:

```ts
export type WorktreeReconciliationDebug = {
  cacheState: 'missing' | 'loading' | 'ready' | 'stale'
  catalogCount: number
  recentEvidenceCount: number
  /** Relevant records evicted from the live window before this cwd had a Git
   *  catalog. They are folded into the baseline on the first rebuild that
   *  has one (#822). Non-zero means Git IPC is still pending. */
  deferredEvidenceCount: number
  /** Deferred records lost to the deferred window's own bound. Non-zero is
   *  an honest "attribution for this session is incomplete" signal. */
  droppedBeforeCatalog: number
  activeSource: string | null
  primarySource: string | null
  projectedPath: string | null
  projectedBranch: string | null
}
```

2. Extend `SessionEvidence`:

```ts
type SessionEvidence = {
  baseline: WorktreeRuntimeProjection
  recentRaw: unknown[]
  // WHY a second list instead of folding into the baseline immediately:
  // foldRaw() cannot interpret a provider path without the Git catalog (it
  // would guess against an empty worktree list and then dedupe the correct
  // answer away later), and dropping the record was the #822 data loss.
  // Holding it here until the catalog arrives keeps the eviction lossless
  // for the first `recentRawLimit` records; beyond that the loss is counted.
  deferredRaw: unknown[]
  droppedBeforeCatalog: number
  revision: number
  lastEmitted: WorktreeRuntimeProjection
  replay?: { /* unchanged */ }
}
```

3. In `observe()`, both evidence constructions (`evidence = { ... }` in the hydration branch and `evidence ??= { ... }`) carry the new fields: the hydration branch copies `deferredRaw: evidence.deferredRaw, droppedBeforeCatalog: evidence.droppedBeforeCatalog` and releases keys for deferred records too:

```ts
      evidence = {
        baseline: this.releaseRetainedEvidenceKeys(
          projection,
          // Deferred records will be folded later exactly like the live
          // window, so hydration must release their keys as well or they
          // would double-count against the history loader's smaller catalog.
          [...evidence.deferredRaw, ...evidence.recentRaw],
        ),
        recentRaw: evidence.recentRaw,
        deferredRaw: evidence.deferredRaw,
        droppedBeforeCatalog: evidence.droppedBeforeCatalog,
        revision: evidence.revision,
        lastEmitted: projection,
      }
```

and the fresh construction adds `deferredRaw: [], droppedBeforeCatalog: 0,`.

4. Replace the eviction block in `observe()`:

```ts
    if (evidence.recentRaw.length > this.recentRawLimit) {
      const evicted = evidence.recentRaw.splice(
        0,
        evidence.recentRaw.length - this.recentRawLimit,
      )
      const cached = this.cache.get(cwd)
      if (cached && cached.refreshedAt > 0) {
        evidence.baseline = this.foldRaw(cwd, evidence.baseline, evicted)
      } else {
        // No catalog yet. worktree-state records fold safely without one
        // (foldRaw applies them); every other provider path must wait.
        const foldable = evicted.filter(raw => asRecord(raw)?.type === 'worktree-state')
        const deferred = evicted.filter(raw => asRecord(raw)?.type !== 'worktree-state')
        if (foldable.length > 0) {
          evidence.baseline = this.foldRaw(cwd, evidence.baseline, foldable)
        }
        evidence.deferredRaw.push(...deferred)
        if (evidence.deferredRaw.length > this.recentRawLimit) {
          // Same bound as the live window so a session that never gets a
          // catalog holds at most 2 × recentRawLimit records. Oldest go
          // first because attribution weights recency.
          const overflow = evidence.deferredRaw.length - this.recentRawLimit
          evidence.deferredRaw.splice(0, overflow)
          evidence.droppedBeforeCatalog += overflow
        }
      }
    }
```

5. In `project()`, the rebuilt evidence object carries the two new fields and releases keys for `[...evidence.deferredRaw, ...evidence.recentRaw]`, same shape as step 3.

6. In `rebuild()`, before the replay-cache check:

```ts
    if (catalog && evidence.deferredRaw.length > 0) {
      // First rebuild with a catalog: the deferred records precede the live
      // window in time, so they belong in the baseline, folded in arrival
      // order under the real worktree list. A new baseline object also
      // invalidates the replay cache below, which is what we want.
      evidence.baseline = this.foldRaw(cwd, evidence.baseline, evidence.deferredRaw)
      evidence.deferredRaw = []
      evidence.revision += 1
    }
```

7. In `summarize()`, add to the returned object:

```ts
      deferredEvidenceCount: evidence?.deferredRaw.length ?? 0,
      droppedBeforeCatalog: evidence?.droppedBeforeCatalog ?? 0,
```

where `evidence` is `this.evidenceBySession.get(params.sessionId)` (read it at the top of `summarize()` if it is not already).

- [ ] **Step 5: Run the tests and the type gate**

```bash
NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/work-context/
npm run typecheck
npm run check:worktree-live-fixtures
```
Expected: all tests in the directory pass (existing six plus two new); typecheck clean; the fixture check still passes (no fixture was changed).

If `npm run typecheck` reports a consumer of `WorktreeReconciliationDebug` that builds the object literally (the debug panel or a test), add the two fields there with `0`.

- [ ] **Step 6: Commit, push, open the PR**

```bash
git add src/renderer/src/workspace/work-context/LiveWorktreeReconciler.ts src/renderer/src/workspace/work-context/LiveWorktreeReconciler.test.ts
git commit -m "fix(worktrees): retain evidence evicted before the first Git catalog

Records evicted from the live window while Git IPC was still pending were
folded through foldRaw, which skips every non-worktree-state record without
a catalog. They were dropped silently, so a fast-starting session lost
attribution for everything before its newest 500 relevant records. Hold
those records in a second bounded list and fold them on the first rebuild
that has a catalog; count, do not hide, what the bound drops.

Fixes #822

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd"
git push -u origin fix/worktree-evidence-before-catalog
gh pr create --title "fix(worktrees): retain evidence evicted before the first Git catalog" --body-file - <<'EOF'
## Problem
`LiveWorktreeReconciler.observe` folds records evicted from the 500-record live window into the baseline through `foldRaw`, and `foldRaw` skips every non-`worktree-state` record while the cwd has no Git catalog. A session that buffers more than 500 relevant records before the first catalog reply loses attribution for all but the newest 500. Surfaced by the independent review of #808 and filed as #822; pre-existing on main.

## Change
- Records evicted before a catalog exists go to a second list, `deferredRaw`, bounded by the same `recentRawLimit`.
- The first `rebuild()` that has a catalog folds the deferred list into the baseline in arrival order.
- Hydration and history adoption release tracker keys for deferred records too, so they cannot double-count.
- `summarize()` reports `deferredEvidenceCount` and `droppedBeforeCatalog` so the debug panel can say when attribution is still incomplete.

## Tests
- Recorded Claude fixture, window of one, catalog pending: the first write is evicted, deferred, and present in the timeline after the catalog arrives (fails on main with one write).
- Window of one, catalog never arrives, three records: one live, one deferred, one counted as dropped.

## Verification
`npm run typecheck`, the work-context unit suite, `npm run check:worktree-live-fixtures`.

Fixes #822

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

CHECKPOINT: report the PR link; merge only on confirmation.

---

