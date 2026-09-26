# Claude proxy request-body budget (#1273)

## Evidence
- 2026-09-25, owner machine: live `proxy-events.jsonl` files of 2.37 GB, 2.10 GB, 1.95 GB and 0.84 GB, all written that day; `~/.config/agent-code/proxy` 7.6 GB.
- In the last 300 MB of the 2.37 GB file, `body_b64` is 92.9 % of the bytes (35,016 events).
- `debugRetention.ts` skips files written in the last 10 minutes (ACTIVE_GRACE_MS), so a live session's file is never pruned.
- `body_b64` consumers: the adapter only as a fallback for addons without `request_shape` (every current addon emits it), plus the fixture extractor script (forensic).

## Change
- claude-code-headless#62: past a per-file size budget (256 MiB default, `PROXY_REQUEST_BODY_BUDGET_BYTES` to override), request bodies are omitted and marked `body_omitted: "file-budget"`. Everything else in the event stream is unchanged.
- agent-code: bump the submodule to #62's merge commit. The package version is unchanged, so the lockfile needs no resync.

## Test
The package test runs the Python addon against a sparse events file. It is red on main (2 of 3 fail) and green with the change.

## Not in scope
The remaining ~7 % (responses and stream chunks) still grows with the session and is pruned by retention after the session ends. The Codex equivalent is #372.
