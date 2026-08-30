# Grid Dispatch — stage decomposition

**Issue:** [#681](https://github.com/Juliusolsson05/agent-code/issues/681)
**Design:** `docs/superpowers/plans/2026-08-30-grid-dispatch-mode.md`
**Branch:** `feat/grid-dispatch-mode`

This document is the *stage* record. The plan says what Grid Dispatch is and why;
this says what gets built in what order, what artifact each stage produces, and —
the part the plan does not answer — **what real recorded evidence each stage is
built from.**

It is revised in place when a stage disproves it, per `docs/README.md`.

## Why this document exists at all

The design was approved and Stage 1 was implemented before this was written. That
ordering was wrong, and re-reading the work against the methodology surfaced a
concrete defect, recorded below as **U1**: the orchestration child cap was
specified — threshold, depth rule, and default — against a fan-out shape that
appears **nowhere in any recording this repository holds.** The number `3` and
the claim "children are always depth 1" came from imagination.

One of those two turned out to be right. Neither had been checked.

---

## A — what exists and is trusted

- `TiledDispatchState` = `{ lanes: DispatchLane[], focusedLane: number, ratios?: number[] }`,
  a single row of lanes, persisted inside `dispatchMode` in
  `~/.config/agent-code/workspace.json`.
- `buildVisibleDispatchRows(state)` — the canonical linear row order that
  `⌘N`, command targeting, lane resolution, and the rendered index all agree on.
- The lane-coherence helpers (`remapTiledLanes`, `clearTiledLaneSessions`,
  `keepTiledLaneSessions`) applied at nine call sites.
- `testing/fixtures/worktree-context/dispatch-global-d23.json` — a **real,
  redacted, persisted workspace**: 4 tabs, 24 sessions, 12 detached, 3
  orchestration parents, and a live `tiled` block using the legacy `ratios`
  format. Produced by `scripts/extract-work-context-fixtures.mts --refresh-workspace`.

## D — the end state

A Dispatch layout of up to 4 independently-sized rows, each a complete dispatch
view with its own index list, project binding, and list density; where no slot
is ever filled except by the user; and where a killed agent leaves its slot
empty instead of being replaced by an unrelated one.

---

## Stages

### Stage 1 — the shape algebra ✅ *done*

| Field | |
|---|---|
| **Produces** | `src/renderer/src/workspace/dispatch/gridShape.ts` + 56 tests across `gridShape.test.ts` and `gridShapeMutations.test.ts` |
| **Verified by** | Its own unit suite, with no UI and no workspace state. Independently checkable: every function is pure, total, and returns a coherent shape or `null`. |
| **Why separate** | The invariant `sum(rows[].length) === lanes.length` is the one thing in the grid that can desynchronize. A reducer that updates `lanes` without updating `rows` in the same expression is how it would, so the shape rules must exist and be provably correct *before* anything writes state through them. |
| **Reality check** | **Invented inputs, deliberately.** See the honesty note below. |

**Honesty note on Stage 1's fixtures.** These tests are built from literals like
`grid(['a','b','c','d'], [2,2], 0)`, not from recordings. That is defensible here
and nowhere else in this decomposition: `gridShape.ts` is a pure combinatorial
function over a data structure *this PR defines*, so no recording of it can
exist. The case set is the finite algebra of splice / clamp / refuse, not an
empirical distribution. The suite earned its keep immediately — it caught a real
defect (the legacy `ratios[0]` index-fraction migration was missing entirely).

Every stage after this one touches real workspace state, and the same excuse does
not transfer.

### Stage 2 — dispatch-index shape census ✅ *done, and deliberately small*

| Field | |
|---|---|
| **Produces** | The observations recorded below. **No new fixture, no new extractor, no maintained artifact.** |
| **Verified by** | Running the real `buildVisibleDispatchRows` / `buildDispatchGroups` over the real persisted workspace already in the repo, in both scopes |
| **Why separate** | Stages 7 and 8 filter this row stream. Filtering a stream whose shapes are guessed is how a feature ends up working only on the cases that happened to be in context. |
| **Reality check** | `testing/fixtures/worktree-context/dispatch-global-d23.json`, which already exists. |

**Scoping note.** An earlier draft of this stage proposed a counted catalog file
and a new extraction path. That is more apparatus than this feature earns: Grid
Dispatch is largely layout algebra over a structure this PR defines, not
multi-source reconciliation over an unknown case set. The census was worth
running *once* — it cost one script and produced three findings and one
correctness bug — and is not worth maintaining as an artifact. Recorded inline
below and then done with.

**Observed** (real fixture, real selectors, run 2026-08-30):

```
scope=project : 13 rows   depth histogram { 0: 7, 1: 6 }
  D1 D2↳ D3↳ D4 D5 D6 D7 D8 D9↳ D10↳ D11 D12↳ D13↳
scope=global  : 24 rows   depth histogram { 0: 18, 1: 6 }
  A1 A2 A3 A4 B5 B6 B7 B8 B9 B10 C11 D12 D13↳ D14↳ D15 … D23↳ D24↳
```

Three findings, all load-bearing:

1. **Children do land at `depth: 1`.** The spec's assumption survives contact
   with this recording. Confirmed, not assumed.
2. **`globalIndex` runs straight through nesting** — `D1, D2↳, D3↳, D4`. Hiding
   two children makes the visible list read `D1 … D4`. The design's claim that
   collapsing must produce *gaps* rather than renumbering is therefore correct,
   and now demonstrated rather than argued.
3. **Labels are scope-dependent**: the same session is `D2↳` in project scope and
   `D13↳` in global. Since row binding promotes scope to global, a bound row's
   labels differ from what the same agent shows today in project scope. That is
   consistent with the design but must be pinned by a test, because it is exactly
   the kind of drift the canonical-order rule exists to prevent.

### Stage 3 — delete auto-fill and the healer

| Field | |
|---|---|
| **Produces** | Removal of the heal `useEffect`, `buildAutoLanes`, and their tests; `noAutoFill.renderer.test.tsx` |
| **Verified by** | Replaying a real multi-lane workspace, killing the agent in a middle lane, and asserting that lane is empty and no other lane's agent moved |
| **Why separate** | It is the smallest change that fixes the reported confusion, it stands alone, and everything after it is simpler once nothing self-fills. |
| **Reality check** | `dispatch-global-d23.json` (4 tiled lanes, real ids) as the starting state for the kill transition. |

### Stage 4 — delete `userEmptied`

| Field | |
|---|---|
| **Produces** | Removal of the flag, its doc comment, and the flag-dropping in `withLaneSession` / `withLaneCleared` |
| **Verified by** | The Stage 3 suite still green; no reader of the field remains (`grep`) |
| **Why separate** | Only safe *after* Stage 3, and trivially safe after it. Merging them would make the diff argue two things at once. |
| **Reality check** | Persisted fixtures containing the flag must still rehydrate. |

### Stage 5 — row-aware state, reducers, and layout

| Field | |
|---|---|
| **Produces** | `rows`/`laneWeights` through `useDispatchActions`, `normalizeGridShape` on rehydrate, the stacked per-row layout |
| **Verified by** | `dispatch-global-d23.json` — whose `tiled` block uses the **legacy `ratios` format** — restoring as a coherent one-row grid with its 4 lanes, focus, and index fraction intact |
| **Why separate** | Migration correctness is verifiable on its own, against a real persisted file, before any new UI depends on it. |
| **Reality check** | That fixture's real `ratios: [0.1, 0.142…, 0.142…, 0.142…, 0.142…]`. The invented `[0.25, 1, 6, 2]` in the Stage 1 tests is a synthetic stand-in and must be **supplemented** by the real array here. |

### Stage 6 — commands, shape editor, keyboard

| Field | |
|---|---|
| **Produces** | New Row / Remove Row, the per-row shape editor overlay, `⌥⇧↑/↓` registered in `defaults.ts` |
| **Verified by** | `npm run check:keybindings`; ragged-shape command tests |
| **Why separate** | Chord admission is decided by the checker, not by this document. |
| **Reality check** | The existing binding table is the ground truth for what is free. |

> **Revision (2026-08-30).** The row-scoped SELECTOR half of Stages 7 and 8
> landed early, as `rowScopedRows.ts` with Stage 5. The layout needs a
> per-row row list to render at all, and building that seam twice — once
> stubbed, once real — would have been the churn this method exists to avoid.
> Stages 7 and 8 are now their CONTROLS: the picker surface, the header
> toggle, and the commands.

### Stage 7 — per-row project binding

| Field | |
|---|---|
| **Produces** | `projectTabId`, the row header control, the picker surface, the filter |
| **Verified by** | Filtering the real 24-row global census by tab and asserting the surviving labels are the canonical gapped ones (`D12`, `D15`, …) |
| **Why separate** | It is the first consumer of the Stage 2 census; building it before the census is the exact inversion this method forbids. |
| **Reality check** | Stage 2's catalog. |

### Stage 8 — orchestration child cap

| Field | |
|---|---|
| **Produces** | The per-row cap toggle, `+N more` / collapse rows, `expandedParents` |
| **Verified by** | The cap firing on a recorded parent whose child count actually exceeds it, and `buildVisibleDispatchRows` output being identical with the cap on and off |
| **Why separate** | It is the only part of this change whose *numbers* are unverified (U1), so it is the only part that should be independently revertable. |
| **Reality check** | The census above — which shows max 2 children per parent, i.e. **below the proposed cap.** |

**How U1 is handled without manufacturing a recording.** Capturing a real
ten-child fan-out purely to justify a constant would cost more than the constant
is worth. Instead the feature is built so the unverified number is not
load-bearing: the cap is one exported constant, the toggle is per-row, and the
behavior degrades to "no change" on every shape in the census (nothing is hidden
below the threshold). What must be *correct* rather than merely tuned is the
depth rule (U2) and the no-renumbering guarantee — both cheaply testable against
the fixture that already exists.

---

## What is being isolated

**`gridShape.ts`** is the hard part: the row descriptor over a flat lane array,
and every mutation of it.

- Single consumer: `useDispatchActions`. Commands call reducers; they do not
  compute shape.
- **Forbidden from importing it:** any component under `features/`, any painter,
  any command module. A component that computes row shape is a second source of
  shape truth, and the resulting bugs — a lane in the wrong row, a row length
  disagreeing with the lanes rendered — would look like layout bugs while being
  ownership bugs.
- `TiledDispatchLayout` receives a *normalized* grid and renders it. It never
  splices.

The deliberate non-isolation: `lanes` and `focusedLane` stay flat, so the nine
existing coherence call sites keep working untouched. Isolating the *shape* while
leaving the *lane list* exactly where every helper already expects it is the whole
architectural bet of this change.

---

## Unknowns

**U1 — the orchestration fan-out shape is unrecorded. Accepted, not blocking.**

The child cap exists to stop one parent's children burying the index. The design
specifies `ORCHESTRATION_CHILD_CAP = 3`, `depth: 1` only, and default-on.

The only real workspace recording available has **three parents with exactly two
children each**, so a cap of 3 never fires on it. The motivating case — a parent
spawning eight or ten reviewers — is described from experience but not captured.

*Decision:* ship it with the number treated as a tunable, not a finding. Nobody
should defend `3` in review; it is a starting value. The cap is inert on every
recorded shape, so the risk of being wrong is "the feature does nothing yet",
not "the index lies". If it turns out to need tuning, it is one constant.

**U2 — RESOLVED, and it was not a bug.** The concern was that
`buildDispatchGroups` emits a child at depth 0 when its parent is absent from
the same group (scope filter, closed parent, or a **pinned** parent, since pins
are pulled into their own section), so a cap keyed on `depth === 1` would
silently miss an orphaned child.

Working it through, not capping it is the *correct* behavior. An orphaned child
renders with its own canonical label at the top level and is visually
indistinguishable from an ordinary agent. Hiding it under a `+N more` belonging
to a parent the user cannot see would be strictly worse than showing it.

The cap therefore follows VISUAL nesting — the run of depth-1 rows after a
depth-0 row — which makes the orphan case right by construction rather than by
a special case. Pinned in `rowScopedRows.test.ts`
("does not cap a child that renders as a top-level row").

The flag was still worth raising: the rule is now held for a stated reason
rather than because it was the first thing written.

**U3 — mini-list capping is unmeasured.** The design caps strips as well as the
index. Ten extra chips in a 46px column may not actually be the same problem as
ten rows in the index, and capping the strip costs direct selectability. No
evidence either way.

**U4 — 16 total lanes is a guess.** No measurement of `renderWorkspaceLeaf` cost
at 8 vs 16 concurrent mounts exists. `project_screen_snapshot_gc_churn` says
per-session cost is real but not what the ceiling should be.

**U5 — out-of-scope lane retention is unverified.** §5.5 asserts a lane keeps
`selectedSessionId` when its session leaves scope and re-resolves when scope
returns. The scope-flip transition has not been replayed against real state.

---

## Fixture plan

Deliberately short. This feature needs one real fixture, and it already exists.

| Fixture | Source | Stage | Status |
|---|---|---|---|
| `gridShape` literals | invented (justified in Stage 1) | 1 | ✅ exists |
| `dispatch-global-d23.json` | real persisted workspace | 2, 3, 5, 7, 8 | ✅ exists |
| high-fan-out orchestration | not captured | 8 (U1) | ⏭️ accepted as unverified |

**No new corpus is being built for this change.** The one real workspace fixture
already carries what matters: a legacy `ratios` block to migrate, four live tiled
lanes to kill an agent inside, 24 rows across 4 projects to filter by project,
and real parent/child nesting to test the depth rule against.

The single rule that still holds absolutely: **no fixture may be hand-authored to
"look like" real data.** Inventing a plausible ten-child workspace to make the cap
testable would be testing imagination while appearing to test reality — worse than
the honest gap recorded in U1. Where a literal is used, this document names it and
says why.
