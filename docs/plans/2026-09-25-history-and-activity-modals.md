# History and Agent Activity modals

Status: in progress · Issues #1188 (bug), #1189 (refactor), #1190 (feat) · Short plan

Size: short plan. One bug with a known root cause, one sizing change, and one
command that reuses an existing store and dialog. No staged decomposition is
needed: nothing here reconciles multiple sources of truth.

## Outcome

1. **View TLDR History** looks like every other Agent Code dialog. Its list is
   inset from the edges, uses the dense type scale, and goal rows are
   recognisable at a glance (#1188).
2. **Agent Activity** is a centred modal on the shared `Dialog` primitive, not
   a full-viewport takeover (#1189). The owner reversed the 2026-09-24
   "full screen" decision from #1170.
3. The new **View Goal History** command lists one agent's goal changes and
   completions, newest first (#1190).

## Evidence (verified, do not re-derive)

- `components/ui/dialog.tsx` `DialogContent` has NO padding. `DialogHeader`
  and `DialogFooter` each bring `px-4 py-3`, and every modal body pads itself
  (`AgentMcpServersModal`: `px-4 py-2 text-[11px]`). `TldrHistoryModal`'s body
  was `max-h-[60vh] overflow-y-auto pr-1` with `text-sm` rows. That is the
  flush-left, oversized list in the owner's screenshot. Its `max-w-xl` was dead:
  the primitive fixes the width at `w-[min(520px,92vw)]`.
- Agent Activity is already a Radix `Dialog`. It is full screen only because its
  `DialogContent` overrides the positioning classes
  (`left-0 top-0 h-full w-full translate-x-0 … bg-canvas`), and its sticky
  section headers paint `bg-canvas` to match. Input ownership, focus trap and
  Escape handling already come from the primitive, so the change is sizing only.
- Goal history already exists end to end: `window.api.readGoalHistory(identity)`,
  `onGoalChanged`, and entries with a `completed` flag. The combined modal
  already reads it. No main-process or IPC work is needed.
- The open-state for history is `uiShell.tldrHistorySessionId`. Its only
  consumers are `TldrHistorySurface`, the slice, `AppState` types, the
  command-palette `ui` type, `CommandPalette` wiring and one test.

## Design

- `uiShell.tldrHistorySessionId: SessionId | null` becomes
  `reportHistory: { sessionId: SessionId; kind: ReportHistoryKind } | null`,
  where `ReportHistoryKind = 'tldr' | 'goal'`. `openTldrHistory(sessionId)`
  becomes `openReportHistory(sessionId, kind)`, and `closeTldrHistory` becomes
  `closeReportHistory`. One field, not two booleans: only one history dialog
  can be open at a time.
- `TldrHistoryModal` becomes `ReportHistoryModal`, which takes a `kind` prop.
  - `kind: 'tldr'` behaves as before: it reads both stores, `mergeHistory`
    combines them, and it has the same title and description.
  - `kind: 'goal'` reads and subscribes to the goal store only. Its title is
    "Goal History".
  - The surface keeps its registry id `tldr-history`.
- Layout for both kinds: `DialogContent` gets
  `flex max-h-[80vh] w-[min(640px,92vw)] flex-col overflow-hidden`, and the body
  gets `min-h-0 flex-1 overflow-y-auto px-4 py-3`. Rows use `text-[12px]
  leading-relaxed`. A row's meta line moves ABOVE the text as a small label row
  ("Goal"/"Goal completed" chip, "Current", time), so the kind is read first.
- `AgentActivityView`'s `DialogContent` gets
  `flex h-[min(760px,86vh)] w-[min(960px,94vw)] flex-col overflow-hidden`.
  Sticky headers use `bg-surface`, and the gutters go from `px-6` to `px-4`, the
  dialog convention. The command description and control reference stop saying
  "full-screen".
- New command `view-goal-history`, "View Goal History" (category `session`,
  surface `session`, same `when` as `view-tldr-history`). It is added to the
  TLDR/Goal control reference `commandIds`, and the catalog count goes to 134.

## Decisions

1. **UNCONFIRMED:** View TLDR History keeps interleaving goals (the #936 design)
   instead of becoming TLDR-only. Changing it would take away a timeline the
   owner has not asked to remove.
2. **UNCONFIRMED:** Agent Activity is 960×760 at most (86vh/94vw on small
   windows). It is wide enough for name + goal + project + state columns, and
   the size is in line with Close Old Agents (860) and Agent Analytics (1040).

## Rulings during execution

- Ruling: **View Goal History is also in the Sessions right-click menu**
  ("Goal History…", agent group, order 75, right after "TLDR History…").
  Why: #1185 landed on main after this plan was drafted and put TLDR History in
  that menu. Goal History is the same kind of per-agent view, so both commands
  share `targetsAgent`/`openHistory`, which resolve through `commandTarget`.
  Cost if wrong: one line of `contextMenu` metadata, plus its rows in
  `commandTarget.renderer.test.ts`, `buildSessionContextMenu` and the menu's
  control reference.
- Ruling: **the catalog arithmetic test raises its subtracted term (61 → 62),
  not the baseline.** That test's own comment requires it.
- Ruling: **commits are split fix → refactor → feat.** The layout fix is
  committed against the original `TldrHistoryModal.tsx`, and the rename to
  `ReportHistoryModal.tsx` comes with the feature. That keeps the bug fix
  reviewable on its own.

## Tests

- `tldrHistory.renderer.test.tsx`:
  - Existing tests are kept and retargeted to `ReportHistoryModal kind="tldr"`.
  - New: `kind="goal"` calls only `readGoalHistory`, lists goals newest first,
    marks the newest "Current", labels completion rows "Goal completed", and
    refreshes on `onGoalChanged` for its identity only.
  - New: the `view-goal-history` command opens `goal` for an agent pane and is
    hidden for a terminal pane.
- Catalog count test: 133 → 134.
- There is deliberately no pixel/class test for the padding fix. The only
  contract is visual, and a test asserting `px-4` restates the implementation
  (a vanity test). The fix is visible in the diff.

## Verification

- `npx tsc -b` on both projects.
- Focused vitest runs for the tldr, agent-activity and command-palette catalog
  tests, then the full `npm run check` once at the end.
- **Boundary:** the app is not launched (standing rule), so the new layouts have
  NOT been looked at on screen. Manual QA is owed, and the PR says so.

## Out of scope

- Moving other modals' body padding into a shared `DialogBody` primitive.
  Every modal pads differently on purpose (lists run edge to edge, forms are
  inset), so adding one now would be a speculative abstraction.
- A goal history in the Cmd+G peek.
