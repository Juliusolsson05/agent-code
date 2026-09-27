# Debug retention collects key-log-only proxy run dirs (#1385)

## Problem
`collectProxyRunDirs` recognised a run dir only by `proxy-events.jsonl`. A run dir holding just `session-meta.json` + `sslkeylog.log` was walked into and never collected. #1380 review c recounted names and sizes only (contents never read): 23 such dirs on the owner's machine, 5.18 MB of plaintext TLS session secrets, May–September 2026.

## Fix (narrowed to FUTURE runs; B6's oldest-first list)
- A run dir is recognised by either evidence file: `proxy-events.jsonl` or `sslkeylog.log`. It matches the key log itself (review c).
- A dir with `proxy-events.jsonl` is collected as before.
- A key-log-only dir is collected only when its run started AFTER this machine's first retention pass with this code: `keyLogRetentionSince()` writes that moment once (exclusive create) to `STATE_DIR/debug-retention-keylog-since`, and later passes read it. Run dirs are named by their ISO start time, which sorts as text, and the marker uses the same shape. If the marker cannot be read or written, or has an unknown shape, NO key-log-only dir is collected (fail closed).
- **WHY not a date constant (#1388 review a):** the first version used tomorrow's date, so a run this build made today was excluded forever, and any earlier date would sweep key logs from before the upgrade.
- Every earlier key-log-only dir, including the owner's 23, is left untouched and never walked into. So is one whose name cannot be dated.
- `session-meta.json` alone stays uncollected, and `_shared-conf` is still skipped.

## Owner decision kept (q91)
- Deleting the EXISTING key logs is still the owner's decision. This PR no longer makes it: the first prune after merge does not touch any of the 23 dirs.
- New key-log-only runs fall under the normal TTL pass (48 h, `AGENT_CODE_DEBUG_TTL_HOURS`) and the proxy budget.

## Also (q115, "unknown is never empty")
`dirStats` no longer skips a child it cannot read. Only ENOENT means absent; any other error leaves the whole dir uncollected that pass. The manual-bundle ledger loader is NOT changed here, because W4's #1417 owns it (q118).

## Tests
`debugRetention.keylog.test.ts`, on the real directory shapes (`proxy/<project>/<session-key>/<ISO timestamp>/`):
- a NEW key-log-only dir is collected beside a normal run dir;
- an existing-dated one, an undated one, `_shared-conf` and a metadata-only dir are not;
- the unreadable-child test: fail once, recover, maintain, and the bytes survive.
- Mutations killed: removing the cutoff, and removing the name check.

## Review a (round 1)
- **Fixed:** the date constant replaced by the first-run marker (above).
- **Tests:** a same-day run after the marker is collected; one before it is not; a null cutoff collects no key-log-only dir; the marker is written once and kept, and fails closed on an unknown shape or an unreadable path.
- **Mutations killed:** no cutoff; null collecting everything; any marker shape accepted. Removing the up-front marker read ALONE survives, because the exclusive create then hits EEXIST and reads the stored marker. Removing both guards fails.
- **Not changed (finding 1):** a run dir with an events file AND a key log is collected whole, key log included. That is main's existing behaviour for event-bearing runs, which this PR does not touch. The owner decision (q91) is about the key-log-only dirs, which stay untouched.

