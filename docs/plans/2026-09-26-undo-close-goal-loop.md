# Undo Close carries the pane's goal loop (#1320)

## Problem
Undo Close respawns a closed pane under a NEW session id. `GoalLoopService` keys loops by session id, so the restored pane's loop stays filed under the dead id: the pane cannot Resume or Stop it (same symptom as #1279, which #1287 fixed for replace and Reload Agents). Closing a pane does not end its loop.

## Evidence
- `undoClose.ts` `restoreSessionEntry` / `restoreTabEntry` remap pins, lanes and lineage old → new but never call `goal-loop:carry`. The only carries are in `session.ts` (replace, Reload Agents).
- `spawn` writes the resolved `builtInMcpDomains` into the successor's meta, and Undo Close respawns with the closed pane's MCP overrides, so the restore can see whether the successor has Goal Loop tools.

## Decisions (defaults)
- **Same rule as #1287:** a restored pane whose successor has `goal_loop` gets its loop carried (main pauses it on carry). One without it gets the old loop stopped, because nothing could ever complete it. Every Undo Close restore resumes the SAME conversation, so there is no newConversation exception.
- **Shared helpers:** `carryGoalLoops` / `stopGoalLoops` move from `session.ts` into the shared `successorCarry.ts` (renamed from #1325's `workflowCarry.ts`), with one `handOverGoalLoops(idMap, capable)` rule that Undo Close uses. Reload Agents keeps its inline copy of the same rule for now: #1324 and #1326 are rewriting that function, so switching it waits until they land.
- **Timing and placement (revised after round 1):** the hand-over runs once per single undo entry, in `restoreSingleEntry`, after the restore resolves; it no longer runs at each restore's success commit. `publish` records which closed ids came back. A `retryable-failure` keeps the entry, so nothing moves. Any other result consumes the entry:
  - ids that came back are handed over (runs carried; loop carried or ended by capability);
  - ids that did not come back (failed project members, a stale restore where the project closed mid-spawn or the folder is gone) get their loop ended, because no pane can ever reach it again;
  - their workflow runs are left alone, as finished history in the store.
- **Stacked on #1325** (base `fix/workflow-runs-follow-pane`): both edit the same Undo Close commit sites.

## Tests
Renderer (`undoCloseWorkflowCarry.renderer.test.tsx`): a pane restore with Goal Loop tools carries; without them stops the old id; a project restore carries to each capable successor and stops the rest; a restore that bails carries and stops nothing. Red on the base branch.

## Round 1 review decisions (#1331)
- **All three reviewers: a consumed entry orphaned loops.** A partial project restore, and a restore judged stale, left the loop under a dead id with no retry. Fixed with the per-entry rule above. The tests for the partial project and the bail are red on the round-1 head.
- **Review a (surviving mutant):** a project restore returning `stale` instead of `restored`. Pinned by an older entry below the project that must stay on the stack.
- **Review c (surviving mutant):** a successor with no filed meta treated as capable. Pinned: with no meta the loop is ended.
- **Review c (product question, declined here):** a loop ended because current Settings lack Goal Loop tools cannot be revived by enabling them later. That is #1287's rule for every successor path; changing it is a product decision beyond this issue.
- **Residual, not this issue:** 11 of the owner's 16 stored loops sit under ids that are not live, 5 of them paused. The store does not record which path produced them. Closing a pane and never undoing it still leaves its loop behind, which is outside #1320.
