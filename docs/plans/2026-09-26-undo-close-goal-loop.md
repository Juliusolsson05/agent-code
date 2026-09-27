# Undo Close carries the pane's goal loop (#1320)

## Problem
Undo Close respawns a closed pane under a NEW session id. `GoalLoopService` keys loops by session id, so the restored pane's loop stays filed under the dead id: the pane cannot Resume or Stop it (same symptom as #1279, which #1287 fixed for replace and Reload Agents). Closing a pane does not end its loop.

## Evidence
- `undoClose.ts` `restoreSessionEntry` / `restoreTabEntry` remap pins, lanes and lineage old → new but never call `goal-loop:carry`. The only carries are in `session.ts` (replace, Reload Agents).
- `spawn` writes the resolved `builtInMcpDomains` into the successor's meta, and Undo Close respawns with the closed pane's MCP overrides, so the restore can see whether the successor has Goal Loop tools.

## Decisions (defaults)
- **Same rule as #1287:** a restored pane whose successor has `goal_loop` gets its loop carried (main pauses it on carry). One without it gets the old loop stopped, because nothing could ever complete it. Every Undo Close restore resumes the SAME conversation, so there is no newConversation exception.
- **Shared helpers:** `carryGoalLoops` / `stopGoalLoops` move from `session.ts` into the shared `successorCarry.ts` (renamed from #1325's `workflowCarry.ts`), with one `handOverGoalLoops(idMap, capable)` rule that Undo Close uses. Reload Agents keeps its inline copy of the same rule for now: #1324 and #1326 are rewriting that function, so switching it waits until they land.
- **Timing:** after the commit, like replace, so a restore that bails (project closed mid-spawn) keeps the loop where it was.
- **Stacked on #1325** (base `fix/workflow-runs-follow-pane`): both edit the same Undo Close commit sites.

## Tests
Renderer (`undoCloseWorkflowCarry.renderer.test.tsx`): a pane restore with Goal Loop tools carries; without them stops the old id; a project restore carries to each capable successor and stops the rest; a restore that bails carries and stops nothing. Red on the base branch.
