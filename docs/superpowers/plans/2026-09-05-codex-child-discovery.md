# Bounded Codex child discovery

Status: implemented; local validation complete; PR/CI review pending. Issue #803. Depends on #809 (serialized refreshes),
base fix/subagent-refresh-coalescing at 689b110e. Retarget to main only after
that dependency merges; this PR must not reintroduce concurrent offset owners.

## Outcome

Missing child rollouts cause at most one directory traversal per five-second
retry window per tracker, shared by all its unresolved children. Unrelated
parent records do not schedule filesystem work. A file created after a miss
is found within five seconds plus the existing 1.2-second poll and scan time.

## Implementation

- Replace per-child recursive stat walks with one Dirent traversal for the set
  of unresolved child ids, skipping symlinks and checking stop during traversal.
- Keep only paths for tracked children; no archive-sized retained filename index.
  Bound misses with a five-second retry deadline; new ids may wait for that same
  window so spawning many children cannot bypass the bound.
- Preserve parent correlation/completion emissions. Continue byte-offset reads
  of found children on the existing timer independently of discovery cooldown.
- Invalidate missing cached paths without letting one vanished child block the
  rest. Changing the sessions root resets path/offset state and discovery age.

## Validation

Port the synthetic 1,000-file fixture into behavioral tests: many unrelated
parent entries and several missing children share one scan with zero per-file
stats; new files after a miss are eventually found; known children still tail;
symlink loops and deletion do not break progress. Re-run #802 regressions and
focused subagent tests, typecheck and test contract. Record operation counts,
not inferred production speedups. Review the diff, synchronize #803/#809, open a
complete Conventional dependent PR and complete CI/review. Do not merge.

## Evidence and scope decision

39 focused subagent tests pass. The 1,000-file/three-missing-child fixture uses
11 directory reads and zero file stats for discovery; 1,000 unrelated parent
records and three sequential retries add no scans in the same window. Late
creation, positive-path tailing, deletion/replacement, symlink cycles and root
changes are covered. The budget is per tracker, not a global all-parent cache:
this avoids retaining an archive-sized shared index and keeps lifetime ownership
with the tracker. Cross-parent scan sharing can be measured separately.

Typecheck, testing contract and diff checks pass.
