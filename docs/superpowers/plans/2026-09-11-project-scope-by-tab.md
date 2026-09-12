# Project scope by tab in Switch Agents and Close Old Agents

Status: implemented, tests green, PR open for review.
PR: [agent-code#909](https://github.com/Juliusolsson05/agent-code/pull/909). Merge requires explicit approval.

Bug: [agent-code#908](https://github.com/Juliusolsson05/agent-code/issues/908).
Branch: `fix/project-scope-by-tab`. Worktree: `.worktrees/project-scope-by-tab`.
Base: `origin/main` at `24072148` (2026-09-11). This plan is the first commit.

## Outcome

The **Selected projects** scope in the Switch Agents (bulk provider switch) and
Close Old Agents modals lists projects the way Dispatch does: one entry per
project tab, labelled by the tab letter and title (`A · agent-code`,
`E · agent-code`), in tab order. An agent whose working directory is a worktree
stays under its tab. The working directory remains the secondary line on each
agent row, and each project entry lists the distinct directories it contains so
the worktrees are visible without becoming projects.

## Why the bug exists

Both modals predate Grid Dispatch's project bindings. Close Old Agents (#303,
June) and the bulk switch (June 24) were written when the tab title was the only
project label and was not unique, so they keyed projects by `meta.cwd` and
labelled them by the directory name. Grid Dispatch (#687, #695, late August)
gave every tab a stable letter plus title and made the tab the project
everywhere else. The cwd grouping then became a second, contradicting notion of
project, and worktree agents split into pseudo-projects exactly when the bulk
switch is needed most.

## Design

- One shared derivation, `src/renderer/src/features/workspace/lib/projectScope.ts`:
  - `buildProjectScopeRows(rows, matchingRows)` groups rows that carry
    `tabId`/`tabIndex`/`tabTitle`/`cwd` by tab, in tab order, with `total`,
    `matching`, the Dispatch label (`tabIndexLabel(index) · title`) and the
    distinct directory basenames inside the tab.
  - `filterProjectScopeRows(rows, query)` matches label, title and directory
    names, so typing a worktree name still finds the project that holds it.
  - `rowsInSelectedProjects(rows, selectedTabIds)` is the one membership rule.
- Both modals replace their private `ProjectRow`/cwd grouping with the shared
  rows; selection state becomes a set of tab IDs; the agent row's secondary
  line uses the same letter vocabulary (`E · agent-code · /path`) instead of
  `tab 5`.
- Ordering follows the tab order rather than the old count-first sort, because
  the point is that the list reads like the Dispatch index.

## Tests

- `projectScope.test.ts`: two agents in the same tab in different worktrees
  produce one entry; same-titled tabs get distinct letters and keep tab order
  regardless of counts; `matching` counts only the second argument; the filter
  finds a project by its worktree name; membership filters by tab.
- The existing modal tests (`CloseOldAgentsModal.rows`, `BulkProviderSwitchModal.policy`)
  keep passing; `tsc` on both projects; `npm run test:contract`.

## Out of scope

Any change to what the switch or the close does once agents are selected.
