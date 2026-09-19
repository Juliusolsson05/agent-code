# Unified Workspace Layout (Stage over Fleet)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan stage-by-stage. Stages in §9 are the task units.

**Issue:** [#992](https://github.com/Juliusolsson05/agent-code/issues/992)
**Branch:** `feat/unified-stage-layout`

> **Status:** plan. Owner decisions recorded 2026-09-17: kill nested splits
> ("never nest"), demote tabs to grouping ("just grouping"), pool-first
> sessions, per-row indexes stay, spawn is context-places; and the merge
> exists to remove new-user confusion and mode-relative naming — the owner
> uses Dispatch only.

**Goal:** Delete the two-mode layout. The workspace becomes one thing: a
**stage** of ragged rows of lanes (today's Grid Dispatch, promoted from mode
to workspace) over a **fleet** pool of sessions (today's "detached" state,
promoted from exception to default). Project tabs stop owning tile trees and
become grouping only. One model to onboard onto, one vocabulary for
commands: no mode names anywhere a user can see.

**Architecture:** One placement authority (stage lanes referencing pool
sessions), one focus truth (`focusedLane`), one session bucket. The binary
split tree, the detached-session bucket, the buried bucket, mode switching,
and every invariant that reconciles them are deleted rather than reconciled.

**Tech Stack:** TypeScript, React 18, Zustand-style setState, electron-vite.
Reuses verbatim: `gridShape.ts`, `tiledDispatchSelectors.ts`, lane coherence
helpers, `renderWorkspaceLeaf`, `DispatchAgentList`, `DispatchMiniList`,
`TiledDispatchLayout`.

---

## 1. Why

### 1.1 The evidence

- **Live workspace (2026-09-17):** 12 lanes in 2 rows (6+6), 14 detached
  sessions, 3 project tabs each holding a *single* pane. Tabs are used as
  project buckets, not as split trees. 9 of 17 sessions are terminals.
- **History:** Dispatch was born (2026-04-29 plan) because command-center
  agents "poison the grid layout." Every evolution since — Tiled Dispatch
  (#248), Grid Dispatch (#681), first-lane strip (#850), entry seeding and
  mode-agnostic New Lane (#977/#978) — moved placement authority from the
  tree toward lanes and made the mode boundary thinner. This plan finishes
  that trajectory instead of continuing to bridge two systems.
- **Owner call:** nested splits are never used. The binary tree's only
  remaining virtue is gone.

### 1.4 Two modes are an onboarding and naming tax

Every mode-relative name is a question a new user must answer before they can
work: "Grid or Dispatch?", "Tiled Dispatch vs Grid Dispatch?", "why is New
Lane greyed out?" (#978 was exactly this bug). The palette splits its verbs
by `surface: 'grid' | 'dispatch'`, and docs explain a toggle that — after
this plan — explains nothing. The owner's own usage (Dispatch only) shows
the second mode is not carrying its weight; new users pay for it at first
launch, and every command title pays for it forever. Removing the modes is
therefore not just a layout change: it is the fix for the confusing
onboarding path and the mode-relative command vocabulary in the same stroke.

### 1.2 The costs of keeping both

Two placement authorities, two focus truths, two spawn paths, two close
semantics, two command surfaces (7 `grid` + 16 `dispatch`), and the
leaf-XOR-detached invariant enforced at nine coherence call sites
(`remapTiledLanes` / `clearTiledLaneSessions` / `keepTiledLaneSessions`,
applied across id-remap ×2, kill, close ×2, bury, tab close, undo-close,
rehydrate, autosave-prune). Every layout bug class on record
(#266/#267/#271/#272 focus drift, #681 auto-fill, #690 dead panes) came from
one system trying to mirror the other.

### 1.3 The unifying principles

> **U1 — The fleet is the only home.** Every session (agent, terminal,
> extension view) lives in the pool, grouped by project. There is no second
> bucket. A session is visible iff some lane shows it.

> **U2 — The stage is lanes.** The screen is ragged rows of lanes. A lane is
> *space*; only the user names occupants (#681's P2, now global law). The
> two sanctioned continuity writes are entry-seed (already shipped) and
> context-places spawn (§5.3). Neither consults the index; neither displaces.

> **U3 — One focus truth.** `focusedLane` is the only focus scalar.
> Spotlight / Reader / Focus Mode are view modes over the focused lane.

> **U4 — Projects are labels, not layouts.** A project is a title, a cwd
> default, a letter for `A1/B7` labels, and a filter for rows and indexes.
> It owns no placement.

---

## 2. State model

### 2.1 The shape (workspace.json v3)

```ts
export type ProjectRef = {
  /** Stable id — carries the old TabId so lanes, bindings, and labels survive. */
  id: TabId
  title: string
  /** Spawn cwd default. Absent => inherit from the spawning context. */
  cwd?: string
}

export type SessionMeta = {
  // ...all existing fields stay exactly as-is (title, kind, providerRuntime,
  // providerSessionId, tmuxName, extensionViewId, linkedParentId,
  // orchestration*, tldrIdentity, agentNameId, builtInMcp*)...
  /**
   * Project membership. Replaces BOTH "I am a leaf of tabs[i].root" and
   * DetachedSessionRecord.projectTabId — the two ways a session used to
   * know its project. Minted at spawn; carried across provider swaps.
   */
  projectId: TabId
}

export type StageState = TiledDispatchState  // lanes / rows / laneWeights / focusedLane — unchanged type

export type WorkspaceState = {
  projects: ProjectRef[]
  /** Spawn defaults + index highlight. The tab bar's only surviving job. */
  activeProjectId: TabId
  /** The workspace. Always present — there is no mode to be out of. */
  stage: StageState
  sessions: Record<SessionId, SessionMeta>
  pinnedSessionIds: SessionId[]
  /** Lane-local "peek at worker" — unchanged semantics, key is the lane's
   *  parent session id (was: physical grid leaf id, same value in practice). */
  gridRelatedSelections?: Record<SessionId, SessionId>
  lastProviderSwitchBatch?: ProviderSwitchBatch | null
}
```

Deleted from `WorkspaceState`: `tabs` (with `root` and `focusedSessionId`),
`activeTabId` (→ `activeProjectId`), `detachedSessions`, `buried`,
`dispatchMode` (scope dies with it; per-row `projectTabIds` binding is the
only scoping mechanism), `tileTabs`. `SpotlightState` / `ReaderModeState`
lose `tabId` and keep `focusedSessionId` only.

**As built (through stage 3b-ii) — where the code differs from the sketch
above, the code is right and §9.1 says why:**

- `SessionMeta` also carries **`joinedAt: number`**, the order key inside a
  project. The sketch had no order key at all; `detachedAt` was the only thing
  ordering rows in v2 and it lived on the record being deleted.
- `projectId` and `joinedAt` are **optional on the type** and required in
  practice: a row without a `projectId` naming a live project is UNOWNED and is
  dropped at the next autosave. Optional is what lets the migration and the
  ownership prune see, and refuse, a half-filed row instead of the compiler
  pretending one cannot exist.
- **`gridRelatedSelections` is deleted**, not kept. It had no writer on screen
  after stage 3a. Whether lanes get a related-agent strip at all is a stage 4
  decision, and if they do it is fed from the pool, not from this field.
- **In memory the fields are still named `tabs` / `activeTabId`** and the type
  is still `Tab = { id, title }`. ON DISK they are `projects` /
  `activeProjectId` — autosave writes v3 only. The in-memory rename touches
  ~150 files for no behavior change and is stage 8's, so that it lands as one
  mechanical commit instead of smearing through the semantic ones.
- `ProjectRef.cwd` does not exist yet. Spawn cwd still comes from the spawning
  context (`projectCwd` reads the project's first session with a directory).

### 2.2 Why `stage` is `TiledDispatchState` verbatim

Every byte of the hard-won lane machinery — flat row-major lanes, the
`sum(rows[].length) === lanes.length` invariant, `normalizeGridShape`
repair-on-read, ragged-by-design rows, `MAX_DISPATCH_ROWS = 4`,
`MAX_DISPATCH_TILES = 10`, `MAX_DISPATCH_LANES = 16` — keeps its type, its
tests, and its normalization. The rename is cosmetic; do not fork it.

### 2.3 The invariants (what replaces the deleted ones)

- **Placement:** `stage.lanes[i].selectedSessionId` either names a session in
  `sessions` or is undefined. That is the entire placement contract. A
  session may appear in 0..N lanes (agent views mirror for free; terminals
  are single-attacher — §8).
- **Focus:** `focusedLane` ∈ `[0, lanes.length)`. No per-row remembered
  column, ever (#266-class).
- **Wake-before-place:** any path that writes a pooled session id into a
  lane wakes it first (#690 rule, already implemented for lane selection and
  entry seed — `selectTiledLaneSession`, `grid-dispatch.entry-seed`).
- **Labels stay canonical:** row indexes and mini-strips render *filtered*
  views of one canonical row set; `globalIndex` never renumbers under child
  caps or project filters (existing rule, now covering everything).

---

## 3. What gets deleted

| Deleted | Replacement |
|---|---|
| `TileNode` / `treeOps.ts` / `TileTree.tsx` splits, ratios, `SplitDirection` | Stage rows + `laneWeights` |
| `tabs[].root`, per-tab `focusedSessionId` | Pool + `focusedLane` |
| `DetachedSessionRecord`, `detachedSessions` | The pool (default state) |
| `BuriedPaneRecord`, bury/revive, placement hints | Pool membership (buried was proto-pool) |
| `dispatchMode` wrapper, enter/exit, switch-back banner | Stage is the workspace |
| `dispatchMode.scope` ('project'/'global') | Per-row `projectTabIds` binding |
| Tile Tabs feature (`TileTabsState`, `features/tile-tabs/`) | Rows bound to different projects |
| `normalize-layout`, `hard-normalize-layout`, `rotate-layout` commands | — |
| `nav-left/right/up/down` (`Focus Pane *`) | ⌥←/→ lane focus; row-focus commands |
| `detach-to-dispatch`, attach-to-grid flows | `Clear Lane` (occupant → pool); selecting from an index *is* placing |
| Auto-created project terminal concepts (already retired) | — |
| `buildAutoLanes`-style anything | Stays dead (#681) |

`gridRelatedSelections` was planned to survive and did NOT (deleted in 3b-ii,
see §2.1 "As built"). `pinnedSessionIds` survives. `Close Old Agents`, `Close Idle Orchestration Agents`, bulk close,
provider switch — all fleet operations, unchanged.

---

## 4. UX

### 4.1 The screen

```
┌──────────────────────────────────────────────────────────────┐
│ [agent-code ▾] [ml-pipeline ▾] [+]            ← project rail │
├──────────────┬───────────────────────────────────────────────┤
│ SESSIONS ⊟ A▾│ [mini][ agent ] │ [mini][ agent ] │ [mini][ ] │ row 0
│ ★1 …         ├───────────────────────────────────────────────┤
│ ▸ agent-code │ [mini][ agent ] │ [mini][ terminal] │ …       │ row 1
├──────────────┴───────────────────────────────────────────────┤
│              status bar / composer of focused lane           │
└──────────────────────────────────────────────────────────────┘
```

- **Project rail** (top): chips, not tabs. Click = set `activeProjectId`
  (spawn default + index highlight + which project the palette groups
  first). It never swaps the layout — there is nothing to swap.
- **Per-row indexes** stay verbatim (#681 P1): each row's own
  `DispatchAgentList`, own project binding, own density, own strip per lane.
- **New Project (`⌘T`)** prompts for a cwd, exactly as New Tab did — it
  created a cwd prompt anyway.

### 4.2 Empty lanes and hints

Unchanged from current Grid Dispatch: empty lane renders the pick hint;
killed agent leaves the lane empty; out-of-scope keeps its selection
rendering `Not in this scope`.

### 4.3 Spawn (context-places)

| Context | Behavior |
|---|---|
| Spawned from an **empty focused lane's** composer / New Agent in lane | New session fills that lane (continuity write — sanctioned by U2) |
| Spawned from an **occupied** lane, the palette, ⌘N, MCP, orchestration | Session lands in the pool; index badges it; nothing on screen moves |

An occupied lane is never displaced — that would be the healer wearing a
spawn costume. Placement is one click (lane's strip / row index) or ⌘N.

### 4.4 Close

Closing a lane's agent: today's close-safety flow (#887), then the lane goes
empty. "Clear Lane" returns the occupant to the pool alive (same gesture as
close-and-remove, minus the kill). Closing a *project* closes its sessions
after the same confirmation the tab-close path uses today.

### 4.5 First run and onboarding

A brand-new workspace opens with **one row, one lane, focused** — no empty
lanes, no shape editor, no mode choice, nothing to explain. The first New
Agent fills the focused lane (context-places, §4.3). Growth is user-paced:
`New Lane` adds space when they want it, `New Row` when they outgrow a row.
The migration default (`[{ length: 2 }]` with entry seed, §6) applies only to
*imported* v2 workspaces; first-run mints `[{ length: 1 }]`. Setup and
onboarding copy never mention layout at all — there is one layout, and it is
the app.

### 4.6 Starter card (the Neovim-style keybind hints)

When the screen would otherwise say nothing — a fresh agent whose feed shows
only the provider welcome banner, or an empty lane — show a compact card of
the ~8 commands a new user actually needs next. This is the
which-key/starter-dashboard pattern, appearing at exactly the two moments of
maximum "now what?":

**Context A — fresh agent (rendered agent surface, zero user turns).**
Rendered in the feed area beneath the provider's welcome text; hides itself
the moment the first prompt is sent. One card per session, in-memory only —
no persisted dismissal state.

**Context B — empty focused lane.** Extends the existing empty-lane hint
(the unfocused lane keeps showing only `Empty lane`, per the existing rule:
never advertise a key that acts on a *different* lane).

**The card is registry-driven, always.** Rows are command ids rendered
through the catalog (title + `getState` badge) with the *live* binding from
the keybinding map — a user who rebinds `New Lane` sees their chord, and a
default-chord change can never leave the card lying. Hardcoded chord strings
in the card are a plan failure, not a shortcut. Commands with no default
binding render title-only (the row-focus commands already set this
precedent).

**The eight slots (Context A), by command id** — curated for v1, not
usage-ranked:

| # | Command | Why it's here |
|---|---|---|
| 1 | Commands (palette) | the escape hatch that finds everything else |
| 2 | New Agent | the thing they just learned, one chord away |
| 3 | New Lane | growth is the first question ("can I run two?") |
| 4 | New Row | the second question ("what if I outgrow the row?") |
| 5 | Focus Lane Left/Right | the arrow grammar of the whole layout |
| 6 | Fill Lane from Index (⌘1–9) | placement, the core new gesture |
| 7 | Spotlight | "read one thing big" — high-frequency |
| 8 | Clear Lane | the gentle exit; Close Agent is one hop away |

Context B shows the four placement-flavored slots only (6, 3, 1, plus the
index walk ⌥↑/↓).

**Terminal lanes never get the card.** Raw PTY views are the provider's
canvas; we do not paint over another program's welcome screen. The card is
a rendered-agent-surface feature.

**Usage-adaptive ranking is a follow-up, not v1.** If durable command
invocation telemetry exists (control-history is the candidate source), the
eight slots can be re-ranked from real usage later; a curated list that is
honest beats an adaptive list that guesses.

---

## 5. Commands and keyboard

### 5.1 Surface consolidation

- The `grid` surface (7 commands) is deleted with the tree, and the
  `dispatch` surface is **retired with the mode** — both merge into one
  `workspace` surface. A command is visible because it acts on the workspace
  or on a session (`session`, 36 commands, unchanged; `app` unchanged), not
  because of which mode the user is in. Palette filtering and `when` gates
  simplify accordingly.
- `tiled-dispatch` (the Grid Dispatch toggle) is deleted — nothing to toggle.
- `global-dispatch` / scope commands are deleted with scope.
- New: `New Project…` (app surface, cwd prompt), `Clear Lane` (workspace
  surface, `getState` badges the occupant's title).
- Keep verbatim: `new-tiled-lane` (already app-surface after #978),
  `remove-tiled-lane`, `close-agent-remove-lane`, `new-dispatch-row`,
  `remove-dispatch-row`, `dispatch-row-project`, `dispatch-row-child-cap`,
  `dispatch-focus-row-up/down`, `pin-agents`, `unpin-agent`.
- `Merge Project Tabs` (#913/#914) becomes `Merge Projects` — same flow,
  renamed noun, because it now merges groups, not layouts.

### 5.2 Keyboard registry migration (the deferred debt)

The four inline Dispatch arrows (`useKeybinds.ts` Dispatch branch) move into
the command registry in this work — we are re-homing keyboard anyway, and
#681 §7.1 already filed it. ⌥↑/↓ index walk, ⌥←/→ lane focus within row,
arrows/K/J/H/L as registered, rebindable, visible in the shortcuts surface.
Row-focus commands keep their no-default-chord status (Option+Shift+Arrow
stays reserved for text selection — recorded lesson, do not re-litigate).

### 5.3 Spotlight / Reader / Focus Mode

Types lose `tabId`; commands and overlays unchanged. They operate on the
focused lane's session — which is what they always actually did.

### 5.4 Vocabulary: the word "Dispatch" retires

User-facing language never names a mode again:

- **Titles** already read mode-free ("New Lane", "Row Project…", "Nested
  Agents", "Remove Row") — keep them. The `Tiled Dispatch` / `Grid Dispatch`
  branded commands die with the toggle. New copy says **lanes**, **rows**,
  **the agent index**, **projects**, **the workspace**.
- **Command ids stay stable** (`new-tiled-lane`, `dispatch-row-project`, …)
  so `Settings.commandVisibilityOverrides` and user keybindings never orphan.
  Ids are not user-facing; renaming them buys nothing and breaks bindings.
- **Internal identifiers** (`DispatchAgentList`, `dispatchSelectors`, …)
  rename only in the cleanup stage, only where the file is already being
  touched; a bulk no-behavior rename PR is optional follow-up, not scope.
- **Docs and onboarding** (README, setup flow, palette help, shortcuts
  surface) must read as if Dispatch never existed. No diagram, tooltip, or
  heading may contain the words "Dispatch Mode", "Grid Dispatch", or "mode".

---

## 6. Persistence and migration

Read-time normalization in `rehydrate.ts`, same discipline as
`normalizeGridShape` — a pure function with its own tests, no schema writer:

1. `tabs[]` → `projects[]` (id, title). `activeTabId` → `activeProjectId`.
2. Every session: `projectId` = its tab's id (leaf membership first, then
   `detachedSessions[sid].projectTabId`, else `activeTabId`).
3. `detachedSessions` folded away; `buried[]` sessions enter the pool live
   (they were live while buried; the pool does not change that).
4. `dispatchMode.tiled` → `stage`. Absent `tiled` (classic dispatch or pure
   grid user) → default stage `[{ length: 2 }]` with lane 0 seeded via the
   existing `dispatchEntrySeedSessionId` resolver (continuity on first open).
5. **Accepted loss, recorded:** a multi-pane tab's spatial arrangement is not
   reconstructed — its leaves enter the pool and the user re-places them.
   (Live data shows 1-pane tabs; reconstructing rows from trees would
   surprise far more than it preserves.) One row of lanes is minted; nothing
   auto-fills beyond the seed (#681).
6. `tileTabs`, `ratios`, `userEmptied`, bury hints: dropped on read.
7. Autosave writes v3 only. `keepTiledLaneSessions` keeps scrubbing dead
  lane pointers at the ownership prune — unchanged job, now the only bucket.

---

## 7. External contracts

- **Control SDK / `observeWorkspace`:** the placements view changes shape
  (no tab roots; lanes + pool). Bump the SDK catalog entry and update
  `agent_management` MCP descriptions in the same PR — they must never
  disagree.
- **ARCHITECTURE.md §5.4/§6.2:** rewritten in this branch (the layout
  section changes shape — this is the sanctioned kind of doc change). The
  workspace-model and workspace-recovery diagrams get new sources; the
  recovery story ("layout restored before backends resolve") is unchanged in
  substance — `stage` + `sessions` restore exactly as `tiled` + `sessions`
  do today.
- **Conventions doc** (`docs/design/agent-code-conventions.md`): only if it
  names tabs-as-layouts — check and fix wording.

---

## 8. Risks and open questions

- **16-lane ceiling becomes the app's ceiling.** Each lane mounts a real
  `renderWorkspaceLeaf` with runtime subscriptions; `project_screen_snapshot_gc_churn`
  is on record. Keep 16 for v1 of the merge; virtualized lanes are a separate
  follow-up if it bites.
- **Terminal single-attach.** A terminal duplicated across lanes streams to
  one view (existing, documented in `DispatchLane`). Pool-first makes
  duplication *more likely to be attempted*; ship the lane hint ("open in
  another lane") rather than solve multi-attach here.
- **Extension views as lane occupants** already work (`extensionViewId`);
  verify the panel-mounted view in a lane before merge PR — it is in the
  owner's live workspace.
- **Blast radius.** Renderer suites pinning tree behavior (treeOps, bury,
  attach/detach, tile-tabs, pane-remount) get rewritten, not deleted where
  they still cover live contracts (close safety, remount-on-id-swap).
- **Open:** does the project rail deserve a context menu (rename, merge,
  close) on day one, or is the palette enough? Recommend palette-first;
  rail context menu is a follow-up.

---

## 9. Execution order

Each stage leaves `npm run check` green and is one PR-sized review.

1. **State + migration (no UI change).** `ProjectRef`/`SessionMeta.projectId`
   /`WorkspaceState.stage`; v2→v3 read-time migration as a pure function;
   golden-file tests from a real v2 workspace fixture; tree paths still
   render from migrated state (compat readers).
2. **Stage promotion.** App renders the stage unconditionally; project rail
   replaces the tab bar; `dispatchMode` null-object removed from render
   forks; palette surfaces consolidate (`grid`/`dispatch` → `workspace`).
   Grid tree rendering becomes unreachable.
3. **Tree deletion.** `TileNode`, `treeOps`, `TileTree`, bury/revive,
   attach/detach, `nav-*`, normalize/rotate commands; coherence helpers keep
   only their lane jobs; rewrite affected suites.
4. **Spawn/close semantics.** Context-places spawn rules (§4.3), `Clear
   Lane`, project-close confirmation; close-safety tests extended to
   lane-cleared-occupant.
5. **Keyboard registry migration.** Four inline arrows → registered
   commands; shortcuts surface shows them; `check:keybindings` green.
6. **Starter card (§4.6).** `StarterHintCard` component; registry + live
   keybinding reads; fresh-agent and empty-lane contexts; auto-hide rules.
7. **Contracts + docs.** SDK `observeWorkspace` shape, agent_management
   descriptions, ARCHITECTURE §5.4/§6.2 rewrite, diagrams.
8. **Cleanup.** Dead fields, dead settings (`commandVisibilityOverrides`
   entries for deleted ids are dropped with a note in the release changelog
   — command ids that vanish must not silently orphan user bindings).

---

### 9.1 Stage 3 execution record (amended during implementation)

The survey before stage 3 counted 48 non-test files reading the tile tree and
about 100 touching the v2 buckets, so stage 3 was split. Each half leaves the
branch green.

**3a — delete features nothing renders, state shape unchanged.** Tile Tabs
(feature, store slot, persisted field, `setTileTabs` threaded through eight
action hooks), Bury / Revive / Kill Buried (commands, prompt, two palette
modes, activity-modal action, `agents.bury` / `agents.restore`), the grid
attach / detach pair and `placement.list` / `placement.attach` /
`placement.detach` / `placement.inspect`, `layout.adjust`, split resize and
`Focus Pane` actions and their key handlers, the placement step of New Agent,
`geometry.ts`, `newAgentPlacement.ts`, the recursive `TileTree` component, and
the grid branches of agent-index navigation.

Decisions made in 3a that were not in the original plan:

- **Buried sessions fold into the pool at every read boundary**
  (`foldBuriedIntoDetached`, applied by rehydrate and by window adoption). With
  the revive UI gone, a record left in `buried` would be alive, owned and
  unreachable. A buried session whose source project is gone re-parents to the
  active project rather than being dropped, because v2 kept buried sessions
  unconditionally. The `buried` field itself survives until 3b, always empty.
  *(Superseded in 3b-ii: the fold is no longer a separate pass. One function,
  `legacyMemberships` in `legacyWorkspaceV2.ts`, reads leaves, detached
  records and buried records and returns each session's membership; the
  re-parenting rule for a buried session with no surviving project is
  unchanged, and it is the ONLY case that may land in the active project.)*
- **Three keyboard reservations were released** (split resize, directional
  split resize, Tile Tabs resize continuation). A reservation with no owner
  only fences off free chords. The macOS Option+Shift+Arrow record was kept in
  `useKeybinds` as a comment, because it is the only place that fact lives.
- **Related-agent mini-tabs are currently unreachable.** Only the recursive
  tree passed `showRelatedAgentTabs`; lanes pass `false`. `gridRelatedSelections`
  therefore has no writer on screen. Stage 4 decides whether lanes show the
  mini-tabs or the field is deleted; §2.1's "survives, lane-local" is a
  proposal until then.

**3b — invert the stored authority.** Split once more during execution, for
the same reason stage 3 was: the two halves touch different things and each
leaves the branch green.

**3b-i — the lane grid becomes a required `WorkspaceState.stage`.** The
`dispatchMode` envelope is deleted from live state, and with it everything it
carried besides the grid: the layout-wide `scope: 'project' | 'global'`, the
classic single-selection `focusedSessionId`, and the null state that meant
"Dispatch is off". Deleted with them: `enterDispatchMode`, `exitDispatchMode`,
`setDispatchScope`, `focusDispatchSession`, `enterTiledDispatch`,
`exitTiledDispatch`; the `enter` / `exit` / `scope` actions of
`dispatch.configure`; the `dispatchModeEnabled` / `globalDispatchEnabled`
palette flags; the New Lane entry path (#978); the close-successor picker for
classic focus (#261). `dispatchMode` survives only as `LegacyDispatchMode` on
`PersistedWorkspace`, read by the migration and never written.

Decisions made in 3b-i that were not in the original plan:

- **Scope had to die here, not in stage 4.** Stage 2c deleted the command that
  switched scope. A user whose file said `scope: 'project'` would have been
  left with every other project's agents alive, owned and unlisted, with no
  command to bring them back. An integration test had this pinned as
  TRANSITIONAL; it now asserts the fleet is visible.
- **Boot no longer knows lanes exist.** Bootstrap used to call
  `enterTiledDispatch([1] | [2])` after each boot path. Now the store starts on
  `freshStage()` (one empty lane), `rehydrate` publishes
  `migrateWorkspaceToStage(persisted).stage` in its FIRST commit, and
  `useBootstrap` lost two parameters. No state without a stage can be rendered
  or autosaved.
- **`newTab` places a new project's first agent in the focused lane, only if
  that lane is empty.** This is the first piece of context-places spawn
  (§4.3), pulled forward because a fresh install's single lane would
  otherwise show nothing. It never displaces. The other spawn paths still
  overwrite an occupied focused lane (`applyDispatchSpawnFocus`); that is the
  known gap stage 4 closes, and it is commented at the function.
- **The entry seed (#977) now runs exactly once, in the migration.** Its
  wake-ordering cases (#690 parity) were deleted with the action rather than
  re-homed: the migration runs at boot and places nothing live. The lane's
  leaf owns the wake (a terminal on mount, an agent on its first send, #691),
  so no reducer there has to order a wake before a write.
- **Autosave writes the in-memory stage verbatim.** Through stage 2 the v3
  half was derived at save time from the v2 half. Derivation at the durability
  boundary would now overwrite the user's lanes with a guess on every save.
- **Takeovers do not write lanes.** Switching the agent inside Spotlight or
  Reader used to mirror into the classic focus (and, with Dispatch off, the
  tree focus). Both fields are gone and nothing replaces them: browsing inside
  a takeover is not the user naming a lane occupant (U2). Only the active
  project follows.
- **Published control shapes were kept, not renamed.** `layout.read` still
  returns `dispatch: { focusedSessionId, tiled }` and `app.observe` still
  reports `mode: 'tiled-dispatch'`. Both are constants or derived now; the
  rename belongs with the SDK schema change in stage 7.
- **A lane that names a session it cannot resolve reads "Agent no longer
  available"**, not "Not in this scope". With no scope, a dead id is the only
  way to get there.
- **Test fixtures.** "The user is commanding X" used to be expressed by a
  tab's tree focus with `dispatchMode: null`. Its translation is a one-lane
  stage showing X (`workspace/testing/stageFixtures.ts`). The recorded v2
  workspace `dispatch-global-d23.json` is lifted in code by
  `workspace/testing/recordedDispatchWorkspace.ts` and is NOT re-recorded or
  edited: the lift is a field move, never the migration, so
  `gridPersistence.test.ts` still sees the legacy `ratios` array.

**3b-ii — delete the v2 owners.** Done as ONE compiler-driven change, not a
dual-write step followed by a delete: a period in which a session's owner was
written in two places is exactly the kind of state a hybrid-file bug lives in,
and `tsc -b` is a better checklist of tree readers than any survey. `Tab` is
`{ id, title }`. `TileNode`, `tile-tree/treeOps.ts`, `detachedSessions`,
`buried`, `gridRelatedSelections` and the `RATIO_*` constants are deleted from
live state. The v2 shapes exist in exactly one module,
`workspace/legacyWorkspaceV2.ts`, imported by the migration and by nothing that
runs after boot.

Ownership moved ONTO THE ROW:

- `SessionMeta.projectId` — the project the session is filed under.
- `SessionMeta.joinedAt` — the order key inside that project. The migration
  seeds it so every old list keeps its order: tile leaves get ordinals
  `0, 1, 2…` in depth-first tree order, detached rows keep `detachedAt`, buried
  panes keep `buriedAt`. Ordinals sort ahead of any real timestamp, which
  reproduces v2's "grid leaves first, then rows by age". New sessions are
  stamped `Date.now()`.

**The ownership rule (v3):** a session is OWNED iff its `projectId` names a
project that exists. Unowned rows are dropped at autosave and at rehydrate.
Lane selections, pins and the active project are POINTERS and never ownership:
a stale pointer must not keep a session alive or bring one back. A ghost row
never falls back to the active project — that would hand a stranger's agent to
whichever project happened to be open.

Decisions made in 3b-ii that were not in the original plan, or that REVERSE it:

- **Boot spawns the FOCUSED lane's occupant only — not every lane occupant.**
  This reverses the rule this section proposed before execution ("lane
  occupants spawn"). The recorded owner workspace decided it: in v2 its 3 tile
  leaves spawned while all 12 of the lanes the user actually worked in booted
  parked and woke on first use. "Wake on first use" is therefore not a new
  risk; it is the path the product's only heavy user already took for every
  agent they touched. Spawning all lane occupants would have turned a 3-spawn
  boot into a 12-spawn boot (each with its own mitmdump and MCP host) to save
  one wake per lane. The focused lane is the one place a parked agent costs
  the user something — it is where the first keystroke goes. Consequences
  pinned in tests: a parked agent the user was commanding (the #977 entry seed)
  now comes up LIVE and the tile leaf they had left behind waits, exactly
  swapping the v2 roles; and a focused lane that is empty, or names a ghost,
  spawns NOTHING — `{ restored: 0, expected: 0, complete: true }` is a complete
  boot that unlocks autosave.
- **How a parked session wakes depends on its kind, and neither is "on
  mount".** A terminal leaf wakes its shell when it mounts. An agent leaf
  renders its committed transcript with no backend and wakes on its first SEND
  (`TileLeaf.send → ensureSessionLive`, #691; `deliverWithWake`, #706). Four
  comments written during this stage claimed lanes wake their occupant on
  mount; all four were corrected.
- **Wake decisions read the RUNTIME, not a structure.** "Is it detached?" was
  the v2 test for "needs a wake". With one kind of session the test is
  `processStatus === 'started'` ⇒ synchronous lane write, anything else ⇒
  `ensureSessionLive` first. This closes a documented gap (a tile leaf whose
  respawn failed, or whose process died, was placed un-woken and needed the
  pane's Retry) and removes its mirror image (every lane agent was "detached",
  so every selection paid a recover round-trip even when the agent was up).
  `requiresWake` left the pure navigation reducer. Reload-all uses the same
  idea in the other direction: it restarts sessions whose runtime is not
  `idle`, so a parked agent stays parked (the #258 guard) and an agent woken
  from a lane — which v2 skipped for not being a leaf — is restarted.
- **A project exists while at least one session names it (U4).** It is removed
  by the commit that takes its last session (`workspaceWithoutSessions` in
  `workspace/pool.ts`, which also empties lanes, drops pins and moves the active
  project to the nearest surviving neighbour) and is never force-removed while
  it holds a session, because that would orphan a running backend.
- **Every close is session-scoped.** The tab's root tile leaf was special in
  v2 — closing it emptied the tree and therefore removed the project — so it
  raised a three-way "Close the agent or the tab?" dialog and, on Close Agent,
  PROMOTED a Dispatch row into the emptied tree. No session is special now.
  Deleted: row promotion, the `agentOnly` request field, the dialog's scoped
  branch, `requestRootCloseConfirmation`, and the `'agent'` answer.
  `CommittedClose` is `gone | session | tab-removed`. "Everything in this
  project" is the Close Tab command with its own list; it closes
  deepest-linked-first (nothing has to go LAST any more to keep a tree valid),
  and a partial close leaves the project holding its survivors.
- **Undo entries carry rows, not records.** `ClosedSession { sessionId,
  sessionMeta }`, `ClosedTab { tab, tabIndex, sessions: [{ sessionId, meta }] }`,
  `ClosedGroup`. The row is stored verbatim, so `joinedAt` rides through and a
  restored session returns to its old POSITION instead of the bottom of the
  list; `carryDurableMeta` carries `projectId` / `joinedAt` for the same
  reason. Lineage remaps `projectId` through the restored-tabs map and
  relationship pointers through the sessions map. Tab restore is best-effort
  per session. Undo files a session back and deliberately does not re-aim a
  lane at it.
- **Merge Project Tabs appends.** Moved sessions are re-filed under the target
  with `joinedAt = max(now, lastTarget + 1) + i`, so the target's own order is
  untouched and the moved block keeps its internal order. Takeovers follow the
  merge into the target.
- **Window adoption takes the closed window's POOL, not its stage.** A lane
  grid is one window's screen; merging two would be inventing a layout. The
  payload is migrated first (`migrateWorkspaceToStage` is total over v2, v3 and
  hybrid files), then its projects, rows and pins are merged. History loads
  eagerly only for adopted sessions main still holds a LIVE backend snapshot
  for — the honest form of what "tile leaves load, detached rows do not" had
  been standing in for.
- **Autosave writes v3 ONLY**: `projects`, `activeProjectId`, `stage`,
  `sessions`, pins, drafts. No `tabs` at all. Writing an empty or synthesized
  `tabs` "for compatibility" would be worse than omitting it: an older build
  would read a real, EMPTY workspace, boot a fresh tab over it and autosave
  that, erasing the pool. With the key absent, the older build fails its shape
  check and lands in `persisted-fallback` with autosave LOCKED, so a downgrade
  cannot destroy a file it does not understand. This is called out in the PR.
- **The related-agent strip's STATE is deleted; its components are not.**
  `gridRelatedSelections` had no writer on screen since 3a. `PaneHeader`,
  `TileLeaf` and `AgentTerminalLeaf` still accept the strip props and are fed
  nothing. Stage 4 decides between feeding them from the pool and deleting
  them.
- **Published contracts: kept, with the smallest honest change.**
  `layout.read` tabs are `{ id, title, sessionIds }`; placement kinds gain
  `'project'` (one ownership placement, never `visible`) and the v2 kinds stay
  in the enum, unproduced; `tabs[].focusedSessionId` is optional and absent;
  the extension API's `panes.observe.leafSessionIds` is the project's sessions;
  `ManagedAgent.placement` is always `'dispatch'` ("a row in the project's
  index", which every session is). Narrowing the enums is stage 7.
- **Main's analytics projection reads both generations.**
  `src/main/agentActivity/workspaceProjection.ts` re-states the migration's
  precedence (row wins when it names a live project, else the v2 structures)
  rather than importing it, because main treats the document as opaque. Its
  new test found a real defect in the code it was written to cover: the
  tile-tree walker's "cycle guard" was a depth cap only, and a split walks two
  children, so a self-referencing node was a 2^64-call tree, not a 64-step
  loop. A document read from disk is JSON and cannot hold a cycle, so
  production never met it; the guard now tracks visited nodes and keeps the
  depth cap for the call stack.

What the test conversion taught, recorded because it will recur in stage 4:

- **`as unknown as WorkspaceState` hid most of the breakage.** After the source
  compiled, the first full sweep still had 48 runtime failures in 21 files, all
  behind casts: fixtures with no `pinnedSessionIds`, no `stage`, or rows with
  no `projectId`. Fixtures touched here use `satisfies WorkspaceState` where
  they can.
- **Replacing a whole row un-files it.** `state.sessions.a = { cwd, kind }`
  used to be a harmless way to change a kind. Membership is on the row now, so
  it silently makes the session unowned, and the test then fails (or passes)
  for a reason unrelated to its subject. Spread the row.
- **A test whose premise was the tile tree was RE-BASED, not deleted**, and
  says so in a comment naming what it used to pin. Deleted outright:
  `gridRelatedAgents.test.ts` and `extensionPaneOwnership.test.ts`, whose
  subjects no longer exist.

Still open after 3b-ii, deliberately:

- `applyDispatchSpawnFocus` overwrites an occupied focused lane on every spawn
  path except `newTab`. `controlPlacement.renderer.test.tsx` pins today's
  behavior with a comment saying it is not endorsed. Stage 4 (§4.3).
- The `'grid'` binding context and `activeBindingContexts({ dispatchMode:
  true })` survive. Stage 5.
- The dead setting `defaultWorkspaceMode`. Stage 8.
- `collectLegacyLeaves` (renderer) is recursive with no depth cap. Its input is
  always `JSON.parse` output, so it terminates; a hand-edited file nesting
  thousands of splits could still overflow the stack at boot. Not fixed here —
  it needs an iterative walk and a decision about what a truncated tree means
  for the migration — but noted so it is not rediscovered as a surprise.


---

### 9.2 Stage 4 execution record (spawn/close semantics)

Executed as designed in §4.3/§4.4, with the deviations and reasons:

- **Never-displace is decided at COMMIT time, inside the updater.**
  `applyDispatchSpawnFocus` takes the whole state (it needs `sessions` to know
  occupancy) and fills the target lane only when that lane is EMPTY — where
  "empty" includes a lane whose `selectedSessionId` names a gone session (the
  stale pointer is dropped by the same write). Refused placement returns the
  stage BY REFERENCE, and that identity is the fill/refuse signal the callers
  read (`pooled = stage === prev.stage`) — decided against the same `prev` the
  placement read, which is what makes a lane freed during the awaited spawn
  fillable and one filled since not. A refused spawn also does not move the
  FOCUS cursor: "nothing on screen moves" is half the rule.
- **`createLinkedAgent` lost its lane capture entirely.** The capture aimed
  the child at the focused lane WHEN it showed the parent; under never-displace
  a lane showing the parent is occupied by definition, so both branches of the
  capture were dead. Linked and orchestration children are pool-only, and
  orchestration children — many from one prompt — are the purest case for the
  badge below.
- **The "index badges it" half is `SessionRuntime.pooledSpawnAt`.** A spawn
  that pools marks the runtime (`markPooledSpawn`, one wrapper so the
  "guard the row exists" dance is written once); the index row renders a
  `new` chip from it; placing the session into ANY lane retires it inside
  `setTiledLaneSession` — the one write every placement gesture (index click,
  lane strip, ⌘N, the ⌥ walk) funnels through. WHY the runtime and not
  workspace state: the badge is presentation, not truth — autosave must not
  write it, undo must not restore it, and a per-row `useShallow` selector
  re-renders one row instead of the whole index. In-memory only, so it never
  survives a restart, which is the right lifetime for "you have not looked at
  this yet". It is retired by placement, never by time — an expiring badge
  teaches the user to distrust it. `selectCreated:false` callers badge too:
  they asked for no view change, and until they place the returned ID the
  badge is the honest state of that row.
- **Clear Lane shipped as its own action + command (`clear-focused-lane`).**
  The action (`clearTiledLane`) empties the lane without ending anything and
  without an undo entry — the undo stack is for CLOSES; undoing a clear is
  selecting the session back into the lane it never left. The command's
  `getState` badges the occupant through the shared `sessionDisplayTitle`
  resolver (a bare "Clear Lane" makes the user check which lane is focused;
  the badge is that check). Admission requires a LIVE occupant: a lane naming
  a gone session is as empty as the user is concerned.
- **⌥⌫ forced the runtime half of the macOS text-editing reservation.**
  Clear Lane ships on Option+Backspace (the plan's card) and macOS owns that
  chord as delete-word in every text field. The static reservation table
  already claimed OS ownership for that chord family without enforcing it —
  its own header admitted the gap ("does not stop the inline dispatch grammar
  from consuming Alt+Shift+Arrow in a composer"). `MACOS_TEXT_EDITING_CHORDS`
  now exists once, feeds the reservation entry, and is enforced at routing:
  `routedCommandForEvent` refuses ANY binding on those chords while a text
  field owns the target, making the table true. The chord pairing is recorded
  in APPROVED_OVERLAPS (owners: clear-focused-lane + macOS text selection)
  with the yield as the precedence rule. Bare Option+Arrow stays unreserved
  on purpose: dispatch navigation from a focused composer is the intended
  workflow and is documented there.
- **The split-command family stopped lying.** `splitFocused` lost its inert
  direction argument; `openExtensionViewInPane` lost its `direction` too.
  Titles dropped the grid directions ("Split Pane Right" → "New Claude",
  "New Terminal Right" → "New Terminal", "New Codex Right" → "New Codex"),
  and every description now states the context-places outcome (fills an empty
  focused lane, else pools with a new badge). **Ids and chords are frozen**
  (§5.4): ⌥D/⌥⇧D/⌥T/⌥⇧T/⌥C/⌥⇧C keep firing what they always fired. The
  "-horizontal" twins are palette-hidden (`pickerVisibility: 'advanced'`,
  honest "(legacy id)" titles) but stay runnable and rebindable — deleting
  them would orphan bindings, which is stage 8's ledger, not this stage's.
- **The related-agent strip is deleted, not fed.** Stage 3 left the
  presentational half alive (PaneHeader chips, TileLeaf/AgentTerminalLeaf
  props) fed by nothing. Feeding it from the pool would have built a second
  session selector inside a lane — against U2, which says a lane shows one
  occupant the user names — duplicating what every per-row index already does
  with more space (children nest under their parents there). Deleted:
  `gridRelatedAgents.ts` (types), the prop chain through TileLeaf /
  AgentTerminalLeaf / PaneHeader, the phone's `relatedAgentTabs={[]}` call
  shape, and the #858 identity chrome (`ownerSessionId`, the `parent`
  button) whose input state no longer exists. What survives of its test
  suites is the part that was never about chips: PaneHeader's phone-stub
  safety case.
- **Control API wording follows behavior.** `agents.create`'s
  `selectCreated` description and the control guide's layout paragraph now
  state context-places honestly (fills only an empty lane; pool + badge
  otherwise; `selectCreated:false` preserves everything, place the returned
  ID with lane-select). Full description rewrites remain stage 7.

What the test conversion taught this time:

- A badge test that crosses TWO hooks has no natural single-suite home;
  `contextPlacesSpawn.renderer.test.tsx` holds the lifecycle (mark on pool,
  not on fill; linked always pools) and says in comments which half lives in
  which other suite.
- The catalog baseline is the first test that moves when a command is ADDED
  (115 now); its arithmetic comment is the ledger, and the "growing the
  catalog means raising the subtrahend" rule kept the plan-count test honest.
- `focusModeKeyboardOwnership.renderer.test.tsx` was the natural home for the
  ⌥⌫ yield cases: it is the suite that already reasons about who owns a
  keystroke, and both halves (routes on the bare stage; yields in a
  composer) are ownership claims.


---

### 9.3 Stage 5 execution record (keyboard registry migration)

Executed as designed in §5.2, plus the 'grid' context deletion that was filed
under "still open" after 3b-ii:

- **The four inline arrows are commands.** `dispatch-select-previous-agent` /
  `dispatch-select-next-agent` (⌥↑/⌥↓, aliases ⌥K/⌥J) walk the focused lane's
  selection through its row's index; `dispatch-focus-lane-left` / -right
  (⌥←/⌥→, aliases ⌥H/⌥L) move lane focus within the row, stopping at the
  edges. The movers live in `workspace/dispatch/laneKeyboard.ts` — one home
  for the grammar — and selection writes through `selectTiledLaneSession`,
  never the raw lane writer, so a hibernated agent wakes before it is placed
  (#690). `useKeybinds`' inline `alt && !cmd` branch is deleted; the commands
  route through the binding table like everything else, so they are
  rebindable, visible in the shortcuts surface, and participate in collision
  checking.
- **The migration fixed Alt+Shift+Arrow by accident of correctness.** The
  inline branch tested `alt && !cmd` and never checked shift, so ⌥⇧↓ ran the
  index walk while the user was selecting text by word — the exact failure
  the reservation table's header admitted it could not prevent ("does not
  stop the inline dispatch grammar from consuming Alt+Shift+Arrow in a
  composer today"). The binding grammar is exact-match, so the shifted chords
  match nothing and stay native. Pinned by a keyboard test.
- **The 'Dispatch row and lane selection' reservation became commands.** The
  reservation existed because an unregistered handler owned eight chords; the
  commands own them in the defaults table now, and keeping the reservation
  would have reported each chord as doubly owned by its own command. The
  entry is replaced by a ledger note, same pattern as the deleted resize
  reservations.
- **'grid' is gone as a binding context**, with the `dispatchMode` flag on
  `activeBindingContexts` — the stage is the workspace, so the layout context
  is simply live whenever the global editor does not own the target.
  DISJOINT_CONTEXT_PAIRS keeps only `['dispatch', 'editor']` (#697's gate and
  its test unchanged in substance). The shortcuts surface's context label for
  `dispatch` reads "Workspace only" — no user-facing copy may name Dispatch
  as a mode (§5.4).
- The ⌘1–9 / two-digit row grammar stays INLINE deliberately: it is a
  contextual interaction with continuation state (a pending digit and a
  timer), not a command — exactly the class the reservation header describes.


---

### 9.4 Stage 6 execution record (starter card)

Executed as designed in §4.6, with one honest divergence from the ASCII
walkthrough recorded below:

- **`StarterHintCard`** (`features/workspace/ui/StarterHintCard.tsx`) renders
  both contexts from one registry-driven component. Every slot is a COMMAND
  ID resolved through the catalog for its title and through
  `resolveEffectiveKeybindings` — the same resolution the router performs —
  for its chord, so a rebound command shows the USER's chord (pinned by
  test). The one non-command slot (Fill Lane from Index) resolves through
  `reservedInteractionBindings`, a new accessor over the reservation table:
  the digit grammar owns chords without being a command, and the reservation
  table is the registry of exactly that. Unbound commands render title-only.
- **Context A** mounts in TileLeaf above the feed: visible when
  `starterCardVisibleForAgent(meta, entries)` — an agent-kind session whose
  committed entries hold no user turn. Derived, never stored: the first
  prompt lands as an entry and the card vanishes by itself; a restored
  session replays history and never sees one; there is no dismissal state to
  persist. Terminal views never mount it (AgentTerminalLeaf has no card,
  structurally), and the predicate itself refuses terminal/extension kinds
  so a future caller cannot reintroduce it.
- **Context B** extends the focused empty lane's hint in TiledDispatchLayout,
  under the same three conditions the hint has (focused, empty, the row
  offers agents) — the card advertises keys that act on `focusedLane`, and
  an unfocused or agentless lane would promise gestures that do nothing
  there. Four placement-flavored slots: Fill Lane, New Lane, Commands, and
  the ⌥↑/⌥↓ index walk.
- **⌘N now binds New Agent…** — the platform convention for "new thing",
  unclaimed by any command, reservation, or Electron role (New Window is
  ⌘⇧N). The card's second slot pointed at a command with no chord, and a
  card that says "New Agent" with no key teaches nothing.
- **Divergence from the ASCII walkthrough, recorded on purpose.** The
  walkthrough's card showed ⌘K Commands, ⌥L New Lane, ⌥R New Row, ⇧⌘S
  Spotlight. The shipped card shows the LIVE registry: ⌘⇧P Commands,
  New Lane/New Row title-only (they ship no default), ⌥S Spotlight — and
  ⌥L is Focus Lane Right, carrying years of inline-grammar muscle memory the
  walkthrough sketch overwrote by accident. Registry truth beats the sketch;
  that is what "registry-driven, always" means, and the sketch was
  illustrative in a way the plan's own §4.6 table already was not.

## 10. Testing strategy

Per `docs/testing/standard.md` — suffix picks the tier, each test protects
one contract:

- **Unit (`migrateWorkspaceShape.test.ts`):** v2→v3 golden files (grid-heavy
  workspace, dispatch workspace, mixed, corrupt); the accepted-loss rule
  (multi-pane tab leaves all pooled, none placed); seed-on-first-open.
- **Unit (`workspaceShape.test.ts`):** placement contract (lane ids resolve
  or are undefined), single-focus truth, wake-before-place at every writer.
- **Renderer:** spawn fills empty focused lane and never displaces an
  occupant; Clear Lane returns occupant to pool alive; killed agent leaves
  lane empty (existing #681 tests carry over); project rail sets
  activeProjectId without touching lanes; Spotlight/Reader open on the
  focused lane's session; **first-run workspace is one row × one lane,
  focused, with no mode-gated command visible in the palette**; no
  user-facing string in palette, shortcuts surface, or onboarding contains
  "Dispatch" (assert with a string audit over the command catalog — same
  shape as the title-noun checks `command-style.md` already prescribes).
- **Renderer (starter card):** fresh agent with zero user turns shows the
  card; sending the first prompt hides it (no persisted flag); an empty
  *unfocused* lane never shows keyed hints; a rebound command renders the
  user's chord, not the default (the anti-drift contract); a terminal lane
  never shows the card.
- **Migration fixtures** recorded from a real v2 workspace (the owner's,
  redacted) rather than imagined cases.
