# Agent Coordinate Bang Navigation

> Status: ready for implementation.

## Goal

Extend the command palette's existing agent-coordinate navigation so an exact
query such as `A2!` means **show agent A2 in the currently focused Tiled
Dispatch lane**, even when another lane already renders that same agent.

The existing `A2` behavior remains unchanged: it prefers an already-rendered
copy and focuses that view rather than replacing the user's current lane.

## Why this is a separate intent

Tiled Dispatch deliberately permits the same live agent to appear in multiple
lanes. Those views mirror one session; they do not clone, resume, restart, or
otherwise create a second provider process. That capability is useful when a
large fleet is open and the user wants to curate a particular set of nearby
lanes without being teleported to a copy that happens to be open elsewhere.

The ordinary coordinate command and the bang form therefore express different
navigation intents:

- `A2` — reuse an existing visible slot when possible.
- `A2!` — keep the current Tiled Dispatch lane as the destination and show A2
  there, even if doing so creates another mirrored view of the same session.

This distinction must be explicit in the navigation domain rather than inferred
from the raw query inside a component. Otherwise the palette becomes a second
workspace-layout authority and future entry points cannot request the same
behavior without copying palette syntax.

## Product semantics

### Tiled Dispatch

1. Resolve `A2` through the same canonical visible-label ordering used by the
   Dispatch index.
2. For `A2!`, ignore other lanes that already render A2.
3. Replace only the currently focused lane's `selectedSessionId` with A2.
4. Keep `focusedLane`, every other lane, lane ratios, and the underlying live
   provider session unchanged.
5. If the target crosses a project-scoped Dispatch boundary, preserve the
   existing navigation rule that promotes the scope to global so the layout's
   healing effect cannot reject the newly selected lane.
6. If the target is hibernated, wake it before committing the visible layout.

### Other workspace surfaces

Grid, Tiled Tabs, and classic Dispatch have no equivalent “focused Tiled
Dispatch lane” slot. There, `A2!` intentionally degrades to the ordinary `A2`
navigation behavior. This makes the syntax safe from every surface while
keeping its special placement effect narrowly scoped to the mode that can
represent mirrored agent views.

### Labels and terminals

The bang is command-palette syntax, not part of workspace identity. The
canonical label resolver continues to accept only coordinates such as `A2`.
The palette parser removes one optional trailing `!` and passes the normalized
coordinate to that resolver.

Terminals continue to occupy label positions but are not agent-coordinate
destinations. Pinned `★1` labels remain outside this feature.

## Design

### 1. Parse palette syntax at the palette boundary

Add a small typed parser beside the transient agent-index command builder. It
returns the canonical coordinate plus one of two explicit navigation intents.
It accepts only an exact, case-insensitive coordinate with an optional single
trailing bang. Inputs such as `A2!!`, `A0!`, or prose containing `A2!` remain
ordinary palette search text.

WHY here: `resolveAgentPaneLabel` defines workspace coordinates shared by grid
and Dispatch. Teaching it about punctuation from one UI would collapse identity
and invocation syntax into the same layer.

### 2. Thread intent through the workspace action

Extend `focusAgentByPaneLabel` with a typed intent argument that defaults to the
current reuse behavior. Preserve its wake-before-commit and positional
re-resolution protections. Both the initial calculation and commit-time
calculation must receive the same intent.

WHY an explicit argument: the workspace action owns async wake and atomic
commit. Reimplementing either in the palette would make `A2!` less safe than
`A2`, especially when a close or reorder changes the meaning of A2 while the
target wakes.

### 3. Add one reducer branch for forced lane placement

Extend `navigateToAgentIndexTarget` with the typed intent. In visible Tiled
Dispatch, the forced intent skips the search for an existing target lane and
uses the clamped current `focusedLane` as the destination. All other modes keep
the current reducer path unchanged.

WHY in the pure reducer: lane replacement, scope promotion, and preservation of
unrelated layout state are workspace invariants. Keeping the mutation pure
makes those invariants exhaustively testable without rendering the palette.

### 4. Present the distinction clearly

The transient palette row for `A2!` should say `Open A2 Here`, while `A2`
continues to say `Go to A2`. Its description must state that it mirrors the
same running session in the focused Tiled Dispatch lane and does not create or
restart an agent.

Transient coordinate rows remain excluded from command history and starring;
their IDs are per-session destinations, not stable catalog commands.

## Verification

Add focused coverage for:

- parsing plain, bang, case-insensitive, trimmed, and malformed queries;
- the ordinary intent still focusing an existing Tiled Dispatch lane;
- the bang intent replacing only the focused lane when another lane already
  shows the target;
- preservation of focused lane, ratios, unrelated lanes, and provider session
  metadata;
- cross-project scope promotion under forced placement;
- command title/description and delegation of the typed intent;
- wake failure leaving layout unchanged for the forced intent;
- non-Tiled-Dispatch fallback remaining equivalent to ordinary navigation.

Run the focused unit and renderer suites first, then the repository typecheck
and deterministic test gate. Finish by inspecting the diff and confirming the
superproject worktree is clean apart from the intended commits.

## Out of scope

- Cloning or resuming a second provider session.
- Changing how Dispatch labels are numbered.
- Making terminals addressable through agent-coordinate syntax.
- Adding bang semantics to pinned `★N` labels.
- Reworking Tiled Dispatch's existing support for mirrored agent views.
- Adding a general-purpose palette grammar for other punctuation commands.

