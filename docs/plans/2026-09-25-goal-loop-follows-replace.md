# A goal loop follows its pane across replacement (#1279)

Found by the Stage 3 C2 hunt (`temp/quality-loop/hunt-c2.md`).

## Evidence
- GoalLoopService keys loops by local session id (`startLoop`, `loops` Map). No path moves a loop between ids.
- Every replacement path (reload, provider switch, resume, rewind, MCP toggle, Reload Agents) gives the pane a new id: the renderer's `replaceSession` or reload-all spawns a successor, commits `old -> new` into workspace state, and kills the old process.
- The old id's `removed` event pauses the loop as `interrupted` under the dead id. GoalLoopPane and useGoalLoops look up the new id and find nothing, and goal_loop_complete from the new process fails with "no loop".
- AgentMcpServersModal already stops the loop before its reload for this reason.

## Change
- `GoalLoopService.carry(from, to)` moves the loop and rewrites its `sessionId`.
  - It first runs `interrupt(from)`, so the dead id's trackers are dropped and an active loop becomes paused/interrupted. This is the restart rule: never blind-continue into a process that has not proved its hooks. The user resumes it from the pane, which now finds it.
  - It refuses (returns null) if there is no source loop, or if the successor already has a non-ended loop.
  - It persists and emits `changed`.
- A new IPC `goal-loop:carry` has the same trust level as `goal-loop:control` (an application window).
- The renderer calls it at both commit points (`replaceSession` after `committed`, and reload-all after its state commit) with the same idMap used for pins, lanes and relationships. It is fire-and-forget: a failure leaves today's behaviour.

## Tests
- Service: moves paused; a late `removed` is a no-op; the successor can complete; the store holds only the new id; it never overwrites; there's no delivery before resume.
- Renderer: a committed `replaceSession` calls `carryGoalLoop(old, new)`. This fails on main.
