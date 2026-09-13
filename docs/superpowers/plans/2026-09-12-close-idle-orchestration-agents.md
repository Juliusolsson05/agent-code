# Close Idle Orchestration Agents

Status: in progress. This plan is the first commit; the implementation follows on the same branch.
Feature Issue: [agent-code#960](https://github.com/Juliusolsson05/agent-code/issues/960).
Branch: `feat/close-idle-orchestration-agents`. Worktree: `.worktrees/close-idle-orchestration-agents`.
Base: `origin/main` at `40377871` (2026-09-12). Merge requires explicit approval.

## Outcome

A palette command, **Close Idle Orchestration Agents**, that closes every
orchestration worker in the window that has finished its work and is doing
nothing, after one confirmation that lists exactly which agents will close.

## Why

Orchestration runs leave their workers behind. A parent spawns children with
`orchestration_create_agent`; when they finish they stay in Dispatch as idle
rows until the parent calls `orchestration_close_run`, which frequently never
happens: the parent moved on, was closed, or the user wanted to read the output
first. Today the user closes those rows one at a time, or uses Close Old
Agents, which is driven by an inactivity threshold and cannot tell a worker from
an agent the user opened by hand.

## Design

### What an "idle orchestration agent" is

A session is a target when all of these hold:

1. **It is an orchestration child**: `SessionMeta.orchestrationParentId` is set
   and its kind is an agent provider. Grandchildren count (their parent is the
   coordinator that spawned them). Terminals never do.
2. **It is placed in a project**: a grid leaf or a Dispatch row, resolved through
   `resolveTabSessions` over the window's tabs. Buried sessions are out of scope;
   `closeSession` refuses them anyway ("Kill Buried owns that irreversible act").
3. **It has finished at least one turn and is doing nothing now**: the
   renderer-derived orchestration lifecycle is `completed`. That is the state
   `orchestration_list_agents` reports to the parent agent, so the user's cleanup
   and the parent's `wait_agents` cannot disagree about whether a worker is done.
   `lifecycleStateForRuntime` returns `completed` only when the child is not
   failed, not exited, not running (`sessionStatus`, `processActive`,
   `awaitingAssistant`, `streamPhase`) and has assistant output. The helper that
   computes it is exported from `orchestrationMcp.ts` as
   `orchestrationChildLifecycle` and reused by `buildAgentRecord`, so there is one
   derivation.
4. **Its evidence is settled**: not `bootstrapping`, not `processStatus ===
   'spawning'`, not `transcriptStatus === 'loading'`. Replayed history during a
   reload can show old assistant output for a child whose process is not settled;
   the same guard Close Old Agents uses for "unknown history cannot prove age".
5. **The shared destructive liveness rule agrees**: `isSessionLiveForClose` is
   false. It is implied by (3) for agents today, but it is the rule the kill
   boundary uses, so eligibility states it rather than relying on the implication.

Deliberately NOT targets: working children, children still starting, children
created without a prompt or whose bootstrap prompt has not produced output yet
(lifecycle `created`/`waiting`), exited and failed children. "Idle" is the word
Dispatch paints on a row that is started, alive and not working; an `exited` or
`failed` row is a different state, and a failure is something the user may want
to read before it disappears. Close Old Agents still covers those.

### Coordinators

A child that spawned children of its own is a coordinator. Closing it while one
of its workers is still open would orphan that worker's run: the worker keeps
running with a dead parent that can no longer `wait_agents` or `close_run`.

- **At enumeration**, a coordinator is a target only when every one of its
  orchestration children is also a target. Exclusion propagates upward to a fixed
  point (a working great-grandchild keeps its whole chain open).
- **At the kill boundary**, a coordinator must have no orchestration child left
  at all. Workers are closed first (see ordering below), so any child still
  present has survived: it changed, failed, or appeared after the dialog.

### Scope

Every project tab in the window (grid and Dispatch), matching Close Old Agents'
default "All projects". The command is app-surface, like Close Old Agents and
Switch Agents: the user is cleaning up the workspace, not acting on the focused
pane, and orchestration workers are usually Dispatch rows the user is not looking
at. The confirmation lists every target with its folder, so the breadth is
visible before anything closes.

### Confirmation

Always confirm, through the existing close confirmation broker and dialog
(`requestCloseConfirmation`, reason `multi`, the exact target list). Even one
target confirms. `closeConfirmationFor` exempts an idle single close because a
human aimed ⌘W at a pane they can see and Undo Close covers the mistake; neither
is true here: the command reaches sessions the user may not have on screen and,
as a purge, records no undo entry.

When nothing is idle the command shows a toast and opens no dialog.

The palette closes before the dialog opens, so the dialog is not layered behind
it.

### Execution: one bulk-close loop

Close Old Agents already executes an approved list safely (#886): preConfirmed
per session, `onlyIf` revalidation at the kill boundary with live refs, linked
children before parents, sequential mutation, per-session outcome buckets. That
loop lives inside `CloseOldAgentsModal`. A second copy for this command would be
destructive safety code whose drift nothing compares, so the loop moves to
`src/renderer/src/workspace/bulkClose.ts` as `closeGrantedSessions` and both
surfaces call it.

Two refinements come with the move, both behavior-preserving for Close Old
Agents:

- **Ordering follows both ownership edges** (`linkedParentId ??
  orchestrationParentId`), deepest first. Linked children must close before their
  parent (closeSession keeps the parent otherwise) and workers before their
  coordinator (the rule above). For Close Old Agents this only changes the order
  of kills among sessions it was already going to close.
- **The pre-call revalidation is dropped.** The modal re-enumerated each target
  from its React-committed workspace before calling `closeSession`. The `onlyIf`
  already re-runs the same predicate synchronously at the kill boundary against
  the action's live refs, and a target either check drops lands in the same
  `skipped` bucket. `narrowGrantToCurrent` then has no production caller and is
  deleted with its tests.

The command supplies `currentIdleOrchestrationCloseTarget` as the per-kill
predicate: still placed, still idle, and (for a coordinator) no child left.

### Reporting and undo

- Result toast: `describePartialClose` when anything was skipped, kept or failed,
  otherwise "Closed N idle orchestration agents."
- `captureUndo: false`, as for Close Old Agents and `orchestration_close_run`: a
  purge of N sessions would push N entries and evict the user's own close history
  from the 10-entry stack.

### Command registration

- id `close-idle-orchestration-agents`, title `Close Idle Orchestration Agents`
  (stable noun phrase, imperative one-shot, no ellipsis because the confirmation
  asks no further input; same shape as Close Tab), `surface: 'app'`,
  `category: 'workspace-tools'`, registered directly after Close Old Agents so the
  two cleanup commands sit together in browse order.
- **Default picker tier**, not `advanced`. Close Old Agents is `advanced`, which
  hides it from the palette unless the user reveals hidden commands; this command
  was asked for by name and is the everyday end of an orchestration run.
- `when`: the workspace has at least one orchestration child session. Metadata
  only, because the palette evaluates `when` for every command on every render and
  idleness reads transcripts. The run re-derives real targets and says so when
  none are idle.
- The flow is a workspace action (`workspace.closeIdleOrchestrationAgents`) wired
  in `useWorkspace`, because it needs the global toast and the action's live refs,
  neither of which a command context has. Close Tab and Switch Agents are wired
  the same way.

## Changes by file

- `src/renderer/src/workspace/bulkClose.ts` (new): `closeGrantedSessions`.
- `src/renderer/src/workspace/idleOrchestrationAgents.ts` (new): eligibility,
  enumeration, per-kill predicate, `hasOrchestrationAgents`, and the
  confirm-then-close flow with injected dependencies.
- `src/renderer/src/workspace/orchestrationMcp.ts`: export
  `orchestrationChildLifecycle`; `buildAgentRecord` uses it on the status path.
- `src/renderer/src/features/workspace/ui/CloseOldAgentsModal.tsx`: call
  `closeGrantedSessions`; drop the workspace ref and the pre-call revalidation.
- `src/renderer/src/workspace/closeConfirmation.ts` (+ test): delete
  `narrowGrantToCurrent`.
- `src/renderer/src/workspace/hook/index.ts`: wire and expose
  `closeIdleOrchestrationAgents`.
- `src/renderer/src/features/workspace/commands/sessionCommands.ts`: the command.
- `src/renderer/src/features/command-palette/catalog.test.ts`: snapshot 126 → 127.
- `README.md`: one clause under Fleet management.

## Tests

- **Eligibility (unit)**: finished worker listed; lead agent, ordinary agent and
  terminal child not listed; each working signal excludes; each not-done or
  unsettled state excludes; a buried worker is ignored; a coordinator stays out
  while any worker below it is not a target, and joins when they all are; the
  per-kill predicate refuses a coordinator with any child left.
- **Flow through the real close executor (renderer)**, using
  `mountPaneActions`: confirms exactly the idle list and closes workers before
  their coordinator with no undo entries; a worker that starts working while the
  dialog is open is skipped and its coordinator is kept; declining closes nothing;
  nothing idle shows a toast and never asks.
- **Refactor protection**: the existing `CloseOldAgentsModal.close` renderer tests
  must pass unchanged against the shared loop.
- Catalog snapshot, taxonomy and orchestration MCP tests updated or passing.

## Verification

Node 24. `npm run typecheck` (the only type gate), then the vitest projects
sequentially: unit, system, renderer. `npm run test:contract` and
`npm run check:keybindings`. CI `quality-gate` is the merge gate.

## Known limitations and out of scope

- Eligibility reads renderer state only. Main overlays `prompt_sent` onto the
  lifecycle while it is delivering a prompt
  (`OrchestrationBridge.lifecycleWithPromptDelivery`), and that overlay is not
  visible in the renderer. A prompt a parent sends to a finished worker in the
  moment before the user confirms can therefore still be in flight when that
  worker is judged idle. The kill-boundary check catches it as soon as the
  provider reports activity; the residual window is the one `orchestration_close_run`
  and Close Old Agents already have.
- A child whose orchestration metadata was stripped by reload, provider switch,
  resume or rewind (#879) is no longer recognized as an orchestration child.
- A hibernated worker whose history has not been hydrated has no assistant output
  in the renderer, reads as `waiting`, and is left open.
- No keybinding. No per-project or per-run scoping; the dialog is the review step.
