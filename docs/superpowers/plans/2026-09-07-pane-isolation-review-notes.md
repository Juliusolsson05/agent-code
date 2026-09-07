### Task 2: Land Review B's three cosmetic notes from the #810 review

**Files:**
- Modify: `src/renderer/src/features/reply-to-selection/lib/selectionStash.ts:42`
- Modify: `src/renderer/src/workspace/hook/helpers.ts:19-25` (the `EMPTY_RUNTIME` comment)
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx:163-174` (the related-agent status dot)
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx:61,77`
- Create: `docs/superpowers/plans/2026-09-07-pane-isolation-review-notes.md` (this section)

**Interfaces:**
- Produces: a `data-related-status` attribute on the related-agent chip's status dot with values `'error' | 'attention' | 'running' | 'idle'`.

Review B's notes, verbatim from the closed session: (1) "`selectionStash.ts:42` still names `setDraftVersion` in a WHY comment; the function is now `bumpDraftChanges`." (2) "The last sentence of the new `EMPTY_RUNTIME` comment in `helpers.ts` reads awkwardly." (3) "The new PaneHeader test detects the running state through a `.bg-accent` class query, which couples it to styling."

- [ ] **Step 1: Create the worktree and commit the plan**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code
git worktree add .worktrees/pane-isolation-review-notes -b chore/pane-isolation-review-notes origin/main
cd .worktrees/pane-isolation-review-notes
git submodule update --init && ln -s ../../node_modules node_modules
# copy this Task 2 section into docs/superpowers/plans/2026-09-07-pane-isolation-review-notes.md
git add docs/superpowers/plans/2026-09-07-pane-isolation-review-notes.md
git commit -m "docs(renderer): plan the pane isolation review follow-ups

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd"
```

- [ ] **Step 2: Fix the stale function name**

In `src/renderer/src/features/reply-to-selection/lib/selectionStash.ts`, the comment currently reads:

```
//   quote" from last week would be a bug, not a feature). Runtime writes
//   also bump setDraftVersion, which would dirty the autosave path on
//   every mouse drag. codeBlockRegistry.ts sets the precedent for
```

Change the middle line to:

```
//   also call bumpDraftChanges, which would dirty the autosave path on
```

Confirm the name is current: `git grep -n "bumpDraftChanges" -- src/renderer/src/workspace/hook/actions/draft.ts` must list the declaration at line 39.

- [ ] **Step 3: Rewrite the awkward invariant sentence**

In `src/renderer/src/workspace/hook/helpers.ts`, replace the whole `EMPTY_RUNTIME` comment block (the lines from `// Missing sessions need a stable read-only fallback` through the line before `const EMPTY_RUNTIME = emptyRuntime()`) with:

```ts
// Missing sessions need a stable read-only fallback so merely asking for their
// state cannot invalidate a memo boundary. Reducers still allocate their own.
//
// INVARIANT: this object is SHARED by every session that has no stored runtime
// yet and must never be mutated in place. Update paths always build fresh
// reducer-owned runtimes (spread + patch), so a `getRuntime()` result is only
// ever read. An in-place edit here would leak into every runtime-less session
// at once, because they all read this one object; the corruption would surface
// only after one of them was created, which is the worst moment to debug it.
```

- [ ] **Step 4: Give the status dot a semantic hook and use it in the test**

In `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx`, the dot inside the related-agent chip is:

```tsx
                <span
                  className={[
                    'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                    attention === 'ERROR'
                      ? 'bg-danger'
                      : attention
                        ? 'bg-warning'
                        : running
                          ? 'bg-accent'
                          : 'bg-muted',
                  ].join(' ')}
                />
```

Add one attribute, computed from the same branches so the test and the color can never disagree:

```tsx
                <span
                  // WHY a data attribute and not a role or aria-label: the dot
                  // is decorative (the chip's `title` already carries the
                  // relation and name for assistive tech), but tests need a
                  // hook that does not depend on Tailwind class names. The
                  // header row already uses `data-pane-header-row` for the
                  // same reason, so this follows that precedent.
                  data-related-status={
                    attention === 'ERROR' ? 'error' : attention ? 'attention' : running ? 'running' : 'idle'
                  }
                  className={[
                    'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                    attention === 'ERROR'
                      ? 'bg-danger'
                      : attention
                        ? 'bg-warning'
                        : running
                          ? 'bg-accent'
                          : 'bg-muted',
                  ].join(' ')}
                />
```

In `PaneHeader.phoneCoupling.renderer.test.tsx`, replace both occurrences of

```ts
    expect(chip!.querySelector('.bg-accent')).not.toBeNull()
```

with

```ts
    expect(chip!.querySelector('[data-related-status="running"]')).not.toBeNull()
```

- [ ] **Step 5: Run the affected tests and the type gate**

```bash
source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24
NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx
npm run typecheck
```
Expected: 1 file / 3 tests passed; typecheck exit 0.

- [ ] **Step 6: Commit, push, open the PR**

```bash
git add src/renderer/src/features/reply-to-selection/lib/selectionStash.ts src/renderer/src/workspace/hook/helpers.ts src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.phoneCoupling.renderer.test.tsx
git commit -m "chore(renderer): tidy the comments and test hook noted in the pane isolation review

The #810 review left three non-blocking notes: a comment naming a renamed
function, an invariant sentence that read badly, and a regression test that
detected the running state through a Tailwind class. The test now reads a
data attribute computed from the same branches as the color, so styling
changes cannot break it and the attribute cannot drift from the color.

Refs #763

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd"
git push -u origin chore/pane-isolation-review-notes
gh pr create --title "chore(renderer): tidy the comments and test hook noted in the pane isolation review" --body-file - <<'EOF'
## Problem
Review B of #810 left three non-blocking notes that were never actioned: a WHY comment in `selectionStash.ts` still named `setDraftVersion` (renamed to `bumpDraftChanges` in #810), the new `EMPTY_RUNTIME` invariant comment ended in a sentence that read badly, and the new `PaneHeader.phoneCoupling` test detected the running state through a `.bg-accent` class query.

## Change
- Comment names the current function.
- Invariant comment rewritten; same invariant, plain sentences.
- The related-agent status dot gets `data-related-status="error|attention|running|idle"` computed from the same branches as its color; the test queries that attribute.

## Verification
- `PaneHeader.phoneCoupling.renderer.test.tsx`: 3 tests pass on Node 24.
- `npm run typecheck` clean.

Refs #763

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013SULm3ApxebET2a8eLxKHd
EOF
```

CHECKPOINT: report the PR link; merge only on confirmation.

---

