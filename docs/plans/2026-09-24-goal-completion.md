# Goal: let agents complete their goal and bulk-close completed agents

Fixes #1182.
Branch `feat/goal-completion` · Worktree `.worktrees/goal-completion` · Base `origin/main` @ 73f77de6 (2026-09-24).
Status: implemented, PR #1184 open, one review round resolved; merge needs explicit approval.

## Outcome

An agent that finished the user's task (feature built, PR merged) calls
`goal_complete`. The user runs **Close Completed Agents…**, sees every agent
whose goal is complete across all projects, and closes the ticked ones, with
their lanes removed, in one confirmation.

## Evidence (verified, do not re-derive)

- Goals are a second `TldrStore` instance (`goal.json`, `goal-history/`,
  label `Goal`), `src/main/index.ts` ~1203. Writes go only through the
  authenticated MCP scope (`createBuiltInMcpServer.ts` `goal_set`); the
  renderer reads through `goal:read` / `goal:history` / `goal:changed`.
- `TldrStore.load()` rebuilds each record from `text/updatedAt/revision`, so
  extra fields in an older build are dropped, not rejected (downgrade-safe).
- `readGoals` returns `TldrRecord`, so optional fields on that type reach the
  desktop readers (overlay, history, close menu) with no new IPC. NOT the
  phone: the remote server and client rebuild note frames field by field
  (`RemoteServer.ts` live forward + bootstrap, `WebSocketSessionFeed.ts`,
  `wire.ts`), so completion never reaches it (corrected after review).
- Bulk close: `workspace/bulkClose.ts` `closeGrantedSessions` (grant = rows
  shown; `currentTarget` re-judges each kill synchronously; deepest owner
  first). Used by Close Old Agents (modal) and Close Idle Orchestration
  Agents (confirm dialog).
- Closing a session leaves its lane pointing at a dead id until the clear path
  blanks it; `removeTiledLane` (`removeLaneFromGrid`) refuses at the
  one-lane floor. "Close Agent and Remove Lane" removes the lane only after
  `closeSession` returned true.
- Turn hooks exist only for Claude and Codex; the goal instructions travel in
  MCP initialization and the managed `agent-code-goal` skill, both built from
  `GOAL_INSTRUCTIONS`.
- #1176 (unseen-completion stripe) is about turns, not goals; no overlap.

## Decisions (answered 2026-09-24: all defaults)

1. Part of the Goal capability; no separate toggle.
2. Call only after the user's outcome is delivered and accepted.
3. Only `goal_set` clears completion.
4. Shown in the Cmd+G peek, history modal and close menu; no pane badge yet.
5. New command **Close Completed Agents…**, all projects, checklist ticked by default.
6. "Also remove their lanes", on by default; only lanes whose agent really closed; floor respected.
7. Running agents listed but not selectable; refused at the kill boundary anyway.
8. No turn-end nudge.
9. Separate from `goal_loop_complete`.

## Design

### Data
- `TldrRecord` gains optional `completedAt` (ISO) and `completionNote`
  (normalized, ≤400 chars). Both present or both absent.
- `TldrStore.complete(identity, note, authorized)`: requires an existing
  record ("Set a goal with goal_set before completing it."), keeps `text` and
  `updatedAt` (the "Goal set" time), sets the two fields, bumps `revision`
  (so revision-ordered readers accept it), same serialized atomic write and
  post-I/O revocation check as `update`.
- `update()` writes a fresh record without completion fields: a new goal
  clears completion by construction, no extra rule.
- History: `TldrHistoryEntry` gains optional `completed: true`; the entry's
  text is the completion note.
- `load()` / history validation accept the optional fields and reject a
  half-present pair.

### MCP
- `goal_complete({ summary })` registered with the `goal` domain, same
  authority model as `goal_set` (scope identity, fail closed on revocation).
- `GOAL_INSTRUCTIONS` gains a completion paragraph (when, and when not).
  The managed skill redeploys because its markdown changed.

### Renderer
- Goal peek: `✓ Completed` + note; footer adds "Completed <time>".
- History modal: completion rows labelled "Goal completed".
- `closeCompletedAgents.ts` (pure): candidate rows from placed agent
  sessions with an identity, joined with goal records; `currentTarget` for
  the kill boundary (still placed, not live, still completed per the latest
  record map).
- `CloseCompletedAgentsModal` + surface + ui-shell flag + command
  `close-completed-agents` (`app`, `workspace-tools`). Lanes removed after
  the loop, highest index first, only for sessions in `outcome.closed`.
- Kill caller `bulk.close-completed-agents` for the journal.

## Tests
- Store (system, real files): complete requires a goal; complete keeps goal
  text + bumps revision; `update` clears completion; restart reload keeps it;
  half-present pair rejected; revoked write refused.
- MCP host (system): `goal_complete` over the real HTTP host with the
  session bearer.
- Candidate/currentTarget (unit) and modal (renderer) through the real close
  executor: only ticked + completed + idle close; running refused; a goal
  reset while open drops the row; lanes removed only for closed ones.
- Peek/history renderer tests for completion display.

## Verification
Scoped vitest while iterating; `npx tsc -b` and the full suite once at the end
(Node 24); CI. Verification boundary: the app is not launched; the visual
check of the modal and peek is for the user.

## Out of scope
- Phone (remote) peek showing completion: needs the protocol frame, both
  server paths and the client wire, not just UI (see Evidence).
- Agent Activity's goal column does not mark completion.
- Downgrading to a pre-#1182 build drops completions from goal.json on the
  old build's next goal write; an old history modal shows completion rows as
  goals. Harmless (nothing closes on its own), accepted.
- Pane/index badge for completed agents.
- `agent_management` MCP exposing goal/completion to managing agents.

## Rulings
- Ruling: no renderer "messaged since completion" signal — `turnStartedAt`
  and `submittedAt` reset at idle, so an idle agent carries no trace of a
  later turn; the prompt hook handles it instead — cost if wrong: on
  OpenCode/Grok/Pi (no hooks) a completed agent given a same-direction
  follow-up without a new goal stays listed; the user sees its goal and note
  before closing.
- Ruling: the modal mounts per opening rather than resetting its state on
  open — structural freshness beats a reset list every new state must join —
  cost if wrong: no exit animation on close.

## Review (2026-09-25, one round: two Claude reviewers)
| Finding | Verdict | Disposition |
|---|---|---|
| Completed agent given follow-up work stays completed and ticked (A1, major) | valid | prompt hook asks a completed agent to `goal_set` before more work (`GOAL_COMPLETED_CONTEXT`) |
| Modal reuses last opening's goals until/unless the read lands (B1, major) | valid | mount per opening; Close gated on a fresh read; failed read shown |
| Coordinator closes under open workers / worker under live coordinator (B2) | valid | owner rule to a fixed point in list + pre-loop; kill-time refuses a worker whose coordinator left the grant or is working |
| Lanes silently kept after a mid-close reshape (B3) | valid | toast says so |
| Blocked row ticks itself when it clears (B4) | valid | rows seen blocked default unticked |
| Remote frames drop completion; plan claimed otherwise (A2) | valid | plan corrected; phone stays out of scope |
| Agent Activity shows no completion (A3) | valid | listed out of scope |
| Downgrade drops completions (A4) | valid | documented, accepted |
| Dedupe comment describes the wrong case (A5) | valid | comment fixed; note==goal test added |
| Surviving mutations (note normalization, change event, set-time, history marker, disabled peek, reader-after-click, ready gate, orchestration rules) | valid | tests added; each re-run killed |

