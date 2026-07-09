# Layer isolation: ingest → decide → render as one-directional, grep-able folders

**Issue:** #493 · **Branch:** `refactor/layer-isolation` (worktree `.worktrees/layer-isolation`, based on `7c449f4`)
**Companion docs:** `docs/rendering/rendering-system.md`, `docs/rendering/rendering-design-principles.md` (PR #500) — they describe the three stages this plan physically isolates.

**Gates (every PR):** `npx tsc -b tsconfig.node.json` → `npx tsc --noEmit -p tsconfig.web.json` → `NODE_ENV=test npx vitest run` → `npx vite build --config src/remote-client/vite.config.ts` (the phone client deep-imports the moved modules; electron-vite build does NOT cover it). No behavior change anywhere in this plan — pure moves, import-specifier rewrites, and contract typing. No new test files; colocated tests move with their subjects.

**The general goal this serves** (stated by the user, 2026-07-09, and the standing yardstick for this and every follow-up): the project must stay **modular as it grows** — a codebase heading toward 150k lines of intertwined work becomes unmaintainable, because no future session can hold "everything mixed into everything" in its head. The unit of maintainability is a folder that can be understood, changed, or replaced **alone**: one job, one declared input contract, one declared output contract, dependencies pointing one way. #493 (this plan) applies that to the renderer's three layers, which are today's worst offender; §7 maps where the same treatment goes next. When any decision in this plan has a "smaller diff" option and a "cleaner module boundary" option, the boundary wins — that is the whole point.

---

## 0. Ground truth from the full read (what the issue got right, and where the code disagrees)

A four-way sweep (ingest inventory, complete rendering/ cross-import list, feed contracts + remote-client mount, build/alias/test wiring) established these facts. Every step below is derived from them; where they contradict issue #493's sketch, the plan follows the code.

### 0.1 Confirmed as the issue describes

- **Ingest has no home.** Stages 3–6 live across `workspace/` next to ~40 UI files: `workspace/semantic/{foldEvent,helpers,summarize,streamPhaseMachine}.ts`, `workspace/ghosts.ts`, `workspace/mergedEntries.ts`, plus the ingress inside `workspace/hook/ipc/useIpcSubscriptions.ts` (1,984 lines).
- **The input pick already exists but is undeclared.** `RuntimeLedgerSlices` (`rendering/adapter/collectLedgerInput.ts:78`) is exactly the slice the ledger consumes: `entries, semanticCurrent, semanticHistory, ghosts, streamPhase, lastJsonlEntryAtMs` (+ provider/sessionId). It's assembled ad-hoc inside `useLedgerFeedItems.ts:47-56` from a full `SessionRuntime`.
- **The output seam is inverted.** `rendering/view/ledgerFeedItems.ts` imports `FeedRenderItem`/`FeedRenderItemOrder` (renderModel), `VisibleDecision` (feed/types), and `groupSemanticActivity` (renderUnits) — rendering → feed, the wrong direction.
- **No tooling changes needed.** `@renderer/*` is the only alias covering the tree (declared 5×: tsconfig.web, tsconfig.node, electron.vite.config, vitest.config, remote-client vite.config — all prefix-level, none folder-specific). Imports are ~100% alias-style (1,057 `@renderer/` imports inside the renderer tree; 0 real relative cross-folder imports). Vitest project globs are `src/**`. So every move is a pure specifier rewrite: **zero config edits**, and `tsc` catches every missed site (there is no ESLint/dep-cruiser — the tsc gate and a one-off grep are the entire enforcement, per the issue's own acceptance).

### 0.2 Where the code disagrees with the issue (each is a numbered decision in §5)

1. **The production rendering→workspace back-edges are ALL type-only.** Every value-level back-edge into ingest lives in `rendering/replay/reconstructSlices.ts` (`foldSemanticEvent`, `reduceStreamPhase`, `ghostsFromSemanticTurn`, `reconcileUpstream`, `emptySemanticRuntime`) — and those are *deliberate*: replay re-runs the real production reducers over recorded wire events (Option A′). Once the reducers live in `session-runtime/`, these imports become sanctioned contract imports, not violations. → Decision D1.
2. **feed → rendering is already clean.** Zero imports from `features/feed/` into `rendering/` exist. Items reach Feed via the `renderItemsOverride` prop, wired by exactly two callers of `useLedgerFeedItems`: `workspace/tile-tree/TileLeaf.tsx:35` and `src/remote-client/src/ui/SessionView.tsx:5`. PR-3 is therefore only about relocating the view stage, not untangling feed.
3. **Only TWO value-level forward-edges exist** (rendering → feed): `groupSemanticActivity` (renderUnits.ts:396 — single caller: the bridge) and `isAgentSpawnToolName` (agentSpawnTools.ts — a thin delegator over `@providers/registry.renderer.capabilities`, also used by two feed rows). Everything else is 4 type-only `FeedRenderItem` sites.
4. **Issue PR-2 and PR-3 contradict each other on `groupSemanticActivity`.** PR-2 says move it into `rendering/view/`; PR-3 moves the whole view stage (the bridge) into `features/feed/`. If both happen, the function's only caller ends up back in feed importing it from rendering — pointless churn. The end state decides: the bridge and its presentation grouping are RENDER-layer; both live in feed. → Decision D3.
5. **Stage 3 (ingress+commit) is bigger and more UI-entangled than "one file".** `useIpcSubscriptions.ts` interleaves pure ingest (fold → phase → ghosts → entry commit → dedup → tool indexes → provider identity) with pane-UI writes (`withUnread` badges, `applyConditionSnapshot`'s composer `picker` + legacy `pending*` overlay mirrors, `promptSuggestion` chips, `bootstrapping` scroll control, worktree decoration, feed-debug taps). And it is not the only committer: `hook/actions/initialHistory.ts` (initial load), `hook/actions/history.ts:125` (pagination prepend), `hook/actions/streaming.ts` (optimistic submit), `hook/actions/session.ts:355-395` (ghost-journal bootstrap merge) all mutate the same runtime fields. Moving the hook wholesale would drag `hook/context`, `hook/refs`, `conditions/selectors`, and `features/debug/renderTrace` into `session-runtime/` — violating "imports no UI" on day one. → Decision D2 (the hook stays; the pure reducers move).
6. **`SessionRuntime` is ~60 fields, not 7-vs-rest.** Beyond render-input and pane-UI it holds lifecycle/status (`sessionStatus`, `processStatus`, `transcriptStatus`, `inputReady`, `exited`, …), history paging (`historyOldestMarker`, `hasOlderHistory`, `bootstrapping`), work-context decoration, debug streams (`feedDebugLog`), tool indexes (`toolUseIndex`/`toolResultIndex`/`toolIndexVersion`), screen mirrors, and the deprecated `pending*` condition caches. The PR-2 contract must be an honest *pick* (what DECIDE reads), not a two-way partition of the whole type. → Decision D4.
7. **`rendering/policy/foldPolicy.ts` is dead.** No consumer anywhere except its own test (grep hits outside rendering/ are the unrelated legacy `semanticFoldPolicy` provider capability). → Decision D6.
8. **The remote client is a first-class importer.** `src/remote-client/src/transcript/store.ts` imports `foldSemanticEvent`, `reduceStreamPhase`/`StreamPhaseState`, `indexEntryIntoMaps` (from `workspace/entries/utils`), `emptySemanticRuntime` + types; `SessionView.tsx` imports `useLedgerFeedItems`, `Feed`, and `type SessionRuntime` (which it satisfies via an `as unknown as SessionRuntime` cast over a minimal 7-field object at :101). The phone client is the strongest evidence stages 4–5 are already host-agnostic — and every move must update its specifiers. Its five stub aliases (`lib/code/CodeBlock`, `app-state/hooks`, `performance/client`, `features/rendered-content/Safe*`) target none of the moved paths, so the stub table is untouched.

### 0.3 The load-bearing invariant no move may break

**D11 reference stability.** The adapter caches per PLANE on the exact runtime slice references (`entries`, `semantic.currentTurn`, `semantic.history`, `ghosts`), composing with the ledger's own cache into "no real change ⇒ same `LedgerInput` fields ⇒ same items array ⇒ no Feed re-render". Pure file moves cannot break this; the only signature change in this plan (PR-2's `RuntimeRenderInput`) narrows a *type*, never re-wraps a value, so every reference flows through unchanged. Any step that would require constructing a new object on the hot path is out of scope by definition.

---

## 1. End state

```
src/renderer/src/
├── session-runtime/        # INGEST — channels → one clean per-session object
│   ├── state.ts            #   SessionRuntime + semantic/status/debug types + emptyRuntime()
│   │                       #   + RuntimeRenderInput (the declared DECIDE-facing pick, PR-2)
│   ├── semantic/           #   foldEvent, helpers, summarize, streamPhaseMachine (+ colocated tests)
│   ├── ghosts.ts           #   ghost reducer + semantic→ghost bridge
│   ├── mergedEntries.ts    #   committed ⊕ orphan-ghost merge (selectMergedEntries)
│   ├── entries.ts          #   indexEntryIntoMaps, entryTextContent, summarizeEntryForDebug
│   ├── providerSessionIdentity.ts, claudeQueueReconstruction.ts, queueInvariants.ts
│   └── feedDebug.ts        #   appendFeedDebugLog (runtime-owned debug stream)
├── rendering/              # DECIDE — RuntimeRenderInput → RenderLedger (rows + decisions)
│   ├── adapter/ observations/ model/ replay/ shadow/   # view/ dissolves in PR-3; policy/ deleted in PR-2
├── features/feed/          # RENDER — RenderRow[] → FeedRenderItem[] → JSX
│   ├── ledger/             #   ledgerFeedItems (bridge) + useLedgerFeedItems (producer hook), from PR-3
│   └── …                   #   FeedRenderItem stays in model/renderModel.ts (already home)
└── workspace/              # UI shell + wiring: hook/ (incl. useIpcSubscriptions), tile-tree/, layout, panes
```

**The dependency law (import direction is the reverse of data flow):**

- `session-runtime/` imports ONLY `@shared/*`, `@providers/registry.renderer.capabilities` (fold-policy capability gate — data, not UI), `agent-transcript-parser` — **never** `workspace/`, `rendering/`, `features/`, or `react`.
- `rendering/` imports ONLY `session-runtime/` (types everywhere; reducer values in `replay/` only), `@shared/*`, `@providers/*` (replay's entry mapper) — **never** `features/*`, `workspace/*`, or `react` (the react hook leaves with PR-3).
- `features/feed/` imports `rendering/` + `session-runtime/` + its own tree. `workspace/` (the shell) may import everything — it is the composition root where IO, React, and pane policy legitimately meet.

`useIpcSubscriptions` staying in `workspace/hook/` does **not** violate the issue's acceptance ("`session-runtime/` imports no UI"): the hook is the IO/wiring shell that *calls* the ingest reducers, exactly like `ghosts.ts`'s own header invariant already demands ("No function here performs IO. No function here subscribes to events."). The reducers are the layer; the hook is plumbing.

---

## 2. PR-1 — extract the ingest layer (`refactor/layer-isolation`, this branch)

Pure moves + one type-file split + mechanical specifier rewrites. Zero logic edits.

### 2.1 File moves (`git mv`, history preserved)

| From (`src/renderer/src/`) | To (`src/renderer/src/`) |
|---|---|
| `workspace/semantic/foldEvent.ts` | `session-runtime/semantic/foldEvent.ts` |
| `workspace/semantic/helpers.ts` | `session-runtime/semantic/helpers.ts` |
| `workspace/semantic/summarize.ts` | `session-runtime/semantic/summarize.ts` |
| `workspace/semantic/streamPhaseMachine.ts` | `session-runtime/semantic/streamPhaseMachine.ts` |
| `workspace/semantic/scrollSignal.test.ts` | `session-runtime/semantic/scrollSignal.test.ts` |
| `workspace/ghosts.ts` | `session-runtime/ghosts.ts` |
| `workspace/mergedEntries.ts` | `session-runtime/mergedEntries.ts` |
| `workspace/entries/utils.ts` (+ `utils.test.ts`) | `session-runtime/entries.ts` (+ test) |
| `workspace/providerSessionIdentity.ts` (+ test) | `session-runtime/providerSessionIdentity.ts` (+ test) |
| `workspace/claudeQueueReconstruction.ts` (+ test) | `session-runtime/claudeQueueReconstruction.ts` (+ test) |
| `workspace/queueInvariants.ts` | `session-runtime/queueInvariants.ts` |
| `workspace/runtime/feedDebug.ts` | `session-runtime/feedDebug.ts` |

The last five are stage-3 policy/bookkeeping modules the issue didn't name but the sweep proved are pure ingest (imported only by the ingress paths + their tests; no React, no UI). Leaving them behind would leave "ingest has no home" half-true.

**Explicitly NOT moving** (each is workspace-shell wiring, not layer content): `workspace/hook/ipc/useIpcSubscriptions.ts` and everything under `workspace/hook/` (see D2); `workspace/conditions/selectors.ts` (half ingest-clear, half pane-attention policy — it stays with its UI half); `workspace/hook/ipc/applyPromptSuggestionToRuntime.ts` (pure but hook-flow-coupled and hook-local).

### 2.2 Split `workspaceState.ts` (688 lines) into `session-runtime/state.ts` + a slimmed `workspace/workspaceState.ts`

`session-runtime/state.ts` receives everything the runtime object is made of:

- Semantic types: `SemanticLiveBlock`, `SemanticTodoItem`, `SemanticTaskSnapshot`, `SemanticToolCallSnapshot`, `SemanticLookupSnapshot`, `SemanticLiveTurn`, `SemanticFlow`, `SemanticLogEntry`, `SemanticErrorEntry`, `SemanticRuntimeState`
- Status enums: `SessionStatus`, `SessionStatusSource`, `TranscriptStatus`, `ProcessStatus`, `StreamPhase`
- Debug types: `FeedDebugLayer`, `FeedDebugEntry`
- The runtime: `SessionRuntime`, `emptyRuntime()`, `emptySemanticRuntime()`, `parseSemanticTodos()`
- The pane-UI field types **embedded in** `SessionRuntime`: `PickerItem`, `SlashPickerState`, `QueuedMessage`, `RenderedViewLeaseFeature`, `ClaudeDraftImage`, `PendingRewindUndo`. These ride along because `SessionRuntime` references them and `session-runtime/` must not import `workspace/`. They are serializable state descriptors, not UI code — "imports no UI" means no components/hooks/features, which holds. (PR-2 then makes the *contract* — who may read which slice — explicit without needing to physically separate the types.)

`workspace/workspaceState.ts` keeps only the layout types that were never runtime state (`SpotlightState`, `ReaderModeState`, `TileTabsState`) — or, if that residue is too thin to justify the filename, fold them into `workspace/types.ts` and delete the file. Decide at execution by which yields fewer touched imports; both are fine.

**No re-export shims.** All ~90 importer files get their specifiers rewritten (`@renderer/workspace/workspaceState` → `@renderer/session-runtime/state`, etc.). Rationale: imports are 100% alias-based, `tsc` on both projects flags every missed site, and shims are exactly the "everything mixed into everything" residue #493 exists to kill. This also retires the `workspace/workspaceStore.ts` compat shim: update its 4 remaining importers (`tile-tree/TileLeaf.tsx:13`, `features/debug/ui/DebugPanel.tsx:4`, `tile-tree/TileLeaf/PaneHeader.tsx:4`, `tile-tree/TileLeaf/useComposerKeybinds.ts:7`) to import directly, delete the shim (opportunistic cleanup, in blast radius — the shim's only remaining job was aliasing the files this PR moves).

### 2.3 Mechanical rewrite scope (from the sweep — verify with grep, not memory)

- `@renderer/workspace/semantic/*` → `@renderer/session-runtime/semantic/*`: importers include `workspace/hook/ipc/useIpcSubscriptions.ts`, `workspace/hook/{helpers,actions/streaming}.ts`, `features/feed/ui/Feed.tsx:55` (`semanticTurnScrollSignal`), `rendering/replay/reconstructSlices.ts`, `src/remote-client/src/transcript/store.ts`.
- `@renderer/workspace/ghosts` → `@renderer/session-runtime/ghosts`: `useIpcSubscriptions.ts`, `hook/actions/{session,initialHistory}.ts`, `rendering/replay/reconstructSlices.ts`.
- `@renderer/workspace/mergedEntries` → `@renderer/session-runtime/mergedEntries`: single code importer, `workspace/tile-tree/TileLeaf.tsx:15-18`.
- `@renderer/workspace/entries/utils` → `@renderer/session-runtime/entries`: `useIpcSubscriptions.ts`, `hook/actions/initialHistory.ts`, `src/remote-client/src/transcript/store.ts:7`.
- `@renderer/workspace/workspaceState` → `@renderer/session-runtime/state`: 73 direct importers across `workspace/`, `features/`, `rendering/`, `app-state/`, `providers/*/renderer`, `remote-client` (the feed's 13 are almost all type-only; the two value imports are `parseSemanticTodos` in `BlockRow.tsx:19` and — via helpers — `semanticTurnScrollSignal` in `Feed.tsx:55`).
- The moved files' own intra-imports (they self-reference via alias, e.g. `foldEvent.ts` imports `@renderer/workspace/semantic/helpers`).
- Comment hygiene: `reconstructSlices.ts` hard-codes `useIpcSubscriptions` line numbers 9× as its mirror-source references — refresh them; same for the `workspaceState.ts:544` / `ghosts.ts` cross-references to moved paths.

### 2.4 PR-1 acceptance

- Gates green (§ header). Bundle + recording corpus pass untouched (fixtures live under `testing/fixtures/`, resolved relative to the un-moved corpus tests in `rendering/`).
- One-off grep: `grep -rn "@renderer/\(workspace\|features\|app-state\)\|from 'react'" src/renderer/src/session-runtime/` → **empty**.
- `git log --follow` traces every moved file.

---

## 3. PR-2 — declare the input contract (branch `refactor/render-input-contract` on top of PR-1)

### 3.1 `RuntimeRenderInput` — the DECIDE-facing pick

In `session-runtime/state.ts`:

```ts
/** The slice of SessionRuntime the DECIDE layer (rendering/) may read.
 *  This is a PICK, not a partition: SessionRuntime's other ~50 fields are
 *  pane-UI / lifecycle / paging / debug state that the ledger must never
 *  see (issue #493 finding 2). Kept structurally satisfiable by the full
 *  SessionRuntime so call sites pass `runtime` unchanged — the D11
 *  reference-identity chain (adapter plane caches keyed on these exact
 *  references) survives because no wrapper object is ever constructed. */
export type RuntimeRenderInput = Pick<
  SessionRuntime,
  | 'entries'
  | 'semantic'
  | 'ghosts'
  | 'streamPhase'
  | 'streamPhasePendingToolName'
  | 'streamPhasePendingToolUseId'
  | 'lastJsonlEntryAt'
>
```

That field list is exactly what the sweep found the decide layer reads: `useLedgerFeedItems.ts:47-56` (slices + memo deps) ∪ `ledgerFeedContextFromRuntime` (entries, ghosts, semantic, streamPhase + pending-tool pair). Not the issue's speculative 7 (`conditions`, `screen`, `totalEntries` are read by workspace/feed surfaces directly, never by the ledger — putting them in the contract would over-promise).

Changes:
- `useLedgerFeedItems(runtime: RuntimeRenderInput, …)`, `ledgerFeedContextFromRuntime(runtime: RuntimeRenderInput, …)`, `replay/recordedSession.ts`'s `SessionRuntime` usage → `RuntimeRenderInput`. Desktop/remote call sites pass the same object as before (structural subtype) — zero runtime diff.
- **Remote win:** `SessionView.tsx:101`'s `as unknown as SessionRuntime` cast over its minimal store object becomes an honestly-typed `RuntimeRenderInput`. Delete the cast.
- `adapter/collectLedgerInput.ts`'s `_SemanticTurnSeam` assertion keeps its type-only import of `SemanticLiveTurn` — now from `@renderer/session-runtime/state`, which is a sanctioned contract import. `RuntimeLedgerSlices` stays as-is (it is the *internal* adapter shape; `RuntimeRenderInput` is the *external* promise).

### 3.2 Cut the last non-contract edges out of `rendering/`

- **`isAgentSpawnToolName`** moves from `features/feed/lib/agentSpawnTools.ts` into `src/providers/registry.renderer.capabilities.ts` (it is a one-function union over `getRendererProviderCapabilities(kind).isSpawnTool` — provider capability surface, which that registry already owns and whose comment at :83 already references it). Update: `rendering/observations/committed.ts:12`, `features/feed/ui/rows/ConversationRow.tsx:11`, `features/feed/ui/rows/Block.tsx:28`, move the colocated test. After this, `rendering/`'s only feed imports are the type-only `FeedRenderItem`/`VisibleDecision` sites and `groupSemanticActivity` — all of which live in the view stage that PR-3 relocates wholesale.
- **Delete `rendering/policy/foldPolicy.ts` + test** (D6): zero consumers since the Stage-3 cutover; the D10 provider-asymmetry idea it encoded now lives (actively consumed) in the provider capability `semanticFoldPolicy` gate inside `foldEvent.ts`. Git history preserves it; resurrecting a dead "designed-for-later" module is cheaper than maintaining its false promise of being wired.

### 3.3 PR-2 acceptance

- Gates green; corpus green.
- Grep: `grep -rn "@renderer/session-runtime" src/renderer/src/rendering/ | grep -v replay | grep -v test` shows **type-only** imports (`RuntimeRenderInput`, `SemanticLiveTurn`, `StreamPhase`); value imports of session-runtime appear **only** under `rendering/replay/` (D1).
- `grep -rn "@renderer/workspace" src/renderer/src/rendering/` → **empty**.

---

## 4. PR-3 — flip the output seam (branch `refactor/flip-view-seam` on top of PR-2)

### 4.1 Move the view stage into the render layer

| From | To |
|---|---|
| `rendering/view/ledgerFeedItems.ts` (+ test) | `features/feed/ledger/ledgerFeedItems.ts` (+ test) |
| `rendering/view/useLedgerFeedItems.ts` | `features/feed/ledger/useLedgerFeedItems.ts` |

`rendering/view/` then ceases to exist. The bridge's imports all become legal: `FeedRenderItem`/`VisibleDecision`/`groupSemanticActivity` are now same-layer siblings; `RenderLedger`/`RenderRow` come from `@renderer/rendering/model/types` (feed → rendering, the sanctioned direction); `RuntimeRenderInput`/`SemanticLiveTurn` from session-runtime. The react import (`useMemo`/`useRef`) leaves `rendering/` entirely — the decide layer becomes framework-free, which is also what makes it trivially node-testable.

**`groupSemanticActivity` stays in feed** (D3 — superseding issue PR-2's "move it into rendering/view"): after this PR its only caller (the bridge) is feed-side again. Optional tidy within blast radius: relocate it + `SemanticRenderUnit` from `ui/semantic/renderUnits.ts` into `feed/ledger/` beside its caller, leaving `buildSemanticRenderUnits` (whose remaining consumers are `hook/actions/streaming.ts` and `saveDebugBundle.ts`) where it is. Do it only if the diff stays readable; it's cosmetic.

Update the two consumers: `workspace/tile-tree/TileLeaf.tsx:35` and `src/remote-client/src/ui/SessionView.tsx:5` → `@renderer/features/feed/ledger/useLedgerFeedItems`.

### 4.2 Break replay's dependence on the bridge (the one place PR-3 needs a real edit)

`rendering/replay/recordedSession.ts` currently imports `ledgerToFeedItems` + `ledgerFeedContextFromRuntime` + `type FeedRenderItem` to populate `ReplayTick.feedItems`. After the move that would be rendering → feed — the exact inversion this PR kills. Fix by injection:

- `ReplayOptions` gains `projectItems?: (ledger: RenderLedger, slices: RuntimeRenderInput & { provider; sessionId }) => { items: unknown[]; dropped: string[] }`; `ReplayTick.feedItems: unknown[]` (empty when no projector given). The harness's own responsibilities — reconstructing slices, running adapter+ledger, `assertInvariants` — never needed feed items (`invariants.ts` has no `FeedRenderItem` import; it checks ledger promises).
- Tests that assert on items (`replay/recordedSession.test.ts`, corpus tests if they touch `feedItems`) inject the real bridge from `@renderer/features/feed/ledger/ledgerFeedItems` — test files are outside the layer contract (the acceptance grep excludes `*.test.ts`), and injecting the production bridge keeps them end-to-end honest rather than duplicating it.

### 4.3 PR-3 acceptance (= issue #493 acceptance, verified one-off)

```
grep -rn "@renderer/features\|@renderer/workspace\|from 'react'" src/renderer/src/rendering/ --include='*.ts' | grep -v '\.test\.'   # → empty
grep -rn "@renderer/\(workspace\|features\|app-state\)\|from 'react'" src/renderer/src/session-runtime/                              # → empty
grep -rn "@renderer/rendering" src/renderer/src/ --include='*.ts*' -l                                                                # → only features/feed/ledger/* + rendering-internal
```

Three folders, one-directional; ledger consumes exactly `RuntimeRenderInput`, emits exactly `RenderLedger`/`RenderRow[]`; the bridge to `FeedRenderItem` is feed-owned. Full gates + corpus green on each PR independently AND on a local merge-simulation of the stack onto main (per the stacked-branch verification memory).

---

## 5. Decisions (deviations from issue #493, each backed by §0 evidence)

- **D1 — replay's reducer reuse is sanctioned, not a violation.** `reconstructSlices.ts` importing `foldSemanticEvent`/`reduceStreamPhase`/ghost reducers is the point of Option A′ (replay through the REAL production fold, so corpus tests exercise what ships). Post-PR-1 these are contract imports of the ingest layer. The dependency law is stated as "value imports of session-runtime only under `rendering/replay/`".
- **D2 — `useIpcSubscriptions` stays in `workspace/hook/`.** The issue's PR-1 wanted "the runtime-mutating ingress action" moved; the sweep shows the ingress is (a) four committers, not one, and (b) interleaved with pane-UI policy (unread badges, condition overlay mirrors, composer picker, bootstrap scroll gating) that a behavior-preserving PR cannot split out. The hook is IO wiring — the layer boundary is the reducers it calls, all of which DO move. The issue's actual acceptance criterion ("session-runtime imports no UI") is satisfied. A future "ingress split" (pure per-event appliers extracted from the hook, UI decorators layered on top) is real work with behavior risk — its own issue if ever wanted, not a rider here.
- **D3 — `groupSemanticActivity` ends up feed-side, not rendering-side.** Issue PR-2 and PR-3 contradict each other (§0.2·4); the end state after the seam flip puts the bridge and its presentation grouping in the same (render) layer, so the interim move would be churn. Presentation grouping ("fold N churn tools into a receipt") is render-layer by the docs' own taxonomy — the ledger decides *visibility*, the bridge decides *presentation*.
- **D4 — `RuntimeRenderInput` is the 7 fields the ledger actually reads**, not the issue's guessed list (`conditions`/`screen`/`totalEntries` excluded — no decide-layer reader exists; including them would silently license future back-door reads, the opposite of a contract).
- **D5 — no re-export shims; kill the `workspaceStore.ts` shim.** Alias-based imports + the two-project tsc gate make a full specifier rewrite safe and grep-clean; shims are drift.
- **D6 — delete dead `policy/foldPolicy.ts`** (opportunistic cleanup, in blast radius).
- **D7 — the five unnamed pure ingest modules move too** (`entries/utils`, `providerSessionIdentity`, `claudeQueueReconstruction`, `queueInvariants`, `feedDebug`) — same layer, same evidence standard (pure, ingest-only importers), and leaving them scattered would fail the issue's "one grep-able folder" goal in spirit.

## 6. Risks and how each is pinned

- **Missed import site** → caught by tsc web+node (the only gate that type-checks; build/vitest do not). Run after every move batch, not once at the end.
- **Remote client breakage** → `vite build --config src/remote-client/vite.config.ts` added to the per-PR gate (it is NOT covered by `electron-vite build`); its 5 stub aliases target untouched paths; verify no moved file lands on a stubbed specifier.
- **D11 identity regression** → no value re-wrapping anywhere (contract is `Pick`, call sites pass the same object); the bundle corpus + recording replay + `adapter/collectLedgerInput.test.ts` cache-identity tests all run per PR and would catch a re-render storm as a diff/invariant failure.
- **Corpus fixture paths** → corpus tests stay at `rendering/` root; `testing/fixtures/**` untouched.
- **tsc TS6305 ordering** → always `tsc -b tsconfig.node.json` before the web `--noEmit` (fresh worktrees fail otherwise).
- **Stacked-PR drift** → merge-simulate the stack (PR-1+2+3 onto current main) before opening PR-3, per the verification memory.

## 7. Beyond this stack — the app-wide modularity map (where the same treatment goes next)

This stack fixes the renderer's layer smear. The sweep surfaced the remaining intertwine zones, in rough order of pain. None are in scope here; each is a future issue with the same yardstick (one folder, one job, typed contracts, one-way deps):

1. **`workspace/hook/` — the `useWorkspace` mega-composition.** `hook/index.ts` composes ~25 hook modules; `useIpcSubscriptions.ts` alone is 1,984 lines interleaving four ingest committers with pane-UI policy (§0.2·5). The D2 follow-up ("ingress split": pure per-event runtime appliers in `session-runtime/`, UI decorators layered in the hook) is the single highest-value modularity move left after this stack — it would shrink the hook to wiring and make every commit path unit-testable without React.
2. **Provider plug-and-play (#394) + headless channel triplication.** The `Semantic*/Screen*/Committed*` ×3 duplication across the headless packages and the per-provider renderer halves is the neutral-hub refactor already mapped in #394 / agent-transcript-parser#5. Explicitly out of scope here (the issue says so) — but it is the same disease at the package boundary.
3. **Main process (`src/main/`).** `RemoteServer`/`RemoteController`, recording, ghost journal, MCP, proxy management all live flat. Nothing here reaches into renderer internals (the preload boundary enforces that), but main has no internal layer story of its own yet. Candidate once the renderer stack lands.
4. **`workspace/` residue.** After PR-1, what remains in `workspace/` is genuinely shell (tile-tree, layout, dispatch, hook wiring, conditions-UI) — but `tile-tree/TileLeaf.tsx` is a 600+-line pane god-component that maps runtime → Feed props by hand (`:475-573`, mirrored by the remote client). A declared "pane view-model" contract would kill that duplication; note the remote `SessionView` already had to copy it once.
5. **`shared/` as the contract home.** The 9-channel `SessionFeed` boundary (`shared/sessionFeed/`) is already the model citizen — every future cross-process contract should follow it there rather than growing ad-hoc type imports across trees.

The enforcement stance stays the same everywhere (per the no-enforcement-bloat rule): typed contracts + the two-project tsc gate + a one-off grep in each PR description. No CI locks, no lint walls.

## 8. Execution order

1. PR-1 on this branch (`refactor/layer-isolation`): §2 moves + split + rewrite, gates, open PR referencing #493.
2. PR-2 (`refactor/render-input-contract`, stacked): §3, gates, open PR.
3. PR-3 (`refactor/flip-view-seam`, stacked): §4, gates + stack merge-simulation, open PR with the §4.3 acceptance greps pasted into the description (the issue's "verified by a one-off grep, not a CI lock").
4. After all three merge: close #493 quoting the acceptance greps; refresh `docs/rendering/rendering-system.md`'s "where to look" index for the new paths (one-file docs PR or rider on PR-3).
