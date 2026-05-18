# Issue 152: Add terminal sessions to Dispatch Mode

## Issue summary

GitHub issue #152 asks for terminal sessions to become first-class rows in Dispatch Mode. Today Dispatch is an agent command surface: Claude/Codex sessions can appear as grid rows, detached rows, and pinned rows, while terminals are either ordinary grid leaves or a special opt-in project terminal column.

The desired behavior is that terminals appear in the Dispatch list alongside agents, are visually distinguishable, can be selected/focused by mouse and keyboard, can be attached back to the grid when they are detached, and do not expose Claude/Codex-only actions.

## Current behavior and relevant files/functions

- `src/renderer/src/workspace/dispatch/dispatchSelectors.ts`
  - `buildDispatchGroups(state)` is the main Dispatch row builder. It currently excludes terminals from grid rows with `collectLeaves(tab.root).filter(sessionId => state.sessions[sessionId]?.kind !== 'terminal')`.
  - `detachedDispatchSessionIdsForTab(state, tabId)` also excludes terminals with `state.sessions[entry.sessionId]?.kind !== 'terminal'`.
  - `buildPinnedDispatchRows(state)` excludes terminals from pins. This should remain agent-only unless the product explicitly decides that terminals can be favorites.
  - `findTerminalSessionInTab(tab, state)` finds the first terminal leaf in a tab for the current right-hand project terminal column. This is separate from Dispatch row construction and is part of the reason terminals are not rows today.
  - `DispatchAgentRow.kind` already uses `SessionKind | undefined`, so the row type can represent `kind: 'terminal'` without widening the type.

- `src/renderer/src/workspace/dispatch/DispatchLayout.tsx`
  - The left list is built from `buildPinnedDispatchRows` plus `buildDispatchGroups`.
  - `activeRow` is rendered through `renderWorkspaceLeaf(...)`. Because `renderWorkspaceLeaf` already dispatches `kind === 'terminal'` to `TerminalLeaf`, a terminal row can render in the main Dispatch detail pane without a new renderer.
  - `DispatchAgentBadge` already maps `kind === 'terminal'` to `Terminal`, but the current selector filters mean that branch is effectively unreachable for normal Dispatch rows.
  - The header says `Agents`, empty state says `no agents in this dispatch scope`, and component/type names are agent-specific. These labels should be neutralized if terminals are included.
  - `terminalVisible = settings.dispatchProjectTerminal` mounts a separate project terminal column and calls `workspace.ensureDispatchTerminal(activeTab.id)`. This is an opt-in companion terminal, not a row source.

- `src/renderer/src/workspace/tile-tree/TileTree.tsx`
  - `renderWorkspaceLeaf(sessionId, focusedSessionId, workspace, tabId, ...)` already renders terminals via `TerminalLeaf`.
  - This means the detail-pane part of Dispatch should work once row selection points at a terminal.

- `src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx`
  - Owns xterm attach/backfill/focus/resize behavior.
  - It expects a meaningful `focused` prop to focus xterm on selection changes, and `onFocusRequest` to keep workspace focus aligned on clicks.
  - Dispatch currently passes `focusedSessionId = activeRow.sessionId`, so a terminal rendered as the active row should get `focused={true}` and focus xterm.

- `src/renderer/src/workspace/tile-tree/useKeybinds.ts`
  - `dispatchRows(workspace)` currently returns `flattenDispatchRows(buildDispatchGroups(workspace.state))`, so cmd-number and option-arrow Dispatch navigation inherit selector filtering.
  - Pinned rows are missing from this helper today even though `DispatchLayout` prepends pinned rows. That is pre-existing, but if terminal rows are added this is a good time to decide whether keyboard numbering should use the exact visible list, including pins, to avoid further drift.

