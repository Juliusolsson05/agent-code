# Remote transcript retention

Status: planned. Issue #805. Depends on #813 (fix/remote-output-backpressure,
61823921); separate PR against that branch. Main remains 5d641845. No edits to
A5 desktop rendering/worktree paths or the external operator toolkit.

## Intended behavior and implementation

1. Treat actual view subscriptions as transcript ownership. Unviewed sessions
   retain lightweight status/file identity only; do not map or fold their JSONL
   and semantic bodies. Release entries, indexes, UUID bookkeeping, mapper and
   semantic state on last unsubscribe. Invalidate pending history responses and
   backfill again when selected. Partial semantic turns wait for a fresh start.
2. Reuse the desktop pure live trim planner and marker helpers without editing
   desktop code or using its global registries. Apply count/estimated-byte
   targets to active live appends; preserve current/history semantic ownership,
   cross-entry tool pairs, stable UUIDs and pagination anchors. Suspend trimming
   while paging and briefly after older history is loaded.
3. Rebuild tool indexes from the retained window. Track trimmed UUID tombstones
   per view so old live replays cannot reappear at the tail, but explicit older
   pages can reload them. These small identity sets last for the viewed window;
   all are released on unsubscribe. Correct replay dedupe takes precedence over
   bounding UUID count during one continuously viewed session.
4. Carry byte offsets from history chunks into pagination and trim cursors.
   Live records lacking offsets use provider markers. Preserve raw-record groups
   at a trim boundary so multi-entry mapper output remains reloadable in order.
5. Add regressions for multi-session zero-view retention, detach/reselect and
   pending responses, sustained count/byte trimming, replay dedupe, older-page
   ordering/exact offsets, tool pair and semantic owner preservation. Adapt
   transport tests to explicitly own a view where they assert live rendering.

## Checks, evidence and limitations

Run remote suites, relevant shared trim tests, typecheck, test contract, client
production build and diff check; full repository checks in CI. Compare retained
logical payload/cardinality against the audit's synthetic 4096 entries/32 MiB,
not production heap/latency claims. Safety constraints may pin an active window
above its target; never drop active ownership merely to hit a number. Explicit
older-history reading may exceed the live target during its grace period.
Synchronize issue/PR acceptance criteria and document these constraints. Review
checks/feedback, leave clean committed worktrees; do not merge.
