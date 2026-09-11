# New Agent In… — spawn a Dispatch agent into a chosen project

**Issue:** #852
**Branch:** `feat/new-agent-in-project` (worktree `.worktrees/new-agent-in`, from `origin/main` @ `48ea6912`)

## Problem

Filling empty Grid Dispatch lanes needs a navigational detour. When the focused
lane is empty and its row is not bound to a project, `resolveDispatchSpawnTarget`
(`workspace/dispatch/dispatchSelectors.ts`) files a new agent under the classic
Dispatch focus (the last agent selected) or `activeTabId`. To put an agent for
project C into an empty lane, the user first selects *some existing agent in
project C* purely to move "the current project", returns to the empty lane, then
runs **New Agent…**. Five fresh lanes means five detours.

## What already exists (do not rebuild)

- `createDetachedDispatchAgent(selection, { tabId, anchorSessionId })`
  (`workspace/hook/actions/pane.ts`) spawns into an explicit project, borrows
  `cwd` from the anchor session, and still places the agent into the focused
  lane (`laneIndex` stays focus-derived — the override only names the project).
  The Dispatch project header's "+" and the external `agents.create` control
  capability both use it.
- `AGENT_PROVIDER_CHOICES` (`workspace/providerChoices.ts`) is the shared
  Claude / Codex / OpenCode / OpenCode Terminal choice list.
- `ProviderSwitchPickerModal` is the house pattern for a keyboard-driven
  provider list inside the shared `DialogContent` primitive.

## Decisions (approved in chat)

1. **Dispatch only** (`surface: 'dispatch'`). In the grid a project is a tab one
   keystroke away, and a detached agent spawned from the grid is invisible there.
   Also hidden under Tiled Tabs (mirrors `new-agent`): Tiled Tabs covers Dispatch,
   so a lane spawn would land somewhere the user cannot see.
2. **Row bindings restrict the project list.** If the focused lane's row is bound
   to projects, only those are offered — the binding contract (see
   `resolveDispatchSpawnTarget` and `DispatchRowProjectModal`) says a row's index
   only lists its bound projects. Unbound rows / classic Dispatch offer every
   project. The bound-set lookup is extracted into one selector shared with
   `resolveDispatchSpawnTarget` so the list and the spawn resolver cannot disagree.
3. **Projects with no anchor are listed, disabled, with a reason** — not omitted.
4. **No default keybinding.**
5. **Initial highlight** on the project step is the project plain New Agent…
   would have used (`resolveDispatchSpawnTarget(state).tabId`) when it is
   eligible, so Enter-Enter lands in the same project as today. (Same project,
   not necessarily the same directory: the anchor is the project's first
   session with a cwd — its own checkout — never the focused/last-selected
   agent's worktree, because removing focus from the decision is the point.)
6. **A dedicated dialog**, not a fifth mode on `NewAgentPlacementOverlay` (already
   four intents; its "kind picked ⇒ placement step" invariant would need another
   branch) and not a palette sub-mode (`CommandPalette.tsx` is 2.5k lines and each
   mode threads ~6 ternary chains; the two-step choice would also need store state).

## Units

| Unit | File | Purpose |
|---|---|---|
| Bound-projects selector | `workspace/dispatch/dispatchSelectors.ts` | `focusedLaneBoundProjectTabIds(state)` — the focused Tiled Dispatch lane's row binding, `[]` when unbound/classic. `resolveDispatchSpawnTarget` switches to it. |
| Project model | `features/workspace/lib/newAgentInProjects.ts` | Pure: eligible projects (tab order, A/B/C labels from the full tab list), anchor per project (first session of `resolveTabSessions` with a cwd — same order the header "+" uses), disabled reason, initial tab id. |
| Dialog | `features/workspace/ui/NewAgentInDialog.tsx` | Two steps: agent → project. ↑/↓ (+ Ctrl-N/P), Enter, click, Backspace back, Esc/Cancel. Commit latch. Calls `createDetachedDispatchAgent`. Derives nothing while closed. |
| Surface | `features/workspace/surfaces/NewAgentInSurface.tsx` + `app/surfaces/registry.tsx` | Mount; appended at the END of `modalSurfaces` per the registry's paint-order contract. |
| Store intent | `app-state/uiShell/{types,slice}.ts`, `app-state/types.ts` | `newAgentInOpen` + `openNewAgentIn` / `closeNewAgentIn`. |
| Command | `features/workspace/commands/paneCommands.ts` | `new-agent-in`, right after `new-agent`; `ui.openNewAgentIn` threaded through `command-palette/types.ts` + `CommandPalette.tsx`. |
| Catalog snapshot | `features/command-palette/catalog.test.ts` | Same commit as the command (the file's own rule). 116 → 117. |
| Control reference | `features/workspace/controlReference.ts` | List `new-agent-in` under the Dispatch feature so operators can point users at it. |

## Tasks

1. **Selector + model (TDD).** Write `newAgentInProjects.test.ts` first:
   unbound → all tabs in order with labels; bound row → only bound tabs; anchor is
   the first session with a cwd, grid leaf before detached; project with no
   session is disabled with reason; initial tab = spawn-target tab when eligible,
   else first enabled. Then implement the selector extraction and the model.
2. **Dialog (TDD).** Write `NewAgentInDialog.renderer.test.tsx` first (pattern:
   `ProviderSwitchPickerModal.renderer.test.tsx`): keyboard two-step commit calls
   `createDetachedDispatchAgent` with `{kind, providerRuntime}` and
   `{tabId, anchorSessionId}`; click path; Backspace returns to agent step;
   disabled project cannot be committed; double Enter spawns once; Cancel never
   commits. Then implement.
3. **Wiring.** Store intent, surface + registry entry, command, palette `ui`
   threading, catalog snapshot, control reference.
4. **Verify once at the end** (Node 24): `npm run typecheck`, `npm test`,
   `npm run test:contract`, `npm run check:keybindings`.

## Review follow-up (after the PR opened)

An independent review found, and this branch fixed:

- **Enter on a focused footer button** (Cancel/Back) was captured by the list
  handler, which prevented the button's click and committed the highlighted
  row — Tab → Cancel → Enter spawned an agent. Footer buttons now own their
  Enter (the `dialog-actions.tsx` rule). `ProviderSwitchPickerModal`, whose
  pattern this copied, had the same bug on `main`: filed as #862 and fixed
  here too.
- A **held Enter** could pick the agent and commit in one press; auto-repeat
  is ignored.
- One-shot state now resets on **close**, not open, so a non-user-event open
  never paints a stale project step.
- The redundant cross-step focus effect was removed (Radix FocusScope already
  refocuses the container when a focused row unmounts).
- The empty project list now says the row's projects are closed and names
  **Row Projects…**. Root cause — `closeTab` leaves row bindings in memory —
  predates this work and is filed as #863 (out of scope).
- Comment accuracy (header "+" anchor differs when its first row is pinned;
  Enter-Enter equivalence is project-level) and a project-scope note in the
  command description.

## Out of scope

- A default chord.
- Changing New Agent… or the header "+" behavior.
- Grid-mode variant.
