# Closed orchestration children follow their parent's replacement (#1283 item 1)

## Problem
`OrchestrationBridge` keeps a small in-memory tombstone for every child closed through the orchestration MCP (`closedAgents`, 24 h / 500 entries). This is how a parent can still see "closed" as a state after the renderer removes the pane. A tombstone matches a parent by its frozen `orchestrationParentId` / `orchestrationRootId`.

When the parent P is replaced by P′, the renderer remaps every LIVE child's pointers to P′ (`remapSessionsRelationships`). This covers replace, provider switch, resume, rewind, Reload Agents and rehydrate. Main is never told, so its tombstones still say P:
- P′'s `list_agents` / `read_run_outputs` omit every closed child;
- `read_agent` on a closed child returns not-found;
- the `parentSessionByChildSession` hints still point at P, so a child's prompt boundary invalidates P's status cache instead of P′'s.

## Evidence
- `OrchestrationBridge.agentMatchesParent` compares the stored ids directly.
- No IPC or main path ever learns the renderer's old→new session id map for orchestration. `workflows:carry-session` is the only such channel, and it deliberately skips a newConversation swap, which live children do NOT skip.
- Found by the Stage 3 C2 hunt (temp/quality-loop/hunt-c2.md, row 7).

## Decisions (defaults)
- **One new IPC, `orchestration:carry-parent {from, to}`.** It is called at exactly the sites that remap live children's pointers, and it is fire-and-forget like `carryWorkflowRuns`: a failed carry leaves the pre-fix behaviour, and never blocks a swap. It does not piggyback on `workflows:carry-session`, because that one follows the conversation (it is skipped for newConversation), while orchestration pointers follow the PANE.
- **Main rewrites at carry time.** Stored tombstones whose parent or root is `from` now say `to`, so a parent reading them sees consistent ids. The same goes for `parentSessionByChildSession` hints, and both status caches are invalidated.
- **Plus a bounded alias chain for tombstones created later.** `closeAgent` reads the child BEFORE it asks the renderer to close it. A swap in between hands `noteClosed` a record that still says P. `noteClosed` resolves the ids through the aliases (following P→P′→P″, with a hop cap against cycles). Aliases share the tombstones' TTL and size cap.
- **Trust:** the same as `workflows:carry-session` and `goal-loop:carry`. An application window can already list, read and close any orchestration child it can see.
- **Out of scope:** items 2 (Codex handoff lease, #1338) and 3 (PTY attach counts) of #1283. So this PR says `Refs #1283`, not `Fixes`.

## Tests
- `OrchestrationBridge.test.ts` (fail-first):
  - a tombstone of P is listed, read and returned by `read_run_outputs` for P′ after `carryParent(P, P′)`;
  - a close whose pre-read happened before the carry is still found under P′;
  - a two-hop lineage works, and a cycle terminates.
- Renderer: `carryOrchestrationParents` is called with the committed idMap on replace and reload, and not for a successor killed as an orphan.
