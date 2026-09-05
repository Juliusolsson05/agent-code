# Worktree reconciliation performance

Status: implementation in progress. Issue: #806. Base: origin/main 5d641845.

## Scope and invariants

Preserve canonical projection identity on no-op and avoid replaying retained
evidence when its inputs are unchanged. Do not alter lifecycle/readiness,
provider evidence precedence, or stale-hydration contribution reversal.
Keep catalog-ready notification even for unchanged catalogs: initial history
can replace a projection between refreshes, and that external replacement must
still trigger correction. Cache content identity, not freshness timestamps.

## Implementation sequence

1. Add reference/no-replay regression tests and a sanitized-fixture benchmark;
   run against the unchanged implementation to record failures/baseline.
2. Make canonicalization reference-stable and cache replay by cwd, baseline,
   retained-evidence generation and catalog content identity. Keep the existing
   bounded replay algorithm for invalidations rather than change attribution.
3. Cover irrelevant/empty batches, identical successful refresh, changed
   catalogs, hydration replacement, evidence eviction and session teardown.
4. Run focused tests, typing/lint checks and before/after benchmark. Review the
   diff, update issue evidence, open a complete PR and obtain current CI.
   Do not merge without explicit user confirmation.

## Later independent increments

- #763: per-session React subscriptions and stable action/context boundaries.
- #762: renderer screen interest with fresh view-switch snapshots; backend
  parsing and lifecycle/readiness remain ungated.
- #767: only remaining verified diagnostic costs. Disabled memory sampling
  already exits early. Main worktree-index no-op persistence is functional
  metadata, not something to disable as a diagnostic.
- A6 owns the separate #802–805 subagent/remote findings; do not overlap.

## Verification evidence

Prior isolated audit: 1000/1000 value-identical canonical projections changed
identity; retained 500-record replay cost about 2 ms per unrelated batch. These
are not app-wide typing latency claims. Record reproducible measurements below
before proposing completion.
