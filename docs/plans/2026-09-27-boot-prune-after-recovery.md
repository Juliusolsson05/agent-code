# Debug-storage pruning waits until the workspace has recovered (#775, prune half)

Refs #775. That issue has two halves. This branch covers the **retention prune on the boot critical path**. The other half, starting the workflow service after window creation, edits the same `index.ts` block as W2's open #1325, and turns a service captured once at startup into one the MCP host, IPC and control host must wait for. It is not in this branch; who takes it is the manager's call (asked in W3's status, 2026-09-27).

## Evidence (verified 2026-09-27, do not re-derive)
The owner's app-run journals, `~/.config/agent-code/incidents/runs/*/events.jsonl` (50 runs; 32 with a journaled prune):
- **The boot prune always runs before the workspace has recovered.** Every one of the 30 journaled `incident-run-start` prunes completed before its run's first `rehydrate.complete`. Those prunes completed 0.3–41 s after run start (most under 4 s). First `rehydrate.complete` reports landed 2.2–70.5 s after start in 45 runs; 5 runs never reported one. The largest journaled boot prune freed **1.98 GiB at 25.4 s** (its `rehydrate.complete` came at 60.5 s). The median is about 5 MB and p90 about 81 MB. (Corrected in review c. The first version said "0–274 MB" and gave narrower ranges. The issue's "5.8 GB at 38 s" is a pre-journal report.)
- **Session wakes after recovery:** 225 wake events fall within 60 s of the first `rehydrate.complete`. 102 more fall between 60 and 300 s, in 19 of 45 runs; that tail may be user-initiated.
- **The multi-GB prunes also happen mid-session**, from `feed-debug-append` (6.61 GiB at 601 s, 3.43 GiB at 1,872 s). That is the cooldown path, not boot, and is out of scope here.
- Code:
  - `AppRunJournal.start()` calls `scheduleDebugStoragePrune('incident-run-start')`;
  - `index.ts:870` calls `scheduleDebugStoragePrune('startup')`, which the 5-minute cooldown coalesces;
  - feed-debug and performance appends call it too.

## Decisions (defaults; UNCONFIRMED)
1. **A boot gate in `debugRetention.ts`.** `holdDebugStoragePruneUntilRecovered()` closes the gate. Requests while it is closed are coalesced into one pending prune (first reason kept) and run when it opens. The gate is never closed except by that call, so every existing caller and test keeps today's behavior.
2. **Who closes it:** `AppRunJournal.start()`, right before its run-start prune. That is the one boot-only place that already owns the first prune. `index.ts` is not touched.
3. **Who opens it:**
   - 120 s after the first window's `rehydrate.complete` (raised from 60 s in review c; see the wake tail above). That signal is already reported to main through the lifecycle IPC (`ipc/lifecycle.ts`).
   - Or a 5-minute fallback armed when the gate closes, so a run with no window (or a renderer that never reports) still prunes.

   Both values are UNCONFIRMED defaults.
4. A disk-full emergency is not special-cased. The gate delays by at most 5 minutes, and the 3% budget already leaves headroom.

## Tests
- `debugRetention.test.ts`: with the gate closed, requests do not prune. `rehydrate.complete` + 60 s runs exactly one prune, carrying the first reason. The fallback fires at 5 minutes when no window reports. An ungated call still prunes immediately.
- `ipc/lifecycle.test.ts` (or the nearest existing file): a renderer `rehydrate.complete` report arms the open.
- `AppRunJournal` test: start() closes the gate before its prune request, so the request is pending, not run.

All with fake timers, red on main.

## Review round 1 (#1351)
- **A degraded journal bypassed the gate (a, b; Major).** `start()` returned early when the incident directory was unwritable, before the hold, and `startup` then pruned immediately. The hold now comes first in `start()`, before any I/O.
- **The journal test pointed `process.report` at the owner's real store (a).** It is restored after each `start()`.
- **Test gaps (b, c):**
  - removing the gate itself was undetectable, because the held assertions raced real I/O under fake timers; a real-timer "nothing is deleted while closed" test now fails when the gate is removed;
  - the `unref` of the gate timers and the re-arm guard are now pinned by a timer test.
- **Evidence corrected (c):** see above. The recovery delay was raised to 120 s.
- **The split, stated fully (c):** besides the workflow-service start, #775 also asks to defer the first feed-debug flush and the per-window `setup:check`. Neither is in this PR; both stay open under #775.
