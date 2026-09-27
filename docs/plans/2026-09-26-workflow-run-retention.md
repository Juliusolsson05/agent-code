# Workflow runs and workflow Codex sessions are never pruned (#1275)

## Problem

`<userData>/workflows/` grows without bound:

- `runs/` holds one directory per workflow run: `manifest.json`, `events.jsonl`, `workflow.js`,
  `args.json`, `artifacts/` and `transcripts/{journal,agent-*}.jsonl`.
- `codex-home/sessions/` holds the Codex rollouts of every workflow agent attempt.
- The isolated Codex home's sqlite indexes (`thread_history_1.sqlite`, `state_5.sqlite`) grow too.

Nothing deletes any of it:
- `FileWorkflowStore` removes only its own lease debris;
- `WorkflowStore` has no delete API;
- `debugRetention.ts` manages `~/.config/agent-code/…` only (a different root from Electron
  `userData`).

## Evidence (owner's machine, 2026-09-26)

| What | Count | Size |
|---|---|---|
| Run directories | 134, all terminal: 96 completed, 18 cancelled, 9 failed, 7 completed_with_errors, 4 interrupted | 623 MB |
| `events.jsonl` total | | 319 MB |
| `transcripts/journal.jsonl` total | | 13 MB |
| Rollouts in `codex-home/sessions/` | 833 | 576 MB |
| `thread_history_1.sqlite` | | 110 MB |
| `state_5.sqlite` | | 27 MB |

- Manifest ages range from 2.1 to 9.0 days (median 9.0). That is about 1.3 GB in nine days, roughly
  140 MB/day at the owner's rate.

## How the pieces depend on each other (from reading the code)

- **What the user sees:**
  - Past runs in the UI come from transcript references plus on-demand store lookups.
    `WorkflowHistoryDialog.tsx` already renders a missing manifest as "Unknown", so pruned runs
    degrade by design.
  - `workflows.runs` (control API) lists the store's index, so a pruned run simply disappears from it.
- **Resume:**
  - `#resumeStored` accepts `interrupted | failed | cancelled | completed_with_errors`, never
    `completed`.
  - It reads `workflow.js`, `args.json` and `transcripts/journal.jsonl`.
- **Startup auto-recovery (the hazard):** `WorkflowService` initialization treats an `interrupted`
  run with **no successor** (no run whose `resumedFromRunId` names it) as needing a replay decision,
  and auto-recovers it when replay-safe (`workflowService.ts` ~L413-424). Deleting a successor while
  keeping its interrupted predecessor could make an old workflow **re-run on its own** at the next
  launch.
- **Run to Codex session:**
  - Each run's `transcripts/journal.jsonl` records `{"session":{"provider":"codex","id":…}}` for its
    agent attempts, and so does `events.jsonl` (`agent.session.started`).
  - Rollouts live at `codex-home/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`.
  - The workflow Codex home is private to workflows. Interactive Codex never reads it: sessions are
    imported **into** it from `~/.codex`, never the other way.
- **Codex sqlite:** deleting a rollout file does not corrupt Codex. The index row goes stale, and
  Codex falls back to a filesystem search and self-heals (vendor `rollout/src/list.rs`,
  `state_db.rs read_repair_rollout_path`). Only Codex's own `thread/delete` RPC also removes the rows.

## Decisions (defaults — owner may override)

1. **The policy lives in the app; the mechanism lives in the package.** Mirroring `debugRetention.ts`
   and the package convention ("the package supplies mechanism, the embedding app owns policy",
   `workflowStore.ts` `runOwnedMutation`):
   - **Package (workflow-mcp):** `FileWorkflowStore.deleteRun(runId)` and a `WorkflowStore.deleteRun?`
     interface member. It runs under the store's lease-scoped writer. It refuses a run that is not
     terminal or that has an append in flight. It removes the run from every in-memory index
     (summaries, status keys, lineage members, successors), then removes the directory.
   - **App:** `src/main/workflows/workflowRetention.ts` decides what to delete and calls it.
2. **Prune whole lineages, never part of one.** A lineage (all runs sharing `lineageId`) is prunable
   only when **every** member is terminal and **every** member's `updatedAt` is older than the
   cutoff. Members are deleted oldest first (predecessor before successor). A crash mid-lineage then
   leaves a successor whose predecessor is gone, which is harmless. The reverse order would leave an
   interrupted predecessor without a successor, which auto-recovers.
