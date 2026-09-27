# Debug retention collects key-log-only proxy run dirs (#1385)

## Problem
`collectProxyRunDirs` recognised a run dir only by `proxy-events.jsonl`. A run dir holding just `session-meta.json` + `sslkeylog.log` was walked into and never collected. #1380 review c recounted names and sizes only (contents never read): 23 such dirs on the owner's machine, 5.18 MB of plaintext TLS session secrets, May–September 2026.

## Fix (narrowed to FUTURE runs; B6's oldest-first list)
- A run dir is recognised by either evidence file: `proxy-events.jsonl` or `sslkeylog.log`. It matches the key log itself (review c).
- A dir with `proxy-events.jsonl` is collected as before.
- A key-log-only dir is collected only when its run started at or after `KEY_LOG_ONLY_SINCE` (`2026-09-28T00-00-00-000Z`). Run dirs are named by their ISO start time, which sorts as text.
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
