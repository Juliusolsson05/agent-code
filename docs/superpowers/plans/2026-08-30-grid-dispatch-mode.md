# Grid Dispatch Mode

> **Status:** implemented. See `docs/decomposition/grid-dispatch.md` for the
> stage record and the two revisions made during execution. Where this document
> and the code disagree, the code won and the decomposition says why.

**Issue:** [#681](https://github.com/Juliusolsson05/agent-code/issues/681)
**Branch:** `feat/grid-dispatch-mode`

Tiled Dispatch becomes a **grid**. A row is no longer a strip of lanes sharing one
sidebar — it is a complete, self-contained dispatch surface: its own index list,
its own project binding, its own lanes. Up to four of them stack vertically.

Four changes ship together because they are one idea seen from four sides —
*a row is a self-contained view, and a slot within it is space, not an occupant.*

---

## 1. Why

### 1.1 The horizontal axis is exhausted long before the screen is

Tiled Dispatch is one row: an index sidebar plus N agent lanes, capped at 10.
Every additional lane is paid for in width, and past roughly four lanes a lane is
too narrow to read a feed in. The practical cap is far below the nominal 10, and
vertical space goes entirely unused. A 2×4 grid shows eight agents at usable
width on a display where 1×8 shows eight unreadable slivers.

### 1.2 Slots that fill themselves are the layout's most confusing behavior

Three places acquire an agent without being asked:

1. **`buildAutoLanes` on enter** — every lane claims the next unclaimed visible agent.
2. **`buildAutoLanes` on count growth** — every appended lane does the same.
3. **The heal effect in `TiledDispatchLayout`** — *any* lane that fails to resolve
   is handed the next available agent on the very next render.

(3) is the one that hurts. Kill the agent in column 2 of 6 and the slot is
immediately refilled with whatever is next in the index. The user closed one
thing and an unrelated thing appeared in its place, in the position they were
watching. The layout rearranged itself for reasons they did not ask for and
cannot predict.

#673 already established the correct rule for **New Lane**: inserting a lane is a
request for *space*, not for a particular agent. That fix needed a durable
`userEmptied` flag purely to hide the new lane from the healer, then took four
follow-up commits (`26c3b642`, `768e24b0`, `7aec49c2`, `02011066`) to drop the
flag correctly at every writer and at the autosave prune boundary.

The flag is a workaround for the healer. Remove the healer and the flag, its four
bug-fix commits, and its whole maintenance burden become unnecessary.

### 1.3 One global scope wastes the structure rows just bought

`dispatchMode.scope` is one setting for the whole layout. With one row that is
fine. With four, the obvious use of a second row is *a second project*, and
nothing expresses that today.

### 1.4 Ten orchestrated children can bury the index

`buildDispatchGroups` nests linked and orchestration children at `depth: 1` under
their parent. An orchestration parent reviewing a PR routinely spawns eight or
ten children at once. Every one of them takes a full row in the index list and a
full chip in every mini-list, so a single parent can push every other project's
agents off-screen.

The children are not what the user is watching — the *parent* reports. They need
to be reachable, not permanently resident.

---

## 2. The unifying principles

> **P1 — A row is a self-contained dispatch view.** Its own index, its own
> project, its own list density. Adding a row adds a whole view, not a strip.

> **P2 — A slot is space. Space does not imply an occupant. Only the user names
> occupants.**

> **P3 — The grid is ragged by design. Rows have independent column counts, and
> the UI must say so at every point where a user could assume otherwise.**

### P3 is not an edge case

The name "grid" invites the wrong mental model. This is **not** a rows × columns
rectangle. Four agents on top and two below is not a degenerate state to tolerate
— it is the *expected* shape, because projects do not have equal agent counts and
a user watching four build agents and two review agents wants exactly that.

Every consequence follows from taking P3 seriously:

- `rows[].length` is per-row, with no coupling between rows. There is no global
  "column count" anywhere in the state, the reducers, or the UI.
- **`New Lane`, `Remove Lane`, and `Close Agent and Remove Lane` operate on the
  focused row and change only that row's length.** Their behavior within a row is
  byte-for-byte what it is today in the single-row layout — same insertion
  position, same focus rule, same ratio preservation, same refusals. A user who
  learned them in Tiled Dispatch has nothing to relearn.
- The size prompt is a **per-row shape editor**, not two number inputs (§6.3).
  Two inputs labelled "rows" and "columns" would teach the rectangle model in the
  one place the user forms their mental model, and every later ragged edit would
  feel like fighting the tool.
- Rows read as visually independent in the layout because each owns its index
  list and is separated by a drag handle (§5.1) — raggedness looks intentional
  rather than broken.

The rejected alternative was forcing every row to a common width. It would mean
`New Lane` in one row silently adds a lane to every other row, which violates P2
in the most surprising way available: a slot appears somewhere you were not
looking, in a row you were not editing.

P2 applied consistently:

| Event | Old behavior | New behavior |
|---|---|---|
| Enter Grid Dispatch | Lanes auto-filled from the index | Lanes arrive empty |
| Grow the lane count | Appended lanes auto-filled | Appended lanes arrive empty |
| New Lane | Empty (via `userEmptied`) | Empty (no flag needed) |
| New Row | — | Empty |
| The lane's agent is killed | **Refilled with the next available agent** | **Becomes empty and stays empty** |
| The lane's agent falls out of scope | Refilled with the next available agent | Renders empty, keeps its selection (§5.5) |
| Bind a row to a project | — | Row is *filtered*, not *filled* |

The last is the tempting exception. "Assign row 2 to project B" reads like it
should populate row 2, and an earlier draft specified exactly that. It is wrong
for the same reason the healer is wrong: the user named a *constraint*, not an
occupant. A bound row offers only that project's agents. The user picks.

---

## 3. State model

### 3.1 The shape

```ts
export type DispatchLane = {
  selectedSessionId?: SessionId
  // `userEmptied` is DELETED — see §4.3
}

/** One row of the grid: a complete dispatch view. */
export type DispatchGridRow = {
  /** Lane count in this row. INVARIANT: sum(rows[].length) === lanes.length. */
  length: number
  /** Relative height weight. Absent => equal share. */
  height?: number
  /** This row's index-list fraction of the row width. Absent => default. */
  indexFraction?: number
  /** Project binding. Absent => this row follows dispatchMode.scope. */
  projectTabId?: TabId
  /** Cap orchestration/linked children in this row's index. Default true. */
  capChildren?: boolean
  /** Parents the user expanded past the cap in this row. */
  expandedParents?: SessionId[]
}

export type TiledDispatchState = {
  /** Flat, ROW-MAJOR. Unchanged type. */
  lanes: DispatchLane[]
  /** Flat index into `lanes`. Unchanged type. */
  focusedLane: number
  /** Absent => [{ length: lanes.length }], i.e. today's single row. */
  rows?: DispatchGridRow[]
  /** Row-major lane width weights, one per lane. */
  laneWeights?: number[]
  /** LEGACY: [indexFraction, ...laneWeights]. Normalized away on read (§8). */
  ratios?: number[]
}
```

```
lanes:       [A, B, C, D, E, F]   rows: [{length:3},{length:3}]  → 2×3
lanes:       [A, B, C, D, E, F]   rows: [{length:4},{length:2}]  → ragged, legal
lanes:       [A, B, C, D, E, F]   rows: undefined                → 1×6 (today)
focusedLane: 4                                                    → row 1, column 1
```

### 3.2 Why `lanes` stays flat and `focusedLane` stays scalar

The obvious model is `rows: DispatchLane[][]` with a `{row, col}` coordinate. It
was rejected after reading every consumer.

`tiledDispatchSelectors.ts`'s header records that **two whole bug classes** came
from code that maintained some lane pointers and missed others, which is why
`remapTiledLanes`, `clearTiledLaneSessions`, and `keepTiledLaneSessions` exist as
*the single reusable way* to keep lanes coherent, to be applied at **every**
id-remap, removal, and focus-read site. Those sites are:

| Site | File |
|---|---|
| Session id swap (replace/reload) | `hook/actions/session.ts` ×2 |
| Kill session | `hook/actions/session.ts` |
| Close / remove pane | `hook/actions/pane.ts` ×2 |
| Bury pane | `hook/actions/pane.ts` |
| Close tab | `hook/actions/tab.ts` |
| Undo close | `hook/actions/undoClose.ts` |
| Rehydrate | `hook/persistence/rehydrate.ts` |
| Autosave ownership prune | `sessionOwnership.ts` |

and the flat `focusedLane` scalar is read by `dispatchFocusedSessionId`,
`dispatchTarget.ts`, `agentIndexNavigation.ts`, `resolveDispatchSpawnTarget`,
`useKeybinds.ts`, `pane.ts`'s `applyDispatchSpawnFocus`, and five commands.

A 2-D coordinate rewrites all of it. Keeping the lane list flat means **none of
it changes**: there is still exactly one lane list and one focus scalar to keep
coherent, and the helpers that guard them keep working untouched.

Row *metadata* is a different matter — it is an object array because no coherence
helper touches it, and four parallel arrays (`rowLengths`, `rowHeights`,
`rowProjects`, `rowCaps`) would have four ways to desynchronize instead of one
object that cannot.

### 3.3 The invariant

```
sum(rows[].length) === lanes.length
```

This is the one thing that can desynchronize, so row shape lives in its own
module (`gridShape.ts`) whose functions always return a coherent
`{lanes, rows, laneWeights, focusedLane}` together, never a partial update.
`normalizeGridShape()` runs on read and repairs a violated invariant by
truncating or padding the last row, because hand-edited or partially-written
workspace state must not be able to crash the layout.

### 3.4 Limits

```ts
MAX_DISPATCH_ROWS  = 4
MAX_DISPATCH_TILES = 10   // per row; unchanged name, now per-row
MIN_DISPATCH_TILES = 1
MAX_DISPATCH_LANES = 16   // total ceiling across all rows
```

The total ceiling exists because 4 × 10 = 40 live agent views is not a layout, it
is a memory incident — each lane mounts a real `renderWorkspaceLeaf` with its own
runtime subscriptions.

---

## 4. What gets deleted

This change removes more code than it adds.

### 4.1 The heal effect

The `useEffect` in `TiledDispatchLayout` that hands the next available agent to
every unresolved lane. Deleted outright.

### 4.2 `buildAutoLanes`

Its only callers are `enterTiledDispatch` and `setTiledLaneCount`'s growth
branch, both of which now append empty lanes. Deleted outright.

### 4.3 `userEmptied`

The flag, its ~20-line doc comment on `DispatchLane`, the flag-dropping in
`withLaneSession` and `withLaneCleared`, and the three writer sites that must
remember to drop it.

**Why deleting beats keeping it "just in case":** the flag's entire purpose is to
make one empty lane invisible to the healer. With no healer, every empty lane
behaves identically, so the distinction it encodes — *why* a lane is empty — has
no consumer. A persisted field with no reader is how the next person
reintroduces a behavior nobody wants.

The flag is persisted, so old `workspace.json` files contain it. It is dropped by
the lane spread on rehydrate; no migration needed.

### 4.4 What survives, and why

`clearTiledLaneSessions`, `remapTiledLanes`, `keepTiledLaneSessions`, and
`withLaneCleared` all stay. They do not fill anything — they *unset* pointers to
sessions that no longer exist, which is still exactly right and is now the whole
story.

`laneResolutions` also stays: detecting that a lane's session is dead or
out-of-scope is still required so a stale id cannot paint a dead session. Only
the *reaction* to a null resolution changes, from "refill it" to "render empty".

---

## 5. Layout and UX

### 5.1 Structure — every row is a complete dispatch view

```
┌──────────────┬──────────────────────────────────────────┐
│ SESSIONS ⊟ A▾│ [mini][ agent view ] │ [mini][ agent ]   │  row 0
│ ▸ agent-code │                      │                    │
│   A1 build   │                      │                    │
│   A2 review  │                      │                    │
├──────────────┼──────────────────────────────────────────┤ ← row splitter
│ SESSIONS ⊟ B▾│ [mini][ agent view ] │ [mini][ agent ]   │  row 1
│ ▸ ml-pipeline│                      │                    │
│   B4 train   │                      │                    │
└──────────────┴──────────────────────────────────────────┘
  indexFraction        laneWeights (row-major slice)
                                        height → rowRatio
```

Each row owns:

- **its own index list** (`DispatchAgentList`), width `row.indexFraction`,
  draggable independently of every other row;
- **its own header controls** — the child-cap toggle and the project binding
  (§5.3, §5.4), which land in the header that today reads `Sessions … project`;
- **its own lanes**, each with a mini-list, sized by its slice of `laneWeights`;
- **its own height**, via a horizontal `SplitHandle` between rows writing
  `row.height`, reusing `useResizableSplitter` exactly as column boundaries do.

This replaces an earlier design in which one full-height sidebar served the whole
grid. A shared sidebar cannot express per-row project binding (whose agents would
it list?), leaves the row-level controls with no home, and makes "which lane does
clicking a row select?" unanswerable across four rows. A per-row index answers
all three by construction, and it is what makes P1 true rather than aspirational.

### 5.2 Every lane gets a mini-list; the row index selects into the focused lane

Today lane 0 has no mini-list because the sidebar *is* its selector
(`focusSessionInTab` writes `setTiledLaneSession(0, …)`).

With per-row indexes that special case is meaningless — the index belongs to the
*row*, not to its first lane. So:

- **Every lane gets its own mini-list**, including each row's first.
- **A row's index list selects into the focused lane when focus is already in
  that row; otherwise it moves focus to that row's first lane and selects there.**

One rule, no second focus state. Clicking a row's index means "I am working in
this row now", so moving focus there is what the user meant. Critically this
keeps the single flat `focusedLane` as the only focus truth — introducing a
per-row remembered column would be a second source of focus truth, which is the
exact shape of #266/#267/#271/#272.

**This is a behavior change to the existing single-row layout** (the sidebar
follows focus rather than always targeting lane 0) and is called out in the PR as
such. It also removes an existing inconsistency: `⌘N` and `⌥↑/↓` already act on
the focused lane while the sidebar acted on lane 0.

### 5.3 Capping orchestration children (§1.4)

**The control.** A small toggle icon in each row's index header, beside the
existing `Sessions` label. Two states, no title string mutation (command-style
rule 2 applies to controls as much as commands): collapsed shows a "expand"
glyph, expanded shows "collapse". `title` names the effect
(`Show all orchestrated agents` / `Cap orchestrated agents`).

**The rule.** When `row.capChildren` is on (**the default**), any parent with more
than `ORCHESTRATION_CHILD_CAP = 3` children renders its first 3 children followed
by a `+N more` row. Clicking it adds that parent to `row.expandedParents`,
showing all its children and a `− Show fewer` row. The header toggle flips the
row's default and clears its per-parent overrides.

**Only `depth: 1` rows are ever capped.** Top-level agents are never hidden — they
are what the user is watching, and a list that hides the thing being reported is
worse than a long list.

**This is presentational only.** It does **not** change `buildVisibleDispatchRows`.
Labels (`A1`, `B7`, `★1`), `globalIndex`, `⌘N` targeting, lane resolution, and
command targeting are computed from the full canonical row set exactly as today;
the cap is applied when *rendering* the index and the mini-lists. An agent's
label therefore never changes because a view was toggled, and a hidden child
keeps its number rather than causing everything below it to renumber.

That is the load-bearing decision here. `buildVisibleDispatchRows`'s header says
keyboard navigation, command targeting, and the rendered list must agree on one
linear order or "the highlighted row and the acted-on session drift apart".
Renumbering on collapse would break exactly that.

**Mini-lists cap too**, driven by the same row setting, because ten extra chips
per lane is the same space problem in a narrower column. The cost is that a
capped child cannot be picked straight from the strip; it is one click away in
the row's index, which is adjacent.

### 5.4 Per-row project binding

**The control.** The right-hand side of the row's index header — today a static
`project` / `global` label — becomes a button opening the row-project picker
(§6.2). It shows the bound project's title, or `Any project` when unbound.

Putting it here rather than in a separate rail is the whole benefit of the
per-row index: the control that says *what may live in this row* sits at the top
of the list that *shows what may live in this row*.

**Semantics.**

- Binding row R to tab T sets `rows[R].projectTabId = T`.
- Row R's index list and every mini-list in row R filter to `row.tabId === T`.
- Lanes in row R already holding another project's agent **keep it** until the
  user changes them, rendering with the out-of-scope treatment from §5.5.
  Clearing them would be the layout rearranging itself unasked.
- **Binding auto-promotes `dispatchMode.scope` to `'global'`.** Project scope
  builds rows only for `activeTabId`, so a row bound to any other project would
  have an empty index. There is direct precedent: `agentIndexNavigation.ts`
  already promotes to global for a cross-project label, with a comment explaining
  that a project-scoped row set cannot retain lanes from project A once
  `activeTabId` moves to B.
- Unbound rows continue to follow `dispatchMode.scope`.

**Filtering, never rebuilding.** A bound row's rows come from **filtering** the
canonical `buildVisibleDispatchRows(state)` output, not from rebuilding it with a
different scope — same reasoning as §5.3. A bound row shows `B3`, `B7` with gaps,
which is correct and readable, and `⌘N` selects the agent whose chip the user is
looking at.

### 5.5 Empty and out-of-scope lanes

An empty lane renders `DispatchEmpty`. The hint is now correct in every position,
where today it is suppressed for lane 0:

| Lane state | Hint |
|---|---|
| Focused, row unbound | `Pick an agent from the strip, or press ⌥↓ for the top of the index` |
| Focused, row bound to P | `Pick a ${P} agent from the strip, or press ⌥↓` |
| Not focused | `Empty lane` — no key hint |

The unfocused rule is inherited verbatim from the current implementation: `⌥↓`
acts on the focused lane, so advertising it in an unfocused lane would tell the
user to press a key that moves a *different* lane's agent.

**Out-of-scope lanes keep their selection.** With no healer, a lane whose session
is alive but out of scope simply fails to resolve. We deliberately keep
`selectedSessionId` and render `Not in this scope`, so restoring scope restores
the lane. This is strictly better than today, where the selection is silently and
irreversibly replaced, and it costs nothing: the autosave prune
(`keepTiledLaneSessions`) still scrubs pointers to sessions that genuinely no
longer exist.

---

## 6. Commands

All follow `docs/command-style.md`: stable noun phrases, explicit `surface`,
ellipsis only where more input is required, state via `getState`.

### 6.1 Structure

| id | title | surface | behavior |
|---|---|---|---|
| `tiled-dispatch` | `Grid Dispatch` | `app` | Opens the size prompt (§6.3). Renamed from `Tiled Dispatch`; **keeps its command id** so `Settings.commandVisibilityOverrides` and the user's `⌘D` binding are not orphaned. |
| `new-tiled-lane` | `New Lane` | `dispatch` | Inserts an empty lane right of focus, **within the focused row**. Refused at the row's column cap or the total cap. |
| `remove-tiled-lane` | `Remove Lane` | `dispatch` | Unchanged, plus: removing a row's last lane removes the row. |
| `close-agent-remove-lane` | `Close Agent and Remove Lane` | `dispatch` | Unchanged. |
| `new-dispatch-row` | `New Row` | `dispatch` | Inserts an empty row below the focused row with the same column count, clamped to the total cap. Focus stays put. |
| `remove-dispatch-row` | `Remove Row` | `dispatch` | Removes the focused row. Agents keep running. Refused at one row. |

`New Row` mirrors `New Lane`'s contract exactly: the row arrives empty, focus
does not move.

### 6.2 Row controls

| id | title | surface | behavior |
|---|---|---|---|
| `dispatch-row-project` | `Row Project…` | `dispatch` | Picker listing every open tab plus `Any project`. `getState` badges the current binding. |
| `dispatch-row-child-cap` | `Nested Agents` | `dispatch` | Toggles the focused row's child cap. `getState` badges `Capped` / `All`. |

One project command rather than a bind/unbind pair, because `Any project` is a
value in the same list rather than a separate action — the reasoning that made
`Dispatch Scope` name both ends instead of shipping `Global Dispatch: On`.
`Nested Agents` is a stable noun with its state in a badge, per rule 3, not
`Toggle Orchestrated Agents`. It is **not** called "Orchestrated Agents", which
an earlier draft used: `buildDispatchGroups` nests manually linked agents and
orchestration children identically at `depth: 1`, and the cap follows visual
nesting, so it cannot tell them apart. A title promising orchestration-only
behavior would have been a lie about what the control does.

The picker follows the surface-registry pattern (`registry.tsx`): a wrapper in
`features/workspace/surfaces/`, one import, one array entry, and a `uiShell`
open/close pair, exactly as `TiledDispatchCountSurface` does.

### 6.3 The shape editor

`TiledDispatchCountOverlay` becomes `GridDispatchShapeOverlay` (file renamed;
command id unchanged). It is **not** two number inputs.

```
┌────────────────────────────────────────┐
│  Grid Dispatch                          │
│                                         │
│  Row 1   [−]  4  [+]   ▦ ▦ ▦ ▦          │
│  Row 2   [−]  2  [+]   ▦ ▦          [×] │
│                                         │
│  [ + Add row ]                          │
│                                         │
│  6 of 16 lanes                          │
│                    [ Cancel ]  [ Open ] │
└────────────────────────────────────────┘
```

**Why a shape editor and not `rows × columns`:** this modal is where the user
forms their mental model of what Grid Dispatch *is*. Two inputs labelled "rows"
and "columns" teach a rectangle, and P3 says the rectangle is the exception, not
the rule. A per-row stepper teaches the truth — rows are independent — and the
block preview *shows* raggedness rather than describing it, so "4 on top, 2
below" is something the user sees before they commit, not something they discover
later by fighting a symmetric default.

- One stepper per row, 1–10, reusing the existing `NumberInput` so the `+`/`−`
  targets match the rest of the app.
- The block preview to the right of each stepper renders `length` blocks at a
  fixed size, so unequal rows are immediately legible as unequal.
- `+ Add row` up to `MAX_DISPATCH_ROWS`; a per-row `[×]` removes it, hidden when
  only one row remains.
- A live `N of 16 lanes` counter. Steppers and `+ Add row` disable at the
  ceiling rather than accepting input and clamping it silently.
- On an already-open grid the editor opens on the **current shape**, so re-running
  the command is the "reshape it" path. Rows keep their identity by position:
  editing row 2's count changes only row 2's lanes.
- Growth appends **empty** lanes and rows. Shrinking drops from the tail of the
  affected row, and removing a row drops that row's lanes only.

The editor is a convenience for bulk reshaping, not the primary path. Day to day,
`New Lane` / `New Row` / `Remove Lane` / `Remove Row` edit the shape in place
without a modal, which is why those commands keep their exact current semantics
(P3).

---

## 7. Keyboard

| Keys | Today | With the grid |
|---|---|---|
| `⌥↑` / `⌥↓` | Move the focused lane's *selection* up/down the index | Unchanged |
| `⌥←` / `⌥→` | Move focus to the previous/next lane | Move focus within the row; **stop at row edges** rather than wrapping |
| `⌥⇧↑` / `⌥⇧↓` | — | **Retracted — see below.** Focus Row Above/Below ship palette-only, with no default chord. |
| `⌘N` | Fill the focused lane with row N of the index | Unchanged |

`⌥←/→` stopping at row edges rather than wrapping is deliberate: wrapping would
make one keystroke move focus one lane *or* jump it across the layout depending
on position — fine when you are looking, wrong when you are typing fast.

### 7.1 These bindings are invisible today, and that is worth fixing

The Dispatch arrow keys are **not** registry-bound. `useKeybinds.ts` handles
`ArrowUp/Down/Left/Right` and `K/J/H/L` inline inside its Dispatch branch, so
none of them appear in the Keyboard Shortcuts surface, none can be rebound, and
`check:keybindings` does not know they exist.

Adding row movement inline would be the path of least resistance and would make
the problem one key worse. Instead:

- `dispatch-focus-row-up` / `dispatch-focus-row-down` are registered as real
  commands (`surface: 'dispatch'`), so they appear in the shortcuts UI and can be
  rebound by the user.
- **The `⌥⇧↑/↓` chord was retracted in review, and the reason is worth keeping.**
  It was checked against `defaults.ts` — no `Alt+Shift+Arrow` binding exists —
  and `check:keybindings` accepted it. Both were true and both were beside the
  point: that checker only knows about bindings *this app* registers. It does not
  know about the OS.

  `useKeybinds`' own header already records the answer: Option+Shift+Arrow is the
  macOS word-selection shortcut and is *"load-bearing for every text field in the
  app (including our composer)"* — which is precisely why directional resize uses
  `fn+alt+Arrow` instead. Dispatch bindings stay live while a text editor owns
  the target and the router `preventDefault()`s what it routes, so claiming that
  chord would have broken selection in the composer *and* moved row focus
  underneath the user.

  **The lesson, recorded because it will recur: a green `check:keybindings` is
  evidence about this app's binding table, not about whether a chord is free.**
  Platform reservations have to be checked by reading, and this repo already
  wrote down the one that mattered.
- **What shipped is the fallback below**: the commands are registered with **no
  default binding**. They stay invocable from the palette and bindable through
  the keybindings UI, which is strictly better than a default that steals text
  selection. A chord free of both this app and the platform can be added later.

Migrating the four existing inline Dispatch arrows into the registry is *not* in
this PR's scope — it is a behavior-preserving refactor of a surface this change
does not otherwise touch, and bundling it would put a rebindable-keys migration
inside a layout feature. It is worth its own issue.

---

## 8. Persistence

`dispatchMode` is already persisted to `workspace.json`, so `rows` and
`laneWeights` are durable for free.

- **Old state, no `rows`:** ⇒ `[{ length: lanes.length }]`. One row, as before.
- **Old state with `ratios`:** `normalizeGridShape` performs a read-time
  normalization — `ratios[0]` becomes `rows[0].indexFraction`, `ratios.slice(1)`
  becomes `laneWeights`, and `ratios` is never written again. This is the one
  piece of genuine migration in the change; it is a single pure function with its
  own tests rather than a schema version bump, because the target fields are
  additive and the legacy array is unambiguous.
- **`userEmptied` in old state:** dropped by the lane spread.
- **Corrupt state:** `normalizeGridShape` repairs `sum(rows[].length) !==
  lanes.length` by truncating/padding the last row, drops `projectTabId` naming a
  closed tab, and drops `expandedParents` naming dead sessions.
- **Autosave:** `keepTiledLaneSessions` continues to scrub lane pointers at the
  ownership prune. Row metadata names one session class — `expandedParents` — so
  it is scrubbed at the same boundary, alongside `projectTabId` against live tabs.

---

## 9. Testing

Per `docs/testing/standard.md`: suffix picks the tier, each test protects one
contract, no test restates the implementation.

### 9.1 `gridShape.test.ts` (`unit`)

Pure functions, no hook, no DOM — the reason row shape is its own module.

- `sum(rows[].length) === lanes.length` holds after insert lane, remove lane,
  insert row, remove row, grow, shrink.
- Inserting a lane in row 1 of a `[3,3]` grid yields `[3,4]` and shifts
  `focusedLane` only when the insertion is at or before it.
- Removing a row removes exactly its lanes from the flat array and re-clamps
  `focusedLane` into the survivors.
- Removing a row's last lane removes the row.
- Refusals return `null`: at one row, at the column cap, at the total cap, on a
  non-integer or out-of-range index.
- `normalizeGridShape` repairs a violated invariant instead of throwing, and
  migrates a legacy `ratios` array into `indexFraction` + `laneWeights`.
- Inserting a lane gives the newcomer its row's average weight and preserves the
  row's index fraction and every other lane's proportion.

**Ragged-shape contract (P3)** — the assertions that stop a future change from
quietly re-imposing a rectangle:

- `New Lane` in row 0 of a `[2, 2]` grid yields `[3, 2]` and leaves row 1's
  length, weights, and lane contents untouched.
- `Remove Lane` in row 1 of a `[4, 2]` grid yields `[4, 1]` — row 0 is not
  resized to match.
- `New Row` below a 4-lane row creates a 4-lane row; below a 2-lane row, a
  2-lane row. It inherits the focused row's length rather than any global value.
- A `[4, 2]` shape survives autosave and rehydrate as `[4, 2]`, not normalized to
  `[3, 3]` or `[4, 4]`.
- No reducer, selector, or helper exposes or derives a single "column count" for
  the grid. (Asserted structurally: `gridShape.ts` has no such export.)

### 9.2 `noAutoFill.renderer.test.tsx` (`renderer`)

The tests that would have failed *before* this change, which is what makes them
worth having:

- Killing the agent in column 2 of 6 leaves column 2 **empty** and moves no other
  lane's agent. (The reported confusion, pinned.)
- Entering Grid Dispatch with agents available yields **empty** lanes.
- Growing the lane count appends **empty** lanes without disturbing existing
  selections.
- A lane whose session goes out of scope renders empty but **retains**
  `selectedSessionId`; restoring scope restores the agent.

`tiledLaneHealing.renderer.test.tsx` asserts the opposite. It is **rewritten, not
deleted** — the resolution behavior it also covers (dead ids do not paint,
out-of-scope ids do not resolve) still needs assertions — and renamed
`tiledLaneResolution.renderer.test.tsx` so it stops advertising a mechanism that
no longer exists.

### 9.3 `rowProjectBinding.renderer.test.tsx` (`renderer`)

- A bound row's index and mini-lists contain only that project's agents.
- **Labels stay canonical:** a row bound to project B shows `B3`, `B7` with gaps,
  and `⌘N` with that lane focused selects the agent the chip names. This is the
  §5.4 drift class and the most important assertion here.
- Binding promotes scope to `'global'`.
- Binding does not fill, move, or clear any lane.
- A binding to a closed tab is dropped at the autosave prune.

### 9.4 `orchestrationChildCap.renderer.test.tsx` (`renderer`)

- A parent with 10 children renders 3 plus a `+7 more` row; expanding shows all
  10 and a collapse affordance.
- Top-level agents are never capped, at any child count.
- **`buildVisibleDispatchRows` output is byte-identical with the cap on and off**
  — the cap changes rendering only. Asserted directly, because this is what keeps
  `⌘N` and lane targeting correct.
- A hidden child keeps its `globalIndex`; no row below it renumbers.
- The per-row toggle affects only its own row.

### 9.5 Coherence boundaries

`clearTiledLaneSessions` / `remapTiledLanes` / `keepTiledLaneSessions` are
unchanged code now running against multi-row states. `dispatchSelectors.test.ts`,
`tiledLaneInsertion.test.ts`, and `tiledLaneRemoval.test.ts` gain grid-shaped
cases so a future 2-D refactor cannot quietly break the flat contract §3.2
depends on.

### 9.6 Full gate

`npm run check` on the branch before the PR is opened. `check:keybindings` is not
optional here: §7 adds a chord.

---

## 10. Execution order

Each step is independently reviewable and leaves the branch green.

1. **`gridShape.ts` + unit tests.** Pure functions, no UI. Establishes the
   invariant before anything renders against it.
2. **Delete auto-fill and the healer.** Smallest, highest-value change; ships the
   fix for the reported confusion alone. Rewrite the healing suite.
3. **Delete `userEmptied`.** Only safe after step 2, and trivially safe after it.
4. **Row-aware state and reducers**, `normalizeGridShape` on rehydrate.
5. **Row-aware layout**: stacked rows, per-row index lists, row splitters, uniform
   mini-lists, index-follows-focus, empty-lane hints.
6. **Row and size commands** + the resized prompt overlay.
7. **Keyboard**, with `check:keybindings` run before the chord is settled.
8. **Per-row project binding**: `projectTabId`, header control, picker surface,
   filter, scope promotion.
9. **Orchestration child cap**: header toggle, `+N more` / collapse rows,
   `expandedParents`, applied to index and mini-lists.
10. **Full `npm run check`**, PR opened against #681.

---

## 11. Risks and open questions

**Four index lists cost width.** Each row now spends `indexFraction` on its own
list, so a 4-row grid renders four index lists where the earlier full-height
sidebar rendered one. This is the deliberate trade for P1 — per-row projects and
per-row density are not expressible without it — but it means realistic column
counts per row are ~2–4 rather than the nominal 10. The per-row `indexFraction`
being independently draggable is the mitigation: a row being used purely to watch
can have its index dragged narrow.

**Sixteen live agent views** is a judgment call, not a measurement. Each lane
mounts a real `renderWorkspaceLeaf` with its own runtime subscriptions, and
`project_screen_snapshot_gc_churn` is on record as a per-session 60Hz cost.
Watch it in review rather than assume it.

**The index-follows-focus change (§5.2) is user-visible** in the existing
single-row layout. It is the right call and it is argued above, but it is the one
change here an existing user could experience as a regression rather than a fix.
Flagged prominently in the PR.

**Default-on child capping hides rows by default.** Mitigated by only ever
capping `depth: 1` rows, by the explicit `+N more` affordance, and by never
renumbering. If it still surprises, the default is one constant.

**`⌥⇧↑/↓` is verified free but not yet verified *acceptable*.** `check:keybindings`
decides in step 7; §7.1 records the fallback (ship the commands unbound rather
than shadow an owner).

**The four inline Dispatch arrow keys stay invisible** to the shortcuts UI after
this PR. That is pre-existing, and §7.1 explains why moving them into the
registry belongs in its own issue rather than riding along inside a layout
change. It should be filed.
