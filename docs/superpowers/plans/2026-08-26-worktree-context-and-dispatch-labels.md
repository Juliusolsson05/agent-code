# Worktree Context and Dispatch Label Corrections

> Status: approved for implementation from reproduced bugs #658 and #659.

## Outcome

Make the worktree shown for a live Codex agent follow the current rollout's
actual command/edit location, and make every Dispatch pane header repeat the
canonical coordinate shown for that same row in the visible Dispatch index.

The changes share one user-facing invariant: chrome must present the same
identity that the underlying authoritative event or row already provides. The
fix must not invent a second worktree heuristic or a second Dispatch numbering
scheme.

## Reproduced failures

### Codex worktree activity (#658)

The shared extractor understands legacy Codex records such as
`exec_command_end`, `local_shell_call`, and JSON `function_call` arguments.
Codex 0.149.x rollouts instead carry the useful evidence in:

- `session_meta.payload.cwd` and `payload.git.branch`;
- `turn_context.payload.cwd`;
- `event_msg` / `thread_settings_applied.thread_settings.cwd`;
- `event_msg` / `item_completed.item.type === "CommandExecution"`, whose cwd
  is commonly a local `file://` URL; and
- `event_msg` / `item_completed.item.type === "FileChange"`, whose changed
  absolute paths are object keys.

Because those records currently emit no activity events, both the live tracker
and the compact historical index miss current Codex worktree evidence. The
compact index is derived from provider transcripts and caches by transcript
mtime/size, so changing parser behavior also requires a schema-version bump;
otherwise unchanged transcripts keep their old empty parse indefinitely.

Claude is not reproduced as broken. Its current transcript contract still
uses explicit last-wins `worktree-state` records with `worktreePath` and
`worktreeBranch`, plus top-level conversation `cwd`. The shared extractor
change must preserve and regression-test that contract.

### Dispatch pane coordinates (#659)

`buildVisibleDispatchRows` assigns the labels visible in Dispatch after final
scope, pinned-row, nesting, project, grid, and detached ordering. In Global
Dispatch those numbers deliberately remain global across project groups. The
pane renderer discards that label and calls `paneLabelForSession`, which uses a
different tab-local grid-plus-detached ordering. A session can therefore be
`D23` in the index and `D12` in its header.

Both Classic and Tiled Dispatch have the canonical row in hand before calling
`renderWorkspaceLeaf`; the normal tile tree does not and should keep its
tab-local pane coordinate.

## Implementation

### 1. Normalize provider paths at the shared matching boundary

Teach the shared path normalizer to convert local `file://` URLs into decoded
filesystem paths before longest-root worktree matching. Keep ordinary absolute
paths unchanged and preserve the existing trailing-slash normalization.

WHY at matching rather than only in one Codex record parser: every live and
historical consumer already converges on `matchWorktree`. Provider formats can
surface URLs in more than one event shape; normalizing at the boundary prevents
one new extractor from working while another silently fails to match the same
path representation.

### 2. Extract current Codex rollout evidence without parsing arbitrary input

Add explicit adapters for the current record shapes listed above. Treat
session/turn/thread cwd as low-weight location evidence, completed command cwd
as classified command evidence, and changed absolute paths as write evidence.
Support both the observed FileChange object form and a defensive array form
without attempting to interpret arbitrary MCP arguments or free-form
`custom_tool_call` JavaScript.

WHY explicit shapes: an MCP tool argument named `cwd` may describe a child
agent or another target, not the current agent. Broad recursive path mining
would create confident false attribution. Completed provider items are the
bounded authority for work performed by this session.

### 3. Rebuild the derived historical index and prefer active live placement

Bump the worktree-activity index schema through one exported constant and use
it everywhere an index file is constructed. Version mismatch intentionally
drops only derived metadata; raw provider transcripts remain the source of
truth and are reparsed on refresh.

For the Worktrees live-agent projection, choose
`workActivity.active.worktreePath` before accumulated `workContext` and launch
cwd. `primary` remains useful as the agent's weighted historical affinity, but
the panel question is where the running agent is active now. This ordering must
not mutate tracker scoring or erase the historical primary context.

### 4. Carry the visible Dispatch label into pane chrome

Allow `renderWorkspaceLeaf` to receive an optional surface-owned pane label.
Classic Dispatch passes `activeRow.label`. Tiled Dispatch keeps the whole
resolved row identity, including `label`, and passes that label for each lane.
The normal `TileTree` call omits the override and continues using
`paneLabelForSession`.

WHY pass the row value instead of recomputing from workspace state: the row is
already the source used for the selector visible beside the pane. Rebuilding
the list inside leaf rendering would duplicate ordering, do unnecessary work,
and make the header vulnerable to drifting from the exact scoped row selected
by the parent surface.

## Regression coverage

- Shared extractor tests for current Codex session, turn, thread-settings,
  completed command, and FileChange records.
- Matching coverage for decoded local file URLs and longest nested worktree
  selection.
- Claude enter/exit and conversation-cwd coverage to protect the shared path.
- Historical parser coverage proving modern Codex JSONL yields compact events.
- Index-version coverage proving parser-semantics invalidation is centralized.
- Worktrees live-agent coverage proving latest active context wins over a
  different accumulated primary context.
- Renderer/selector coverage proving a global `D23` row survives tiled lane
  resolution and is used by leaf chrome, while ordinary grid rendering retains
  its tab-local coordinate.

## Verification

Run the focused unit, system, and renderer regressions first. Then run the
repository typecheck, test-contract check, full deterministic test suite, and
package/build verification if the focused results are clean. Review the final
diff for unrelated changes, confirm the branch worktree is clean, synchronize
both issues in a single resolving PR, and do not merge without explicit user
confirmation.

## Out of scope

- Changing Dispatch numbering semantics or pinned-row labels.
- Replacing the tracker primary-score model.
- Mining arbitrary prompts, MCP payloads, or assistant text for filesystem
  paths.
- Migrating provider transcript files or persisting transcript content in the
  activity index.
- Claiming a Claude regression without a reproducible unsupported record.
