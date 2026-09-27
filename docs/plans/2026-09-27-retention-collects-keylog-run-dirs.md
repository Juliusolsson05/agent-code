# Debug retention collects key-log-only proxy run dirs (#1385)

## Problem
`collectProxyRunDirs` recognised a run dir only by `proxy-events.jsonl`. A run dir holding just `session-meta.json` + `sslkeylog.log` was walked into and never collected. #1380 review c recounted names and sizes only (contents never read): 23 such dirs on the owner's machine, 5.18 MB of plaintext TLS session secrets, May–September 2026.

## Fix (narrowed to FUTURE runs; B6's oldest-first list)
- A run dir is recognised by either evidence file: `proxy-events.jsonl` or `sslkeylog.log`. It matches the key log itself (review c).
- A dir with `proxy-events.jsonl` is collected as before.
- A key-log-only dir is collected only when it is NOT in the BASELINE: the set of key-log-only dirs that existed when a build containing this code first started (`keyLogBaseline()`, captured at run start in `holdDebugStoragePruneUntilRecovered`, written once with an exclusive create to `STATE_DIR/debug-retention-keylog-baseline.json`). Capture is strict: any directory it cannot list means no baseline, nothing is written, and a later start retries. With no baseline, NO key-log-only dir is collected.
- **WHY a captured set (#1388 review a, two rounds):**
  - a date constant excluded runs made on the merge day forever;
  - a first-prune marker was written minutes after start (the boot gate delays the first prune), so runs made in between were excluded forever;
  - any timestamp comparison admits a pre-upgrade run whose name sorts later after a clock step back.
  Membership in "what already existed" needs no clock.
- Every key-log-only dir in the baseline, including the owner's 23, is left untouched and never walked into, whatever its name. Names play no part: a NEW key-log-only dir is collected even if its name is not a timestamp. The decision on the existing ones is tracked in #1460 (q91).
- `session-meta.json` alone stays uncollected, and `_shared-conf` is still skipped.

## Owner decision kept (q91)
- Deleting the EXISTING key logs is still the owner's decision. This PR no longer makes it: the first prune after merge does not touch any of the 23 dirs.
- New key-log-only runs fall under the normal TTL pass (48 h, `AGENT_CODE_DEBUG_TTL_HOURS`) and the proxy budget.

## Also (q115, "unknown is never empty")
`dirStats` no longer skips a child it cannot read. Only ENOENT means absent; any other error leaves the whole dir uncollected that pass. The manual-bundle ledger loader is NOT changed here, because W4's #1417 owns it (q118).

## Tests
`debugRetention.keylog.test.ts`, on the real directory shapes (`proxy/<project>/<session-key>/<ISO timestamp>/`):
- a NEW key-log-only dir is collected beside a normal run dir;
- baseline members (including one whose name sorts after a new run), `_shared-conf` and a metadata-only dir are not;
- the unreadable-child test: fail once, recover, maintain, and the bytes survive.
- Mutations killed: removing the cutoff, and removing the name check.

## Review a (round 1)
- **Fixed:** the date constant replaced by the first-run marker (above).
- **Tests:** a same-day run after the marker is collected; one before it is not; a null cutoff collects no key-log-only dir; the marker is written once and kept, and fails closed on an unknown shape or an unreadable path.
- **Mutations killed:** no cutoff; null collecting everything; any marker shape accepted. Removing the up-front marker read ALONE survives, because the exclusive create then hits EEXIST and reads the stored marker. Removing both guards fails.
- **Not changed (finding 1):** a run dir with an events file AND a key log is collected whole, key log included. That is main's existing behaviour for event-bearing runs, which this PR does not touch. The owner decision (q91) is about the key-log-only dirs, which stay untouched.

## Review a round 2 + b (fixed at the next head)
- The marker is replaced by the baseline set, captured at run start.
- **Tests:** a baseline dir named after a new run (a clock step back) stays excluded; a run made after capture is collected; capture over an unreadable subtree yields no baseline and writes nothing; a baseline that cannot be written is not established (review b); the file is reused and a malformed one fails closed.
- **Mutations killed:** membership ignored; null collecting everything; lenient capture; capture recording nothing; returning an unsaved baseline.
- **Residuals:**
  - The early-capture wiring in `holdDebugStoragePruneUntilRecovered` is not separately pinned; the boot-gate suite exercises it against a scratch state dir.
  - `dirStats`' EIO/ELOOP branches (review b) are not reproducible on a real filesystem: symlink entries are skipped, and EIO cannot be produced on demand. EACCES is pinned.


## Review a round 3 (last pass)
- **Fixed, unsafe direction:** a proxy root missing at capture saved an empty baseline, so old key logs that reappeared became collectable. Capture now has no ENOENT exception, even for the root: no baseline, nothing written, retried at a later start.
- **Not fixed, conservative direction (decided with review b round 3):** a run created WHILE the startup scan runs is baselined and kept forever. A birthtime filter was tried and REVERTED: after a clock step back, a pre-existing dir's birthtime can look later than the capture start, which would exclude an old key log from the baseline (the unsafe direction). Capture starts at run start, before any session exists, so the window is the few milliseconds of the scan.
- **Residual, conservative direction:** after a failed capture (for example an unwritable state dir), runs made before a later successful capture are baselined and never collected. That is a retention gap, never a deletion. The same holds on a fresh install that has no proxy folder yet: the first capture happens at the start after the folder appears.
- **Mutation killed:** the root ENOENT exception.
