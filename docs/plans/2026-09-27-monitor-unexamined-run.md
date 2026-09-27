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
- Two live stores can still examine each other's run while it is empty at startup. That needs a live-run marker, which is a different design and not what #1453 reports.

## Test (real files)
`MonitorHistoryStore.test.ts`: run-a appears after store B indexed.
- It survives two of B's maintenance passes. This is red before the fix (ENOENT on the first pass).
- A restarted store examines it and keeps its in-retention incident.
- Past retention, it is deleted as before, so the protection is not permanent.

## Review a (round 1), fixed
- **An unreadable or untrusted incident file:** at indexing, an `incidents.json` that exists but cannot be read, parsed or trusted now makes the run UNKNOWN (`unindexedRuns`). It used to read as `[]`, so an examined run was deleted.
- **`examinedRuns` is forgotten when the run is deleted** (retention or capacity), so a name another store recreates with fresh data is unexamined again and kept.
- **Tests:** real files. An incident file at mode 000 during indexing survives maintenance once readable; a run recreated after its retention deletion survives. Both were red before, and both mutations fail.
