# Agent Management targets agents by the label and name the user sees — Implementation Plan

**Goal:** Ship issue #1145. An agent told "send a prompt to B28" or "read
Apollo" can act on that exact agent through the Agent Management MCP, the
label/name are visible in list/read output, and anything unresolvable or
ambiguous is refused before any wake or write.

**Working tree:** `.worktrees/agent-management-label-targeting`, branch
`fix/agent-management-label-targeting`, based on `origin/main` (`672d0941`).

---

## Evidence (read before changing the design)

Real session 2026-09-23 02:58–03:05 UTC (transcript `984461bf-…`, agent-code
project), plus the live `~/.config/agent-code/workspace.json` at 03:10 UTC,
recorded (sanitized) as
`testing/fixtures/workspace-v2/2026-09-23-agent-labels.sanitized.json`.

- `list_agents` returned 25 agents with no label and no name. `send_prompt`
  takes only `sessionId`, so "b33" could not be mapped to anything.
- `ac_agents_search {label:"B33"}` → 0. `{provider:"codex"}` → `B5`, `B16`, `B28`.
  Recomputing the labels from the recorded file with the `buildDispatchGroups`
  rules gives exactly `B5`/`B16`/`B28` for the three Codex sessions. At the
  time of the search, no session was labelled `B33`.
- `ac_agents_create {anchorSessionId: f01b909a…}` → "Agent does not exist in
  this window". The recorded file maps the caller's transcript to session
  `89937a95…`. Enabling root_management reloaded the caller through
  `replaceSession`, which gives it a new launch-local id. The model reused its
  pre-reload id from its own earlier `list_agents` output. The retry "anchored
  on another agent" was actually the caller itself under its new id.
  **Not a bug in `agents.create`**. The refusal was correct, and the fix is to
  tell the model that ids go stale.

## What a label is (source of truth)

`buildVisibleDispatchRows(state)` (`workspace/dispatch/dispatchSelectors.ts`)
is the ONE row stream. `DispatchAgentList`, `DispatchMiniList` and the tiled
lane `paneLabel` all render `row.label`, and `workspace.observe` publishes it
as `displayLabel`. The format is `<project letter><global row number>`:

- the number counts across **every** project in order (`B5` = 5th row
  overall, in project B);
- terminals and extension views take numbers too, although Agent Management
  filters them out of its list;
- pinned sessions leave the numbering and render as `★N`;
- closing, pinning or adding an earlier row renumbers every later row.

So a label is a live screen coordinate, not an identity. It is correct to
resolve it **at the moment the request is handled, against the same live
state the operation then runs on**. That is what the user is looking at. It is
wrong to cache a label→id mapping from an earlier `list_agents` call.

`resolveAgentPaneLabel(state, label)` (`tile-tree/paneLabels.ts`) is the
app's resolver for this (⌘-palette jump, agent-index navigation). It matches
the row label first, then a pane-local fallback. `observeWorkspace` only
advertises a fallback label when `resolveAgentPaneLabel` maps it back to the
same session, so for every `[A-Z]+N` label:

    resolveAgentPaneLabel(state, L)?.sessionId === X  ⇔  displayLabel(X) === L

`ac_agents_search {label}` matches `displayLabel`, so it agrees with
`resolveAgentPaneLabel` by construction. Agent Management reuses both halves
and doesn't re-derive either.

## Design

### 1. One `displayLabel` derivation (refactor, no behavior change)

Move the `displayLabel` rule out of `observeWorkspace`'s closure into
`sessionDisplayLabel(state, sessionId, rows)` beside `resolveAgentPaneLabel`
in `paneLabels.ts`. `observeWorkspace` and Agent Management both call it.
`rows` is passed in because `buildVisibleDispatchRows` is O(sessions) and both
callers already hold one.

### 2. Records carry `displayLabel` and `agentName`

`ManagedAgentRecord` gains `displayLabel: string | null` (always present, so
"no label" is explicit rather than absent) and `agentName?: string` (only when
the Agent names setting is on and the agent has a name, via `resolveAgentName`,
the same rule as the header and `workspace.observe`). The renderer handler
passes `{ enabled: settings.agentNamesEnabled, names: workspaceAgentNames }`
from the same store snapshot as the state it reads.

### 3. One target resolver, in the renderer