- `src/renderer/src/workspace/hook/selectors/commandTargetSessionId.ts`
  - Command targeting in Dispatch resolves the visible row through `buildDispatchGroups` and `selectVisibleDispatchRow`.
  - Once terminals enter `buildDispatchGroups`, global command targets can be terminal sessions. This is desirable for close/focus/debug, but agent-only commands must keep explicit kind guards.

- `src/renderer/src/workspace/hook/actions/pane.ts`
  - `closeFocused()` already resolves the visible Dispatch row and delegates to `closeSession(targetId)`. This should work for grid terminals once the row exists.
  - `closeSession(targetId)` supports both owning grid tabs and detached records, kills the backend, clears runtime/state, and updates Dispatch focus after removal.
  - `attachDetachedToGrid(sessionId, target)` and `attachAllDetachedForTab(tabId)` are placement-only state moves. They are not agent-specific except for naming and the selector feeding bulk attach.
  - `detachFocusedToDispatch()` explicitly refuses terminals with a toast: `Terminals cannot be detached to Dispatch`. This is now in conflict with #152 if terminals should be detachable rows.
  - `requestBuryFocused()` can open the bury prompt for any command target, including terminals after this change. `buryFocused()` handles any grid leaf kind. This is probably acceptable if "bury/detach if applicable" includes terminals, but the UI text is pane-oriented and should be verified.

- `src/renderer/src/workspace/hook/actions/dispatch.ts`
  - `ensureDispatchTerminal(tabId)` creates an opt-in terminal as a normal tile-tree leaf, then DispatchLayout renders it in the separate right column.
  - `focusDispatchSession(tabId, sessionId)` intentionally writes only `activeTabId` and `dispatchMode.focusedSessionId`, not `Tab.focusedSessionId`. That is correct for detached rows and should remain correct for terminal rows.
  - `pinSession`, `setPinnedSessionIds`, and related comments enforce "pins are agents, not terminals."

- `src/renderer/src/workspace/queries.ts`
  - `resolveTabSessions(state, tabId)` includes grid terminals because grid IDs are all leaves, but excludes detached terminals. Its comment says terminals are always grid by design and Dispatch never holds a terminal. That comment and filter become stale if detached terminal rows are allowed.
  - Reader/Spotlight non-Dispatch views inherit this resolver; adding detached terminals here may make terminals appear in surfaces that are not agent-oriented.

- `src/renderer/src/features/workspace/commands/*.ts`
  - Many agent-only commands already guard `kind === 'claude' || kind === 'codex'`: View Prompts, Rewind, built-in MCP reloads, Reload Agent, Soft Reload Agent, Copy Resume Command, Duplicate Agent, Switch Provider, Linked Agent.
  - Pane commands that should continue to work for terminals are Close Pane, Bury Pane if accepted, New Terminal Right/Below, Debug Panel toggles, and Save Debug Logs.
  - `attach-detached-to-grid` currently uses `isDetached(...)` only and would show for detached terminals if terminals are allowed in `detachedSessions`. That is probably correct, but title/description should say "session" rather than "agent."
  - `detach-to-dispatch` currently hides terminals via `meta.kind !== 'terminal'` and the action also refuses them.

- `src/main/sessionManager.ts` and `src/shared/runtime/terminalSession.ts`
  - Main already has a terminal session model with PTY/tmux lifecycle, raw terminal data buffering, attach replay, resize, write, kill, and process telemetry.
  - There is no missing main-process primitive for Dispatch terminal rows. The feature is mostly renderer state/query/action policy.

## Proposed implementation plan for terminal rows

1. Rename or broaden the Dispatch row vocabulary where it directly affects product copy.
   - Keep type names if a broad rename is too much churn, but change visible text from `Agents` to `Sessions`, `no agents in this dispatch scope` to `no sessions in this dispatch scope`, and attach/close toasts where they would lie for terminals.
   - Add a thick WHY comment wherever an "agent" name remains intentionally internal to avoid broad churn.

