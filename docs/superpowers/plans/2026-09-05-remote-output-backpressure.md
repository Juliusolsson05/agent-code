# Bounded remote output and reconnect recovery

Status: implemented and locally verified. Issue #804. Base origin/main at 5d641845.

## Outcome

A slow paired client cannot queue unbounded output in main. Overflow ends that
connection and the phone rebuilds its live history window from durable history
on reconnect, preserving uncertainty for interrupted prompt requests. Healthy
clients continue receiving ordered output. No changes to external control #795,
A5's renderer/worktree paths, or any running app configuration.

## Implementation

1. Give broadcast, direct replies and bootstrap one per-socket byte budget.
   Terminate an overflowing socket immediately instead of queuing a close frame
   behind its backlog. Prefer this complete-prefix/reset contract to a second
   custom snapshot queue with independent ordering/retention semantics.
2. Return bounded errors for individually oversized replies; history requests
   may reduce page size, but an individual oversized record must remain an
   explicit error rather than silent truncation or an infinite retry loop.
3. Make disconnect reject in-flight requests without replaying mutations.
   Reject late old-socket events and stale async history completions.
4. Reset transcript windows at disconnect. On the next authoritative session
   list, backfill viewed sessions even if history loaded before disconnect.
   Ignore partial semantic deltas until a fresh turn begins; committed records
   remain authoritative for the interrupted turn. Keep older pages available.
5. Test real paused/draining socket consumers, budget enforcement on replies,
   reconnect with more than one missed page, stale responses, and prompt retry
   uncertainty. Preserve existing remote integration and rendering contracts.

## Validation and following work

Run focused remote transport/store/system tests, typecheck, contract and client
build; full applicable repository gates run in CI. Compare bounded queued bytes
with the audit's synthetic 31.5 MiB backlog, not production memory/CPU claims.
Review, synchronize #804, open a complete PR, and address checks/review. Do not
merge. #805 will depend on this PR because it changes the same store lifecycle
and must preserve this reconnect/backfill contract while bounding retention.

## Evidence and decisions

All remote transport/store tests pass: 105 tests in 12 files, including an
actual paused receiver bounded to 4 MiB while a healthy receiver receives every
frame, reconnect/backfill across 310 durable entries, and an interrupted prompt
sent exactly once. A healthy bootstrap totaling more than 4 MiB is paced by
write completion; cached values are read immediately before each write.
Typecheck, test contract, client production build and diff check pass. Existing
client bundle size/mixed import warnings remain. The audit previously measured
31.5 MiB queued for a synthetic paused receiver; these are reproducible bounds,
not a measurement of production memory savings.

History pages retain a contiguous newest suffix up to 3 MiB with matching byte
offsets and an older-history cursor. Individual records above that budget fail
explicitly. Reconnect discards the disconnected history window and hides a
partial semantic turn until a fresh turn boundary or durable completion. This
trades temporary streaming continuity for correct history after dropped output.
