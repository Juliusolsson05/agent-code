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
- **The renderer calls it** where it carries goal loops (#1287): same-conversation replacements (reload, provider switch, rewind, MCP toggle) and Reload Agents. Not for `newConversation` swaps: those runs belong to the previous conversation.

## Tests
Bridge tests: a carry moves the runs; aliases survive a restart, including chains; a resume after a carry registers under the successor. A renderer test: a committed replacement calls the carry. Red on main.