2. Add terminals to the Dispatch row builder.
   - Remove the terminal exclusion from `gridSessionIds` in `buildDispatchGroups`.
   - Decide whether `detachedDispatchSessionIdsForTab` should include terminal records. If terminal detach-to-dispatch is part of v1, remove the terminal exclusion there too. If v1 only shows grid terminals, keep it excluded and document that detached terminals are a follow-up.
   - Preserve pinned exclusion for terminals unless there is a separate product decision to pin terminals. Pins are currently described as favorite agents, and the reducers/sanity effect enforce that.

3. Make terminal rows visually distinct.
   - Reuse the existing `DispatchAgentBadge` `Terminal` branch as the baseline.
   - Consider a terminal-specific subtitle that does not depend on agent runtime stream phase. For example: `shell`, `running`, `exited`, or cwd basename.
   - Avoid showing unread/attention badges for terminals unless terminal output is intentionally tracked as unread. TerminalLeaf acknowledges on data input, but terminal sessions do not produce provider conditions.

4. Make the visible row list the single keyboard source of truth.
   - Update `useKeybinds.ts` `dispatchRows(workspace)` to mirror `DispatchLayout` if pins should count in cmd-number/option-arrow navigation: `buildPinnedDispatchRows(state)` plus `flattenDispatchRows(buildDispatchGroups(state))`.
   - If pins remain separate from keyboard numbering, add a WHY comment explaining the divergence because the layout comment currently says pinned rows participate in keyboard dispatch.
   - Terminal rows should then automatically work for cmd-number and option-up/down because the navigation code only needs `row.tabId` and `row.sessionId`.

5. Decide terminal detach policy and implement it explicitly.
   - If terminals should be detachable to Dispatch: remove the terminal refusal from `detachFocusedToDispatch()`, update `detach-to-dispatch.when`, and rewrite comments/toasts to say session/pane rather than agent.
   - If terminals should only appear when grid-attached: keep the refusal, but the issue acceptance criterion "Terminal sessions can be attached back into the grid where appropriate" suggests detached terminal support is expected.
   - For detached terminals, `attachDetachedToGrid()` should work as-is because it only moves session IDs between `detachedSessions` and the target tile tree.

6. Keep the opt-in project terminal column separate from terminal rows.
   - The project terminal column is a convenience terminal per active project. Terminal rows are user-created terminal sessions.
   - If terminal rows include the same `ensureDispatchTerminal`-created leaf, the right column and main pane can show the same session at once. That is technically possible but creates duplicate xterm attach/focus/resize contention.
   - Recommended v1 policy: when terminal rows are enabled, either exclude the auto project-terminal leaf from the row list while `dispatchProjectTerminal` is on, or remove/deprecate the separate project terminal column. Excluding it is smaller, but it needs an explicit marker to distinguish auto terminal from ordinary terminal leaves; today there is only `kind: 'terminal'`.

7. Audit secondary surfaces that consume Dispatch selectors.
   - `commandTargetSessionIdForState` will begin returning terminals. Agent-only commands mostly guard correctly today, but run through all command definitions and debug panels.
   - `ReaderView` and `SpotlightView` use `dispatchSessionIdsForTab` in Dispatch. If terminal rows enter that selector, Reader may open a terminal in a reading surface, which is probably not useful. Spotlight can render terminals fine because it uses `renderWorkspaceLeaf`.
   - `resolveTabSessions` comments and filters need updating if detached terminals become real.

## Agent-only actions that should be disabled or hidden for terminals

These should stay hidden through `kind === 'claude' || kind === 'codex'` guards:

- View Prompts
- Rewind to Prompt
- Reload Agent
- Soft Reload Agent
- Copy Resume Command
- Duplicate Agent
- Switch Provider
- Linked Agent
- Enable Built-in MCP Ping
- Enable AI Workspace MCP
- Enable Orchestration MCP
- Copy Assistant picker / assistant-message commands
- Copy Code Block picker when it assumes rendered feed code blocks
- Reader Mode, unless the product intentionally wants a terminal-in-reader fallback
- Pin Agents, unless the product changes pins from "agent favorites" to "session favorites"

