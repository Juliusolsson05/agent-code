# Workflow runs follow their pane across replacement (#1280)

## Evidence
- The owner's workflow store (`~/Library/Application Support/agent-code/workflows`) holds 134 runs. All 106 that name an owning session name one that is not live in `workspace.json` now (closed or replaced; the store cannot tell which).
- `WorkflowBridge.runsBySession` and each run's durable `clientId` are the session id at start. After `replaceSession` (P → P'), `getSessionRuns({ sessionId: P' })` is empty and the pane's workflow cards and Active navigation vanish.
- After a restart the bridge rebuilds from `clientId = P`, so the loss is permanent. A resume from the UI registers the resumed run under the dead P too.
- workflow-mcp uses `clientId` for attribution only (its `scope-forbidden` is path-based), so no package change is needed.

## Change (app only)
- **`WorkflowBridge.carrySession(from, to)`:** moves the pane's runs to the successor id, republishes both ids, and persists `from → to` in a small alias file beside the store.
- **At start:** stored `clientId`s are resolved through the alias chain, so a restart finds the runs under the live id. A resume registers under the live id.
- **IPC `workflows:carry-session`,** with the same trust level as `goal-loop:carry`.
- **The renderer calls it** where it carries goal loops (#1287): same-conversation replacements (reload, provider switch, rewind, MCP toggle) and Reload Agents. Not for `newConversation` swaps: those runs belong to the previous conversation. Undo Close (a pane or a whole project) calls it too, because it resumes the same conversation under a fresh id.

## Round 1 review decisions
- **Every carry records its edge,** even when the pane has no runs yet: a run the pane's MCP started just before the swap registers after it. `registerRun` (so also Resume and the MCP `onRunStarted` callback) resolves the alias chain, so a late registration never recreates the dead slot.
- **Pruning at start:** every replacement now adds an edge, so `start()` drops the loaded edges that no stored run's clientId reaches, and saves if it dropped any. Edges added while start is running are kept.
- **Saves are serialized.** Each queued write snapshots the map when it runs, and temp names carry a counter, so an older snapshot can never rename last.
- **A carry never deletes the successor's runs.** Same cwd: the slots merge and go through the same lineage collapse as `upsertRun` (a helper both use). Different cwd: the carry is skipped and no edge is recorded.
- **An edge out of the target is dropped** when the target becomes live again, which also rules out a cycle from ordinary carries. The resolver still stops at a cycle read from a corrupt file.
- **Declined:** the crash window between the alias save and the workspace autosave (review A, suspicion). It needs a crash in that gap, and the runs stay in the workflow store either way.

## Tests
Bridge tests: a carry moves the runs and clears the old view; aliases survive a restart, including chains; a resume after a carry registers under the successor. Round 1 adds: a late registration after the carry (with and without runs at carry time, and across a restart); a resume that returns after a carry; two concurrent saves with a delayed rename; merging into a successor that already has runs, including a lineage collapse; a successor in another cwd; a malformed alias file; a cyclic alias file; pruning; and dropping an edge out of a live pane. Renderer tests: a committed replacement calls the carry, and Undo Close carries for a pane and for a project. All red on main, apart from the malformed-file, cycle and clear tests, which pin surviving mutants.