`resolveManagedTarget({ state, callerSessionId, target, agentNames })` in
`agentManagementMcp.ts`:

- `target` is exactly one of `{ sessionId }`, `{ label }`, `{ name }`.
- label → `resolveAgentPaneLabel`. No match → `label_not_found`. The message
  lists the labels the caller's project currently shows, so the model can
  ask the user instead of guessing (the 02:58 session had to list raw UUIDs).
- name → `normalizeAgentName` equality over `resolveAgentName`, the same
  comparison `ac_agents_search {name}` makes. 0 → `name_not_found`
  (including "names are off"). More than 1 → `name_ambiguous`, with the
  candidates. Names are allocated uniquely, but a reload briefly carries the
  identity to a new session, so this can't be assumed impossible.
- The resolved id then goes through the unchanged `assertManagedTarget`, so a
  label in another project is `agent_not_in_project` and a label on a terminal
  is `agent_not_found`. Project authority is still enforced in one place.

The resolver runs in the renderer because only the renderer has the row
stream and the names map. Main forwards `label`/`name` untouched. After a
wake (`send-prompt`), re-authorization uses the **resolved id**, never a
re-resolution. A label that renumbers during the wake must not retarget the
prompt.

### 4. MCP surface

- `read_agent`, `send_prompt`, `close_agent`: `sessionId` becomes optional,
  plus `label` (same regex as `ac_agents_search`) and `name`. Exactly one is
  required; the MCP handler refuses zero or several as `invalid_target`
  before calling the bridge. Zod raw shapes cannot express "exactly one of",
  and a `.refine` would make the whole input an effects schema the SDK does
  not publish as properties.
- `read_agents`: `labels` / `names` arrays next to `sessionIds`. They are
  unioned after resolution and de-duplicated by resolved id.
- Results already echo the resolved identity (`output.agent` for reads,
  `sessionId` for send, `closedSessionId` for close). `send_prompt` and
  `close_agent` also return `displayLabel` so the caller can confirm to the
  user which agent it hit.
- `close_agent` accepts labels too. It still goes through the forced
  confirmation dialog, which is the human check, and the dialog names the
  target by title.

### 5. Instructions

- Agent Management: labels and names are what the user sees. Pass them
  straight through and don't translate them yourself. They are resolved when
  the call is made and can shift between calls.
- Root management: replace "never pane labels" with "resolve a visible label
  or spoken name with ac_agents_search, then act on the returned sessionId".
  Add: session ids change when an agent reloads (including the reload that
  enabled this capability), so don't reuse ids from earlier in the
  conversation.
- `agents.*` `requireSession` refusal text gets the same hint. This is the
  refusal the 03:04 call received.

### Out of scope (documented, not built)

- Pinned `★N` labels are not accepted as targets: the label regex, the
  palette resolver and `ac_agents_search` all reject them today, and widening
  one surface alone would split the rule. Pinned agents still list with
  `displayLabel: "★N"` and can be targeted by `sessionId` or `name`.
- A stable cross-reload agent identity is a separate, larger change.

## Tests (from recorded shapes)

- `agentManagementMcp.labels.test.ts` on the recorded 2026-09-23 file, loaded
  with `liveWorkspaceFromPersisted`:
  - list records carry the same `displayLabel` that `observeWorkspace`
    computes. The Codex agents are `B5`/`B16`/`B28`, and the numbering skips
    over the interleaved terminals and extension views.
  - `{label:'b28'}` resolves to the session `ac_agents_search {label:'B28'}`
    would (same displayLabel equality), case-insensitively.
  - `{label:'B33'}` → `label_not_found`, and the message lists the project's
    labels. A label in another project (`C30`) → `agent_not_in_project`. A
    terminal's label → `agent_not_found`.
  - Names: a name map attached to the recorded `agentNameId`s resolves
    exactly, refuses when the setting is off, and refuses a duplicated
    identity as ambiguous.
  - Relabel race: closing an earlier row changes which session `B28` resolves
    to. This pins down that resolution is live, not cached.
- `createBuiltInMcpServer.test.ts`: `label`/`name` reach the bridge
  unchanged, zero or two target fields → `invalid_target` without a bridge
  call, and the root instructions no longer say "never pane labels".

## Verification

`npx tsc -b` (both projects) and targeted vitest on Node 24. The app is never
launched.