These should work for terminals:

- Focus/select row
- Close Pane / close Dispatch row
- Attach Detached Session To Grid, if detached terminal rows are allowed
- Attach All Dispatch Sessions For Tab, if detached terminal rows are allowed
- Bury Pane / revive / kill buried, if the product accepts burying terminals
- New Terminal Right / Below
- Debug Panel, HTML Debug Panel, Save Debug Logs where those panels handle terminal runtime data gracefully

## Risk areas and open questions

- Duplicate terminal rendering: the existing `dispatchProjectTerminal` column can mount `TerminalLeaf` for the same terminal that a Dispatch row would render in the main pane. xterm attach/backfill can handle multiple mounts better than it used to, but both panes resize the same PTY and both can fight for focus. This needs a product decision before implementation.

- Detached terminal lifecycle: current comments and filters encode "terminals are always grid by design." Allowing terminal detach means updating selectors, docs/comments, toasts, attach-all copy, and any assumptions in persistence/autosave.

- Command targeting expansion: adding terminals to `buildDispatchGroups` makes `commandTargetSessionId` return terminals in Dispatch. Most agent-only commands are guarded, but any command that assumes transcript/feed data through a generic focused session should be checked.

- Reader Mode: terminals are not meaningful in Reader Mode. Because Reader uses `dispatchSessionIdsForTab`, terminal rows could become selectable unless Reader filters to agent kinds.

- Pin behavior: code and copy are strongly agent-only. Keep terminals out of pins for v1 unless "pin sessions" is explicitly desired.

- Auto project terminal identity: if the separate Dispatch terminal column remains, there is no metadata flag that says "this terminal was auto-created for Dispatch." Without that, selectors cannot cleanly exclude only the project terminal while including user-created terminal leaves.

- Naming churn: many symbols are named `DispatchAgent*`. A full rename would be broad and risky. Prefer visible-copy fixes plus comments unless the implementation already needs to touch most of the files.

## Suggested tests/manual verification

- Add selector tests for `buildDispatchGroups`:
  - grid Claude + grid terminal both produce rows in tab order;
  - terminal row has `kind: 'terminal'`, correct label/index/tabId/sessionId/title;
  - pinned terminal is ignored by `buildPinnedDispatchRows`;
  - detached terminal inclusion/exclusion matches the chosen v1 policy;
  - `dispatchSessionIdsForTab` returns the chosen terminal set.

- Add command-target tests for `commandTargetSessionIdForState`:
  - Dispatch focused terminal returns the terminal session id;
  - stale focused id falls back to the visible terminal/agent row the UI would highlight.

- Add keyboard/manual checks:
  - enter Dispatch with a grid terminal present;
  - terminal appears in the list and has a distinct Terminal badge;
  - click row focuses terminal and keystrokes go to xterm;
  - cmd-number selects terminal row;
  - option-up/down moves across agent and terminal rows;
  - close row kills terminal and moves selection predictably;
  - if detached terminals are allowed, detach terminal to Dispatch and attach it back to the grid.

- Manual regression checks:
  - agent-only palette commands are hidden for a focused terminal row;
  - Close Pane, Debug Panel, Save Debug Logs still behave for terminal rows;
  - the project terminal column does not duplicate/fight with the selected terminal row;
  - reload/restart with tmux-backed terminals still recovers expected grid/detached placement.

## Size estimate

Medium.

The core row inclusion is small because `TerminalLeaf`, session spawning, IPC attach/backfill, close, resize, and basic focus already exist. The feature becomes medium because Dispatch selectors are reused by keyboard navigation, command targeting, Reader/Spotlight, pinning, attach/detach, and lifecycle actions. The main risk is not rendering a terminal row; it is keeping agent-only actions and the existing project-terminal column from creating confusing or unsafe behavior.
