# Debug retention collects key-log-only proxy run dirs (#1385)

## Problem
`collectProxyRunDirs` recognised a run dir only by `proxy-events.jsonl`. A run dir holding just `session-meta.json` + `sslkeylog.log` was walked into and never collected. #1380 review c recounted names and sizes only (contents never read): 23 such dirs on the owner's machine, 5.18 MB of plaintext TLS session secrets, May–September 2026.

## Fix
A run dir is recognised by either evidence file: `proxy-events.jsonl` or `sslkeylog.log`. Match the key log itself (review c). `session-meta.json` alone stays uncollected, and `_shared-conf` is still skipped.

## CONSEQUENCE, needs the owner's decision BEFORE merge (q91)
Once collectable, these dirs fall under the normal TTL pass (48 h, `AGENT_CODE_DEBUG_TTL_HOURS`). All 23 are months old, so **the first prune after this merges deletes them**. This fix therefore IS the one-time sweep q91 asked the owner about. It permanently removes potential forensic material. If the owner says keep them, this PR must not merge as-is; the alternative is to budget them without TTL-expiring them. That is a different design, not needed if the answer is yes.

## Tests
`debugRetention.keylog.test.ts`, on the real directory shapes (`proxy/<project>/<session-key>/<ISO timestamp>/`): a key-log-only dir is collected as a `proxy` dir artifact beside a normal run dir; `_shared-conf` and a metadata-only dir are not. It is red before the fix.