3. **TTL: 7 days after a run's last update for lineages whose runs all completed, and 30 days for a
   lineage with any resumable run** (failed, cancelled, interrupted, completed_with_errors).
   *UNCONFIRMED defaults.* Resumable runs stay in workflow history with a Resume action (review of
   workflow-mcp#65; 38 of 134 runs on the owner's corpus), and Resume fails once the run is deleted.
   The UI's handling of an expired run is follow-up issue #1348. `AGENT_CODE_WORKFLOW_RUN_TTL_DAYS`
   scales both.
   Seven days bounds the owner's current completed-run rate to about 1 GB. A lineage the user is
   still resuming keeps a fresh `updatedAt`, so it is never prunable.
4. **Codex rollouts:** after pruning runs, delete a rollout in the **workflow** Codex home only when
   - its mtime is older than the same cutoff, **and**
   - its session id is not recorded in the journal of any run that is kept.

   Reading only the kept runs' journals (13 MB for all 134 today) keeps this cheap. The mtime guard
   covers sessions from runs this process never recorded.

   **Fail closed (steering q64/q66).** A kept run whose journal cannot be read or understood has
   UNKNOWN references, not none, so the whole rollout pass is skipped (`rolloutsSkipped`) and the next
   daily pass retries it. The first version skipped such a journal and would have deleted the old
   rollout that run needs for Resume.
   - Journals are read through the package's own validated reader (`readWorkflowJournalSnapshots`,
     exported for this in workflow-mcp#65), not a regex. That covers format, version, session shape
     and the size cap, the same checks resume applies.
   - A Codex session id that is not a thread id also fails the pass closed.
   - Validated on the real corpus (2026-09-27):
     - 133 journals, format `workflow-mcp-journal` v1 (32) and v2 (101), no malformed file;
     - 1,095 session records, all at `snapshots[].sessions[].session` = `{provider: "codex", id}`
       with thread-id-shaped ids;
     - `providerSession` never appears in a stored journal.
   - A MISSING journal is "no references", as it is for the package's reader. One real failed run
     from July never wrote one.
   - Tests: an EACCES journal, a truncated journal, and an unknown id shape, each with an old
     referenced rollout and an old orphan; nothing is deleted. Both damage cases fail on `4d541115`.

   **Unreclaimed deletions (workflow-mcp#65, round 4).**
   - The store deletes a run by moving it to `runs/.deleted-…`, then removes the bytes. A removal
     that keeps failing (a locked subdirectory) used to be silent.
   - Each pass now calls `reclaimDeletedRuns()` after its deletes, and reports what is still on disk
     (`runsUnreclaimed`, logged). The next pass retries.
5. **When:** once after `WorkflowService` initialization (so startup recovery decisions have already
   been made on the full history), then every 24 h while the app runs (an unref'd timer). It is a
   no-op while any run is non-terminal in the lineage being considered.
6. **Codex sqlite is not compacted here.** Stale index rows are harmless, and reclaiming them needs
   Codex's `thread/delete` through a short-lived app-server against the workflow home. **Residual,
   filed as a follow-up issue:** the two sqlite files (137 MB today) keep their rows.

## Tests

- **Package (`test/fileWorkflowStore.system.test.ts` or a new system test):**
  - `deleteRun` removes a terminal run's directory and every index entry (`listRuns`,
    `findLatestSuccessor`, `findActiveLineageSuccessor`);
  - it refuses non-terminal runs and runs with an append in flight;
  - it works under the lease and fails after the lease is released.
  - Fail-first: the method does not exist yet.
- **App (`workflowRetention.test.ts`, real `FileWorkflowStore` on a temp root, fixtures built through
  the store's real `createRun`/`appendEvent` path):**
  - an old all-terminal lineage is pruned oldest first;
  - a lineage with one fresh member is kept whole;
  - an old interrupted predecessor whose successor is fresh is kept, and so is the successor (the
    auto-recovery hazard);
  - rollouts: an old unreferenced rollout is deleted, while an old one referenced by a kept run's
    journal and a fresh unreferenced one are kept;
  - the interactive `~/.codex` home is never touched.
  - Counts come from the recorded real layout: a real run's manifest/journal shape, sanitized ids.

## Delivery

1. workflow-mcp PR: `deleteRun` + tests, with three reviews.
2. agent-code PR: this plan, `workflowRetention.ts` + wiring in `createWorkflowService`, the pointer
   bump and lockfile resync (`file:` dep), and the follow-up issue for sqlite.
