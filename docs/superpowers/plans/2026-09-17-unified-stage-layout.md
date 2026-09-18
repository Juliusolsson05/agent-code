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

`gridRelatedSelections` survives (peek is lane-local). `pinnedSessionIds`
survives. `Close Old Agents`, `Close Idle Orchestration Agents`, bulk close,
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
- **Three keyboard reservations were released** (split resize, directional
  split resize, Tile Tabs resize continuation). A reservation with no owner
  only fences off free chords. The macOS Option+Shift+Arrow record was kept in
  `useKeybinds` as a comment, because it is the only place that fact lives.
- **Related-agent mini-tabs are currently unreachable.** Only the recursive
  tree passed `showRelatedAgentTabs`; lanes pass `false`. `gridRelatedSelections`
  therefore has no writer on screen. Stage 4 decides whether lanes show the
  mini-tabs or the field is deleted; §2.1's "survives, lane-local" is a
  proposal until then.

**3b — invert the stored authority.** `Tab` loses `root` and
`focusedSessionId`; `dispatchMode` becomes a required `stage`;
`detachedSessions` and `buried` are deleted. Two consequences to settle there:

- `detachedAt` is the ONLY key ordering rows inside a project group. Deleting
  the record needs a replacement order key on `SessionMeta`, seeded by the
  migration from `detachedAt`, tree order for former leaves.
- Boot spawns tile leaves today. With no leaves, the honest rule is **lane
  occupants spawn, everything else stays parked**. That is bounded by the
  16-lane cap, unlike the invisible 40-record herd of #258, and it closes the
  restored-lane shape of #690 where a hibernated lane occupant rejects its
  first prompt. It is a behavior change for a workspace like the owner's
  (3 leaves spawn today, 12 lane occupants would) and is called out in the PR.

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
