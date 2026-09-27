# Control history keeps a bounded window (#1274)

## Problem
`FileControlHistory` appends every control call (external control, MCP, application tasks) to `control-history/events.jsonl`, with each prompt and result as a `payloads/<sha256>.json` file. Nothing is ever removed, and `open()` loads the whole journal into an in-memory array that every `history.events()` call copies.

## Evidence (owner's store, 2026-09-27)
- 129 MB on disk after 22 days: `events.jsonl` has 6,089 rows over 1,894 calls; `payloads/` holds 3,499 files for 3,457 referenced digests (42 orphans from failed appends).
- 105 MB of the payloads are `transcripts.page` results, which are read-only and unkeyed. `mcp.tools/list` adds 7 MB, `mcp.tools/call` 2.8 MB, and `agents.read` 1.5 MB.
- Keyed calls, the executor's dedupe ledger (#1240), are small: 815 rows, 220 `received` (221 calls carry a key; corrected in review C3). Their keys come from `dispatch.configure`, `commands.run`, `operations.start/finish`, `agents.prompt`, and others.
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

## Review round 1 (#1330) and steering q47/q49
All three reviewers returned FIX-BEFORE-MERGE. Whatever window the owner picks, retention must never delete evidence someone can still ask for. A finished, unkeyed, unreused, old call is now also KEPT when:
- **It is a lifecycle task origin** (a `task.*` step) (A1, C1). `operations.read`/`finish` look a task up by its original call id, and the tool contract says task results persist across restarts. The owner has 12 such calls.
- **Its result is not proven settled** (A3). Settled means: an ok result with status `completed`/`ui_opened`, a `not_started` refusal, or an MCP transport echo. `outcome_unknown` (26 on the owner's machine) and `pending` (157, accepted `agents.prompt` operations) are kept, and so is a missing or unreadable payload (q40).
- **An unaccepted recovery quarantine names it** (A2). Its call ids, and every payload digest the quarantine names, stay until the operator accepts that digest in `recovery-accepted.json`.

Payloads are read only for calls that are otherwise expired, so after the first launch each launch reads about a day's worth.

Other changes:
- **Rewrite failure (B1).** A failed rewrite no longer fails the load, and payload GC never runs after one. Sequences are renumbered on copies, so the rows served still match the unchanged file.
- **Survivors pinned.** Reuse-only target (A, B2), unknown-age row (A, B3), non-digest temp file (B4), and the window at its boundary, 7 days ± 1 minute (C).
- **Fixture metadata (B5).** The shared digest is on the `dispatched` rows.

**Owner question (unchanged, still open):** the window length (default 7 days). With the retained roots above, what a window deletes is only settled, unkeyed, non-task calls: exact request/result copies of reads and completed mutations, which `history.read`/`list` then no longer find. On the owner's store today: 7 days keeps ~520 calls and ~20 MB of payloads; 14 days keeps ~884 calls and ~52 MB.

## Review round 2 (#1330)
- **A GC failure after a successful rewrite (a, b, c; Blocker).** The whole prune rejected, and `open()` served the pre-rewrite rows. The next append numbered itself from that longer list, and the gap got the journal quarantined with keyed calls blocked. Once the rewrite lands, the rewritten rows are always what is served. Each payload deletion fails on its own (warned, retried next launch).
- **A torn-tail quarantine (a, b, c; Major).** It has no guard (it blocks no keyed call), so it was never scanned, and the payload only its torn line names (an outcome fsynced before the append tore) was deleted on the next launch. Evidence is now read from **every** quarantine file whose digest is not accepted. A damaged line still yields its digests, and its call id when visible. An unreadable quarantine file skips retention for that launch.
- **Task detection by byte prefix (a, b, c).** It missed a valid step with another key order and treated a corrupted step as ordinary. It now parses the step through the integrity-checked `payload()`, as the task store does. Unreadable or not an object means kept.
- **First-launch cost (b, c; Minor): accepted as a residual.** Classifying the backlog reads each old result payload once. On a clone of the owner's store the first load took 3.2–6.9 s, and later loads take about 35 ms. It runs on the first control-history use after the upgrade, not at app start. A byte-sniffing shortcut was rejected: that is exactly the kind of guess the task-prefix bug was.

Tests: 3 new cases (red on `65175615`). They also kill round 2's surviving mutations: the task guard is now exercised with a settled result, and quarantine-only digests with a torn tail.
