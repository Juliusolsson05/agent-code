# A run the monitor store never examined is not empty (#1453)

## Evidence
- Found while verifying #1411 (q115), with a probe: store B indexes the monitor folder at startup. A second store under another run id then creates `runs/run-a` and writes `incidents.json` + `operations.json`. B's next `maintain()` deletes `run-a` (ENOENT afterwards).
- Cause, `MonitorHistoryStore.maintain()`: the expired-run pass deletes every run folder not in `index` / `incidentRuns` / `unindexedRuns`. Those maps are filled only by startup indexing, so a run that appeared later is "not known", which the pass reads as "empty".
- Two app processes can share one data folder: `--packaging-smoke` skips the single-instance lock.
- It is the same "never seen means empty" shape the worker rule forbids (q109, q115).

## Change
- `examinedRuns`: the runs startup indexing actually looked at.
- Retention deletes a run as empty only if it was examined. An unexamined run is unknown and waits for the next start to index it.
- `clear()` resets the set with the rest.

## Not changed (residual)
- The capacity budget (`pruneRuns`) may still remove an unexamined run, as it already may for `unindexedRuns`. That is the documented policy: the 128 MiB ceiling wins over unknown runs. It orders an unexamined run as oldest, since it has no indexed points.
- ~~Two live stores can still examine each other's run while it is empty at startup.~~ Closed by review b's `touchedSince` (see below).

## Test (real files)
`MonitorHistoryStore.test.ts`: run-a appears after store B indexed.
- It survives two of B's maintenance passes. This is red before the fix (ENOENT on the first pass).
- A restarted store examines it and keeps its in-retention incident.
- Past retention, its incident file is deleted, and its (then empty, aged) folder on a later pass, so the protection is not permanent.

## Review a (round 1), fixed
- **An unreadable or untrusted incident file:** at indexing, an `incidents.json` that exists but cannot be read, parsed or trusted now makes the run UNKNOWN (`unindexedRuns`). It used to read as `[]`, so an examined run was deleted.
- **`examinedRuns` is forgotten when the run is deleted** (retention or capacity), so a name another store recreates with fresh data is unexamined again and kept.
- **Tests:** real files. An incident file at mode 000 during indexing survives maintenance once readable; a run recreated after its retention deletion survives. Both were red before. (Their mutation gates were shadowed by review b's `touchedSince` until review c's real-clock rewrite; see below.)

## Review b (round 1), fixed
- **A tier `stat` failure other than ENOENT** now marks the run unknown instead of skipping the tier as absent.
- **A tier file with unparseable lines** marks the run unknown. It was indexed with no points, deleted as fully expired, and then its run was deleted.
- **Retention keeps any run with a file touched within the retention window** (`touchedSince`; any list or stat failure counts as touched). A run examined while empty can be filled later by the other store, which is residual 2 above, now closed. One side effect: once an expired run's last file is removed, its fresh folder mtime keeps the empty folder for one more window.
- **Tests:** real files, one per finding (ELOOP tier link, unparseable tier line, filled after examination). Each was red before. Mutations: "unparsed ignored" and "no touched check" fail on their own; the stat and touched guards back each other up on the ELOOP case (removing both fails).

## Review a round 2: residual (manager decision)
A second store's write can land between retention's final `touchedSince()` check and its recursive `rm()`: a check-then-act race between two uncoordinated processes. It needs two app processes sharing one data folder (possible only under `--packaging-smoke`, which skips the single-instance lock) and a write inside that sub-millisecond window. Closing it needs a cross-process lock on the monitor folder. A rename-to-tombstone-then-recheck scheme narrows it but brings restore-collision cases of its own. That is left out under the PR freeze; B6 decides whether to accept this residual or require the lock.

## Review c (round 1), fixed (tests and docs)
- **The problem:** every new test used a 1970-scale fake clock, so `touchedSince` saw every fixture as freshly touched and shadowed the other guards. Removing the `examinedRuns` guard itself (#1453's fix), the unknown-incidents guard, or the forget-on-delete survived the suite.
- **The fix:** the tests run on the real clock, and each fixture's files and folder are aged past retention with `utimes`, so only the guard a test names can keep the run. A cleanup-direction assertion is added: an examined run whose data expired loses its folder on a later pass.
- **Mutations, each killed on its own:** the `examinedRuns` guard dropped (2 red); `examinedRuns` never populated (2 red); examined kept after delete; unknown incidents unprotected; unparsed lines ignored; no touched check (2 red). Only the ELOOP case has two guards (indexing and `touchedSince`), as noted in its test.
- **Docs:** residual 2 is closed; "deleted as before" is corrected (the incident file goes first, the emptied folder on a later pass).


## Review b round 2, fixed
- **The problem:** the index is only a snapshot of another live store's run. Expiring or compacting a foreign tier file, or rewriting its incidents, from that snapshot deleted what the other store wrote afterwards, including content appended after indexing.
- **The fix:** each foreign tier and incident file's size and mtime are recorded at indexing (`foreignFiles`). Every expiry, compaction and incident rewrite of a foreign file first checks the file is unchanged. A changed or vanished file makes the run unknown (`unindexedRuns`) instead. After the store's own rewrite of a foreign file, the new fingerprint is recorded. The store's own run needs no check, since only it writes there.
- **Tests (two live stores on one folder, real files and clock):**
  - a foreign tier expired from a stale index;
  - content appended to a foreign tier after indexing (compaction);
  - a fresh incident added after indexing (incident rewrite).
  With the check disabled, the first two fail; removing only the incident-loop check fails the third.
- **Residual unchanged:** the sub-millisecond window between the check and the act (the review a round 2 cross-process residual).
