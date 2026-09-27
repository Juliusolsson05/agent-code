# Debug-storage pruning waits until the workspace has recovered (#775, prune half)

Refs #775. That issue has two halves. This branch covers the **retention prune on the boot critical path**. The other half, starting the workflow service after window creation, edits the same `index.ts` block as W2's open #1325, and turns a service captured once at startup into one the MCP host, IPC and control host must wait for. It is not in this branch; who takes it is the manager's call (asked in W3's status, 2026-09-27).

## Evidence (verified 2026-09-27, do not re-derive)
The owner's app-run journals, `~/.config/agent-code/incidents/runs/*/events.jsonl` (50 runs; 32 with a journaled prune):
- **The boot prune always runs before the workspace has recovered.** `debug_retention.prune reason=incident-run-start` lands 0.3–3.1 s after run start (one run: 12.7 s). The first window's `rehydrate.complete` lands at 2.6–23.4 s, so the prune's `statfs`, directory walk and `rm -rf` compete with the session herd coming back. In the last 32 runs it freed 0–274 MB; the issue's original report recorded 5.8 GB freed at 38 s into a boot.
- **The multi-GB prunes now happen mid-session**, from `feed-debug-append` (6.7 GB at 601 s, 3.5 GB at 1,872 s). That is the cooldown path, not boot, and is out of scope here.
- Code:
  - `AppRunJournal.start()` calls `scheduleDebugStoragePrune('incident-run-start')`;
  - `index.ts:870` calls `scheduleDebugStoragePrune('startup')`, which the 5-minute cooldown coalesces;
  - feed-debug and performance appends call it too.

## Decisions (defaults; UNCONFIRMED)
1. **A boot gate in `debugRetention.ts`.** `holdDebugStoragePruneUntilRecovered()` closes the gate. Requests while it is closed are coalesced into one pending prune (first reason kept) and run when it opens. The gate is never closed except by that call, so every existing caller and test keeps today's behavior.
2. **Who closes it:** `AppRunJournal.start()`, right before its run-start prune. That is the one boot-only place that already owns the first prune. `index.ts` is not touched.
3. **Who opens it:**
   - 60 s after the first window's `rehydrate.complete`. That signal is already reported to main through the lifecycle IPC (`ipc/lifecycle.ts`), and 60 s is past the recorded session-wake burst.
   - Or a 5-minute fallback armed when the gate closes, so a run with no window (or a renderer that never reports) still prunes.

   Both values are UNCONFIRMED defaults.
4. A disk-full emergency is not special-cased. The gate delays by at most 5 minutes, and the 3% budget already leaves headroom.

## Tests
- `debugRetention.test.ts`: with the gate closed, requests do not prune. `rehydrate.complete` + 60 s runs exactly one prune, carrying the first reason. The fallback fires at 5 minutes when no window reports. An ungated call still prunes immediately.
- `ipc/lifecycle.test.ts` (or the nearest existing file): a renderer `rehydrate.complete` report arms the open.
- `AppRunJournal` test: start() closes the gate before its prune request, so the request is pending, not run.

All with fake timers, red on main.
