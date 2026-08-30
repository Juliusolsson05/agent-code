# Worktree Panel Refresh Guards

> Fixes #150

## Outcome

Pin the two renderer contracts that stop the Worktrees panel from melting the app,
so the guards that fixed #150 cannot be silently removed by a future refactor.

#150 ("runaway loop/crash when opening worktree panel") is **already fixed in
shipped code**. This branch does not change that behaviour. It adds the regression
coverage that the fix never got, and corrects one stale WHY comment discovered
while writing it.

## Why this is a test-only change

The defect was fixed on 2026-06-24 by `ccc95b01`, merged as PR #355 ("Reduce
orchestration worktree freeze pressure"). That PR never wrote `Fixes #150`, so the
issue stayed open for 67 days while the code underneath it was already correct.

Verified against `origin/main` at `4245d453`, all four of #150's acceptance
criteria hold:

| #150 acceptance criterion | Where it is satisfied today |
|---|---|
| Opening the panel does not freeze or crash | `WorktreesBar.tsx` — `refresh` is keyed on `[cwd]`; `workspace` and `dump` are read through refs |
| Worktree data loading is bounded | `ipc/git.ts` — `GIT_PROCESS_CONCURRENCY = 8`, `WORKTREE_STATUS_CONCURRENCY = 6`, `timeout: 5000`, 30s promise cache |
| Repeated open/close creates no overlapping refreshes | `WorktreesBar.tsx` — `refreshInFlightRef` coalescing |
| Large worktree sets remain responsive | `ipc/git.ts` process-wide limiter; `WorktreeActivityIndex` LRU at 1000 |

So the product work is done. The *risk* is that nothing holds it in place.

## The problem this branch actually solves

The fix is one lint-fix away from being reverted, and nothing would catch it.

`WorktreesBar`'s mount effect carries:

```ts
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [refresh])
```

`refresh` deliberately does **not** depend on `workspace`, and the effect
deliberately does **not** depend on `dump`. Both are read through refs. That is
the whole fix for #150:

- `workspace` is a context value whose reference changes on **every agent runtime
  tick**. In the dependency array it rebuilds `refresh` on every tick, which
  re-runs the mount effect, which clears and restarts the 10s poll — so the
  interval is perpetually reset and the panel re-scans git in a tight loop.
- `dump` changes on every completed load. In the dependency array, each finished
  load restarts its own poll timer: the same loop, self-sustaining.

An "exhaustive-deps cleanup" that removes that disable comment and satisfies the
lint rule reinstates #150 exactly. Today the suite is silent about it: the only
test in the feature is `loadWorktreeDump.test.ts`, whose single case covers
worktree *attribution* (added by the #658 work), not refresh behaviour.

## What gets added

One renderer test file, `WorktreesBar.renderer.test.tsx`, pinning two contracts.
It mocks at the `loadWorktreeDump` seam, because the contract under test is *how
often the panel calls the loader*, not what the loader returns.

### Contract 1 — runtime churn must not restart the poll

Mount, advance fake timers to 9s, re-render repeatedly with a **new `workspace`
object reference** each time (this is exactly what an agent runtime tick does),
then advance to 10s.

- Correct behaviour: the poll fires once at 10s. Two loads total.
- With `workspace` in the deps: every re-render restarts the interval, so the
  10s boundary is never reached and the second load never happens.

The assertion is on the poll *firing on its original schedule despite churn* —
which is the property that actually broke, and it fails loudly if the ref is
removed.

### Contract 2 — overlapping refreshes coalesce

Hold the first load unresolved, click `refresh` while it is in flight, and assert
the loader was not called a second time. Then resolve and click again to prove the
guard releases rather than latching (a coalescer that never clears is its own
bug — the panel would stop refreshing for the rest of the session).

## The stale comment, corrected in passing

`MOUNT_REUSE_WINDOW_MS` claims:

> opening the panel re-mounts this component, and an unconditional `refresh(false)`
> re-runs the git worktree scan every time the panel is toggled […] If we already
> have a dump for this exact cwd from the last few seconds, reuse it on mount

That is not what the guard does. `WorktreesBarSurface` returns `null` when the
panel is closed, so closing it **unmounts** `WorktreesBar` and discards `dump`
(ordinary `useState`). On the next open, `dumpRef.current` is `null`, `fresh` is
`false`, and the refresh runs anyway.

The guard is not broken — it still applies when `refresh` identity changes without
an unmount (a `cwd` change) — and toggling is genuinely cheap, but for a different
reason than the comment gives: the 30s promise cache in `ipc/git.ts` absorbs the
repeated scan in main.

This is corrected as a comment-only change. Per the repo's rendering discipline, a
stale comment about *why* a guard exists is how the next person removes the wrong
one. No behaviour changes, and the reuse window is deliberately left in place —
deleting it would be an unrelated behavioural change on a test-only branch.

## Deliberately out of scope

- Any change to the guards themselves. They are correct; this branch protects them.
- The process-wide git limiter in `ipc/git.ts`. Testing it means asserting on
  subprocess scheduling, which needs a real process boundary — a `*.system.test.ts`
  concern, and the limiter has not regressed or been touched since it landed.
- Issues #658 and #685. Both are live worktree defects with active work; neither is
  affected by this branch.

## Verification

- `npm run test:renderer` — the new file, plus no regression in the renderer project.
- `npm run typecheck` — raw `tsc` on both projects, per the repo's verification rule.
- `npm run test:contract` — naming/command contract for the new `*.renderer.test.tsx`.
- Both contracts confirmed to **fail** when their guard is reverted locally, so the
  test is proven to detect the regression rather than merely passing.
