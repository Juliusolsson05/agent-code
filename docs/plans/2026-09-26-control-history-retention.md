# Control history keeps a bounded window (#1274)

## Problem
`FileControlHistory` appends every control call (external control, MCP, application tasks) to `control-history/events.jsonl`, with each prompt and result as a `payloads/<sha256>.json` file. Nothing is ever removed, and `open()` loads the whole journal into an in-memory array that every `history.events()` call copies.

## Evidence (owner's store, 2026-09-27)
- 129 MB on disk after 22 days: `events.jsonl` has 6,089 rows over 1,894 calls; `payloads/` holds 3,499 files for 3,457 referenced digests (42 orphans from failed appends).
- 105 MB of the payloads are `transcripts.page` results, which are read-only and unkeyed. `mcp.tools/list` adds 7 MB, `mcp.tools/call` 2.8 MB, and `agents.read` 1.5 MB.
- Keyed calls, the executor's dedupe ledger (#1240), are small: 815 rows, 290 `received`. Their keys come from `dispatch.configure`, `commands.run`, `operations.start/finish`, `agents.prompt`, and others.
- Every call in the journal has a `result` row (0 in flight).
- Simulated retention for unkeyed finished calls: 7 days keeps 507 calls (1,910 rows) and 17 MB of payloads; 14 days keeps 881 calls and 48 MB; 30 days keeps everything.

## The boundary this must not break
The journal is the executor's idempotency ledger (see the #1240 class comment and `docs/plans/2026-09-25-control-history-recovery.md`). A keyed retry must find its `received` row and stored result forever, because request keys have no lifetime in the contract. Retention may therefore only remove calls that can never be looked up for dedupe.

## Decisions (defaults)
1. **Prune whole calls, never single rows.** A call is removed only when ALL of these hold:
   - no row of the call carries a `requestKey`, so it is not dedupe evidence;
   - it has a `result` row, so it is not in flight (`history.read` would otherwise show a call lost mid-way);
   - no kept row names it as `reusedCallId`;
   - its newest row is older than the retention window.
   Removing whole calls keeps the per-call key consistency that `analyze()` checks, so a pruned ledger reloads as clean.
2. **Window: 7 days (UNCONFIRMED default).** On the owner's rate this is about 20–35 MB steady state. `history.read` and `history.list` answer for the last week; an agent inspecting what it did is interested in hours, not weeks. The window is a constructor option so a product change is one line.
3. **Pruning runs on load, after recovery,** as one atomic rewrite of `events.jsonl` (temp file, fsync, rename, directory fsync, the same `writeAtomic` recovery uses), with sequences renumbered (process-local cursors, as in recovery). The app restarts often (updates, relaunch), and load is the one point where no append is in flight. A process that runs for weeks keeps growing until its next launch; that residual is stated.
4. **Payload GC after the rewrite.** Delete every `payloads/*.json` not referenced by a kept row, which also removes orphans left by failed appends. This runs only after the journal rewrite is durable, so a crash in between leaves extra files, never a row pointing at a missing payload. A digest shared by a pruned row and a kept row stays.
5. **`history.list` drops "never silently truncated".** It becomes a stated window: "keyed calls are kept; other finished calls are kept for 7 days".
6. **A damaged ledger is not pruned in the same launch.** When recovery ran, the rewritten ledger is still under an unaccepted block; pruning is skipped so the operator reconciles what they saw. The next clean launch prunes.

## Tests (fail-first, real rows)
A fixture of real journal rows, recorded from the owner's store: ids, timestamps, callers, capability ids and digests only (no prompts, per the #1240 plan). It covers old unkeyed calls, old keyed calls, a reuse pair, and recent calls. Payload files are written by the test under the recorded digests.
- An old unkeyed finished call is pruned, with its payloads, and orphan payloads are removed. Old keyed calls, the calls they reuse, and recent calls are kept, byte-identical apart from renumbered sequences.
- After pruning, a keyed retry of an old key still replays its stored result and never re-dispatches (executor round-trip).
- A call without a `result` row is kept however old it is.
- A payload shared by a pruned and a kept row survives.
- A load that ran recovery does not prune.
