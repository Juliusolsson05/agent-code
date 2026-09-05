# Subagent refresh coalescing

Status: implementing. Issue #802. Base: origin/main at 5d641845.

## Outcome and boundaries

Each child transcript byte range is folded once despite parent-record bursts,
timers, and manual refreshes. A trigger during I/O schedules a trailing pass;
late appends and parent completion are preserved. Stopping a tracker prevents
in-flight I/O from repopulating state or emitting. No provider process, renderer,
worktree reconciliation, or external control changes belong in this PR.

## Implementation

1. Add a small tracker-local serialized refresh owner, coalescing pending
   requests into one trailing pass and containing background I/O failures.
2. Route Claude and Codex refresh triggers through it. Check stopped state
   after awaited reads before committing offsets, metadata, or accumulators.
3. Keep transcript UTF-8/partial-line and parent completion semantics intact.
4. Port the audit burst reproduction into deterministic deferred-read tests for
   both trackers, including appended bytes, completion during I/O, transient
   errors, and stop during I/O. Keep fixtures synthetic and private-data-free.

## Validation and review

Run focused subagent tests, testing contract and typecheck. Inspect before/after
behavior with the same synthetic burst (one child record, 50 parent triggers);
report duplicate fold and read counts, not production CPU/FPS claims. Review the
final diff, open a complete Conventional PR with Fixes #802, synchronize the
issue, and address applicable CI/review feedback. Never merge without explicit
user confirmation.

## Following work

Issue #803 will use a separate branch/PR based on this branch because both touch
Codex refresh ownership. Remote #804 starts independently from main; remote #805
will explicitly depend on that resynchronization contract. Complete all four.
