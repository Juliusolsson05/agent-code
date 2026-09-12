# Reuse an open project tab on New Tab, and Merge Project Tabs

Status: implemented, tests green, PR #914 open; first orchestrated review (REQUEST CHANGES, B1 modal seeding race) addressed, re-review pending.
PR: [agent-code#914](https://github.com/Juliusolsson05/agent-code/pull/914). Merge requires explicit approval.

Feature Issue: [agent-code#913](https://github.com/Juliusolsson05/agent-code/issues/913).
Branch: `feat/merge-project-tabs`. Worktree: `.worktrees/merge-project-tabs`.
Base: `origin/main` at `c6adfe83` (2026-09-12). This plan is the first commit.

## Outcome

Two related changes that share one rule, "which tabs hold this directory":

1. **Reuse on open.** When the folder typed into the New Tab path picker is
   already held by an open tab, the picker says so and its primary action
   becomes "go to tab"; "new tab anyway" stays available for the deliberate
   second-tab case. A folder nobody holds behaves exactly as today.
2. **Merge Project Tabs.** A command that folds chosen tabs into a target
   tab without touching any process: source grid panes and detached agents
   become Dispatch agents of the target; buried records and Dispatch row
   project filters are re-pointed; tiled-tab, Spotlight and Reader references
   to removed tabs are cleared; the emptied tabs are removed. The modal lists
   what moves before anything happens.

## Why the duplicates exist

`Tab` carries no directory. The tab title is the basename of the folder chosen
at creation, and the only durable link between a tab and a directory is the
`cwd` of the sessions it holds. The operator capability `projects.open`
already treats "an existing tab holds a session with exactly this cwd" as
"this project is open" and reuses it unless `createDuplicate` is explicit.
The path picker predates that decision and always creates. Window adoption
appends a closed window's tabs without root dedupe, so it can leave a
duplicate too. Three `agent-code` tabs on 2026-09-11 were created on Sept 3,
7 and 10 through the picker.

## Design

### The shared rule

`findTabsHoldingDirectory(state, cwd)` in `workspace/queries.ts`: tabs (in
tab order) for which `resolveTabSessions` yields at least one session whose
`cwd` equals the directory exactly. `projects.open` switches to it; the path
picker surface uses it to decide the "already open" affordance. Exact match
only: a worktree is a different directory on purpose, and the merge command
is the tool for folding worktree tabs together.

### Reuse on open

`PathPickerSurface` passes `openTabsForPath(expandedPath)` into the modal.
The modal already tracks `resolvedPath`; when that path is held by a tab, it
shows "Already open as A · agent-code" and renders "go to tab" as the
primary action (activate, no spawn) with "new tab anyway" as the secondary
(the existing `onAccept`). Nothing changes for resume rows: resuming a past
conversation still lands in a new tab, which is a separate decision recorded
as out of scope below.

### The merge planner

`mergeProjectTabs(state, tileTabs, { targetTabId, sourceTabIds, now })` in
`workspace/mergeProjectTabs.ts`, a pure function returning either a refusal
(`target_is_source`, `unknown_tab`, `nothing_to_merge`) or the next state
plus a summary of what moved:

- `tabs`: sources removed, order otherwise preserved.
- `activeTabId`: re-pointed to the target when it named a source.
- `detachedSessions`: every source grid leaf gains a `DetachedSessionRecord`
  under the target (`surface: 'dispatch'`, `detachedAt: now`); records that
  already pointed at a source are re-pointed. `projectTabTitle`/`projectTabIndex`
  reflect the target in the new tab array.
- `buried`: `sourceTabId` re-pointed with the target's title and index.
- `dispatchMode.tiled.rows[].projectTabIds` (and the legacy `projectTabId`):
  sources replaced by the target, deduplicated. Lanes are session-keyed and
  untouched.
- `tileTabs`: sources removed, focus moved, then `sanitizeTileTabsState`
  (which exits tiled tabs below two).
- Spotlight and Reader state that named a source tab are cleared by the hook
  action, because the pane they zoomed is no longer in a grid.

WHY grid panes go to Dispatch rather than into the target's grid: `Tab.root`
must stay a tile tree the user built; attaching every source pane would turn
one tab into a wall of panes, and `buildDispatchGroups` lists detached
sessions under their tab already, so nothing is hidden. The user attaches
what they want afterwards.

WHY there is no undo: no process is killed and no session leaves the
workspace, so the reverse operation is "detach/attach as you like"; an undo
entry would have to snapshot layout state that the undo stack was not built
to hold. The confirmation lists what moves instead.

The invariant the tests pin: `collectOwnedSessionIds` is identical before
and after a merge. A merge that lost a session would have it deleted by the
next autosave.

### Command and modal

- `merge-project-tabs` in `tabCommands.ts`, category `layout-dispatch`,
  surface `app`, visible with two or more tabs, panel-state badge like
  Reorder Tabs. Opens `mergeProjectTabsOpen` on the UI shell.
- `MergeProjectTabsModal`: target selector (default: the active tab), a
  checkbox list of the other tabs labelled `A · title` with the directories
  each holds and its session count, sources pre-ticked when they share a
  directory with the target, a summary line ("2 tabs, 9 agents move to
  Dispatch under E · agent-code"), Cancel / Merge. The surface calls the
  hook action `mergeTabs(target, sources)` which applies the planner and
  toasts the summary.

## Tests

- `mergeProjectTabs.test.ts` (unit): the three-tab fixture with detached,
  buried, tiled Dispatch rows bound to a source, tiled tabs containing a
  source, and a spotlight on a source; asserts every re-pointing above, the
  ownership invariant, the target grid untouched, and the refusals.
- `queries.test.ts` or a new `findTabsHoldingDirectory` case: exact match,
  worktree excluded, tab order.
- `PathPickerModal.renderer.test.tsx`: with a holder, the primary action
  activates and does not accept; "new tab anyway" accepts; without a holder
  the primary action accepts as before.
- Command catalog baseline: 121 commands, 24 approved additions.
- `tsc -b` on both projects, `npm run test:contract`, touched suites green.

## Out of scope

- Resume flows (path picker rows and the Conversations picker) still create
  a new tab; folding a resumed conversation into an existing tab needs the
  detached-agent resume path and is a separate change.
- Window adoption dedupe: the merge command is the cure there.
- Attaching merged panes into the target's grid.
