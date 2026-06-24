# Feed / Conditions / Weirdness — Implementation Log

Branch: `cluster/feed-conditions-weirdness` (base `integration/deep-audit-cleanup`)

Cluster ownership: feed rendering correctness, semantic scroll/renderability, tool
index invalidation, condition lifecycle/source-of-truth, stale condition surfaces,
and high-confidence weirdness/typecheck cleanup. Sources:

- `feed-rendering.md`
- `conditions-framework.md`
- `cross-app-weirdness.md`
- `deep-audit-master-roadmap.md`

Other clusters work in parallel; this log records only clearly-owned pieces and
documents dependencies/overlaps where they exist.

---

## Pass 1 — Summary

Implemented the highest-confidence correctness fixes from all three plans plus the
safe cleanup tail, each with focused unit tests and thick WHY comments.

### Implemented (with tests)

| # | Item | Plan ref | Files |
|---|------|----------|-------|
| 1 | Session exit clears condition state; `hasVisibleConditions` for hybrid promotion | conditions Finding 2 + Additional A / roadmap E7 | `conditions/selectors.ts`, `hook/ipc/useIpcSubscriptions.ts`, `agentDisplayMode.ts` (+tests) |
| 2 | Tool-index version invalidation token | feed Finding 1 / roadmap E5 | `entries/utils.ts`, `workspaceState.ts`, `useIpcSubscriptions.ts`, `initialHistory.ts`, `Feed.tsx`, `context.tsx`, `TileLeaf.tsx` (+tests) |
| 3 | Semantic auto-scroll observes block deltas (`semanticTurnScrollSignal`) | feed Finding 2 / roadmap E6 | `semantic/helpers.ts`, `Feed.tsx` (+tests) |
| 4 | Semantic renderability means "paints DOM" (`semanticRenderUnitPaintsDom`) | feed Finding 3 | `semantic/renderUnits.ts` (+tests) |
| 5 | Codex subagent structured array output (`textFromCodexOutput`) | feed Finding 11 | `subagents/codexSubagentState.ts` (+tests) |
| 6 | Codex resume sanitizer uses shared array-rejecting `asRecord` | cross-app Finding 10 / feed Finding 10 | `providerSwitch/codexResumeSanitizer.ts` (+tests) |
| 7 | Reader Mode picker-lease guard (`readerMode`, not `reader`) | cross-app V1 | `app/App.tsx` |
| 8 | `CodeRenderContext` direct imports + Feed re-export removed | feed Finding 8 / Deletion Candidate 2 | `ClaudeRows.tsx`, `CodexRows.tsx`, `ReaderView.tsx`, `Feed.tsx` |
| 9 | Dead `activityStatus` Feed prop + TileLeaf pass-through removed | feed Deletion Candidate 1 | `Feed.tsx`, `TileLeaf.tsx` |
| 10 | Stale "Claude-only" semantic-event comments corrected | feed Additional Finding 1 / Deletion Candidate 5 | `sessionManager.ts`, `preload/api/types.ts` |
| 11 | `ConditionOutlet` render-order comment aligned with design doc | conditions Finding 9 | `conditions-core/ConditionOutlet.tsx` |
| 12 | `conditions-core:check` drift guard + npm scripts | conditions Finding 10 | `scripts/sync-conditions-core.mjs`, `package.json` |
| 13 | Latent null-narrowing fix in `extractCodexChildMeta` | cross-app V2 class (typecheck cleanup) | `subagents/codexSubagentState.ts` |

### Key invariants introduced (thick WHY comments in code)

- **Tool-index version token** (`workspaceState.ts`, `entries/utils.ts`,
  `Feed.tsx`, `context.tsx`): the runtime mutates the tool maps in place behind a
  stable reference, so map identity can't tell React context a cross-entry
  pairing moved. `indexEntryIntoMaps` now returns whether it changed; ingest
  paths bump `toolIndexVersion`; Feed clones the map (cheap, only on bump — keyed
  on the version, NOT `entries`) so context invalidates without re-introducing
  the O(N²) bootstrap rebuild.
- **Semantic scroll signal** (`semantic/helpers.ts`): scroll invalidation must
  observe per-block content growth (text/thinking/tool-input/tool-output/reasoning
  + status/resultAt), not just turn text + block count. Cheap length scan, not a
  JSON stringify.
- **Renderability = paints DOM** (`renderUnits.ts`): a running collapsed_activity
  unit exists but paints null (WorkIndicator owns "busy"); renderability now asks
  `.some(paintsDom)` so the render model and DOM agree.
- **Condition exit is a hard lifecycle boundary** (`conditions/selectors.ts`):
  provider condition ids are invalid once the process is gone; `hasVisibleConditions`
  distinguishes "a snapshot arrived" from "a condition is on screen".

### Deletions performed + confirmation searches

- **Feed `CodeRenderContext` re-export** — removed after:
  `grep -rn "CodeRenderContext.*feed/ui/Feed|feed/ui/Feed.*CodeRenderContext" src/ testing/ packages/` → no matches (all 3 importers migrated to `@renderer/features/feed/context`).
- **Feed `activityStatus` prop + TileLeaf pass-through** — removed after:
  `grep -n activityStatus Feed.tsx` showed only the prop decl + destructure (unused inside Feed); runtime field retained — consumers `DebugPanel.tsx`, `saveDebugBundle.ts` confirmed present.
- **Local `asRecord` in `codexResumeSanitizer.ts`** — replaced with `@shared/lib/asRecord`; confirmed main already imports it (`sessionIndex.ts`, `codexSubagentState.ts`).

### Tests run

- `vitest run --project unit` across all new/changed test files: **46 passed** in the
  touched set (selectors, agentDisplayMode, entries/utils, semantic scroll signal,
  renderUnits, codexSubagentState, codexResumeSanitizer).
- `vitest run --project unit` (full): 74 tests pass; **3 files fail to *import*** —
  all `Cannot find module '../../../packages/claude-code-headless/src/...'` because
  the headless **submodules are not checked out in this worktree**. Environmental,
  not caused by this work.
- `vitest run --project renderer`: 5 passed.
- `tsc --noEmit -p tsconfig.web.json`: **0 real errors** (29 reported are all
  `TS6305` stale-composite-build artifacts from the shared/symlinked `.tsc-out`).
- `tsc --noEmit -p tsconfig.node.json`: only my-file errors were (a) `sessionManager`
  `Cannot find module 'claude-code-headless'` (absent submodule), (b) a pre-existing
  null-narrowing in `extractCodexChildMeta` which I fixed. No new type errors.

### Intentionally deferred (with reasons)

- **Typecheck gate (cross-app V2/U1, roadmap Wave 0 `typecheck-foundation`)** —
  deliberately NOT added here. The roadmap scopes it as a standalone foundation PR
  and it edits `package.json`/CI which would collide with parallel clusters. Doing
  it inside a correctness cluster risks half-landing the gate. (My type changes were
  still validated with manual `tsc --noEmit`.)
- **Claude `API.md` top-level `slash-picker` doc fix (conditions Finding 14)** — the
  `packages/claude-code-headless` submodule is not checked out in this worktree
  (`API.md` absent), so it cannot be edited here. Defer to a submodule-scoped change.
- **Legacy `pending*` mirror removal (conditions Finding 1/3/Findings on compaction
  authority)** — the audit is explicit that mirrors must stay compatibility-only
  until ALL production consumers (esp. `pendingCompaction` in agent-status) move to
  condition selectors. That consumer migration spans agent-status model/formatter
  and is a multi-step source-of-truth move best done as its own PR; doing only half
  (clearing on exit) is the safe, owned slice and is done. Removal deferred.
- **Slash-picker dual-feed authority (conditions Finding 8)** — needs a
  `getRuntimeSlashPicker` precedence selector + composer migration spanning
  `useIpcSubscriptions` screen ingestion and `TileLeaf`; overlaps provider-boundary
  cluster. Deferred to avoid a half-migration.
- **Codex rollout/ATP mapping parity, shared tool-presentation helper, row
  primitives, live Codex output renderer, live/committed dispatch convergence (feed
  Findings 4–7, 9)** — these are larger refactors the plan itself sequences AFTER the
  correctness fixes and tests; several touch the headless submodules. Deferred to
  dedicated PRs; not high-confidence single-vertical changes.
- **Cross-app weirdness items owned by other clusters** — V15 (`lastActivityAt`
  cleanup, main-session-lifecycle), V18 (`disabledSessionIds`, dispatch), V22
  (`replaceSession` timer, renderer-workspace), V23 (build/config), V5/V6 (proxy
  sidecar detection, headless packages) — left to their owners; documented as
  dependencies.

See Pass 2 below for the line-by-line re-verification.

---

## Pass 2 — Second comprehensive verification & improvement pass

Re-read all three assigned plans against the working diff and classified every
concrete item. Verified pass-1 changes for correctness (esp. React invalidation
and perf), added one more contained owned fix, and recorded deferrals with reasons.

> Note: this pass was interrupted by an app crash mid-edit and resumed from the
> existing worktree state (no restart). On resume I (a) finished wiring
> `conditionRequiresAttention` into the unread handler, (b) added its tests, and
> (c) fixed a trailing-blank-line `git diff --check` warning left in
> `codexResumeSanitizer.ts` when the local `asRecord` was removed.

### Re-verification of pass-1 changes (rechecked, all confirmed correct)

- **Tool-index version / Feed clone-on-bump** — re-read `renderModel`'s memo deps
  (`Feed.tsx`): it depends on `toolUseIndex`/`toolResultIndex`. The clone changes
  their identity ONLY when `toolIndexVersion` bumps, and a version bump always
  coincides with an `entries` change (the entry carrying the tool block), so
  `renderModel` gains **no** extra rebuilds vs. before. On text-only appends the
  version does not bump, the memo returns the same cloned Map, and identity stays
  stable. The O(N²) bootstrap rebuild is not reintroduced. ✔
- **`noChange` guard** — added `!toolIndexChanged`; confirmed `toolIndexChanged`
  implies `appended.length > 0`, so the guard is belt-and-suspenders, never a
  behavior change. ✔
- **Semantic scroll signal** — `semanticTurnScrollSignal` is a cheap length/status
  scan over `blockOrder` (no JSON stringify); applied to both current turn and
  history. ✔
- **Renderability** — `.some(semanticRenderUnitPaintsDom)` mirrors the row
  components' null returns; running collapsed activity no longer counts. ✔
- **Exit clearing / `hasVisibleConditions`** — `clearConditionRuntimeState` nulls
  `conditions`+picker+all mirrors together; display-mode promotion is visibility-
  aware. ✔

### Added in Pass 2

| Item | Plan ref | Files |
|------|----------|-------|
| AUQ included in unread/attention via `conditionRequiresAttention` (visibility-aware, replaces legacy-mirror check) | conditions Finding 5 + Additional B | `conditions/selectors.ts`, `useIpcSubscriptions.ts` (+tests) |
| Legacy `pending*` mirrors documented as compatibility/cache-only (not source of truth) | conditions Finding 1 (Phase 1 doc step) | `workspaceState.ts` |
| Fixed trailing-blank-line `git diff --check` warning | n/a (hygiene) | `codexResumeSanitizer.ts` |

`conditionRequiresAttention` is visibility-aware so it reproduces the old mirror
behavior EXACTLY for trust/resume/permission (which only set the mirror when
`visible:true`) while adding AUQ + codex approval/trust (flagless → presence) and
deliberately excluding compaction (progress, not actionable) and slash-picker.
This also moves a production consumer off the legacy mirrors — the Finding 1
migration direction — without deleting the mirrors (compaction status still reads
`pendingCompaction`).

### Full plan-item classification

Legend: ✅ done · 🟡 partial (safe slice done, rest deferred) · ⏭️ deferred (reason) · ❌ invalid/retracted

**feed-rendering.md**
- F1 tool-index context invalidation — ✅
- F2 semantic auto-scroll block deltas — ✅
- F3 renderability = paints DOM — ✅
- F4 live Codex output via `CodexToolResultRow` — ⏭️ requires a pure
  `codexOutputToToolResultBlock` normalizer **plus** wiring into `BlockRow.tsx`
  (React, visual, no easy test). Adding only the normalizer would be a
  half-migration; per "complete verticals over half-migrations" deferred to a
  focused PR.
- F5 live/committed dispatch convergence (git/spawn_agent) — ⏭️ larger refactor
  the plan sequences after correctness fixes; touches multiple row components.
- F6 shared tool-presentation helper — ⏭️ multi-surface refactor (renderer+main),
  plan says do after tests pin behavior.
- F7 duplicate row primitives — ⏭️ provider-row refactor; overlaps provider-boundary cluster.
- F8 `CodeRenderContext` direct imports + re-export removed — ✅
- F9 Codex rollout/ATP mapping parity — ⏭️ touches the `agent-transcript-parser`
  submodule (absent in this worktree).
- F10 `asRecord` array-rejection in resume sanitizer — ✅
- F11 subagent structured array output — ✅
- Partial A/B/C (semantic event contract, transcript types, resume sanitizer
  dedupe) — ⏭️ contract cleanups spanning packages; explicitly "do later".
- Additional F1 stale Claude-only comments — ✅
- Additional F2 sparse coverage — 🟡 added focused tests for every fix landed.
- Deletion C1 `activityStatus` prop — ✅ (runtime field retained)
- Deletion C2 Feed re-export — ✅
- Deletion C3 local `asRecord` — ✅
- Deletion C4 private Codex `TruncatedOutputRow` — ⏭️ depends on F7 primitive extraction.
- Deletion C5 stale comments — ✅

**conditions-framework.md**
- F1 `pending*` mirrors duplicate `conditions` — 🟡 selectors added, one consumer
  (unread) migrated, mirrors marked compatibility-only + cleared on exit; field
  REMOVAL deferred until compaction-status consumer moves.
- F2 session exit leaves conditions stale — ✅
- F3 compaction split authority — ⏭️ needs agent-status model/formatter migration
  to `compactionFromConditions`; spans the agent-status feature, own PR.
- F4 app IPC/preload old prompt channels — ⏭️ overlaps ipc-preload cluster; gated
  on all renderer consumers moving first.
- F5 attention metadata duplicated / AUQ — 🟡 unread/attention now routed through
  `conditionRequiresAttention` (AUQ included). The `AttentionLevel` type change
  (`QUESTION`) and AUQ-outlet-binding are explicit product/UI decisions in the
  plan — deferred, documented.
- F6 headless module registry erasure — ⏭️ packages (submodules).
- F7 AUQ structured resolver — ⏭️ touches claude-headless submodule + shared contract.
- F8 slash-picker dual-feed — ⏭️ needs `getRuntimeSlashPicker` precedence + composer
  migration spanning screen ingestion; overlaps provider-boundary.
- F9 ConditionOutlet render-order comment — ✅
- F10 conditions-core sync `--check` + scripts — ✅
- F11 rendering harness forwards conditions — ⏭️ testing harness; overlaps harness cluster.
- F12 resolve-condition result types duplicated — ⏭️ shared-type move across main/preload/driver.
- F13 slash-picker state shape copied — ⏭️ shared-type move; package boundary.
- F14 Claude `API.md` slash-picker doc — ⏭️ **submodule not checked out** here
  (`packages/claude-code-headless/API.md` absent) — cannot edit.
- F15 session IPC payloads hand-modeled — ⏭️ cross-boundary contract; ipc cluster.
- Additional A empty snapshot forces hybrid — ✅ (`hasVisibleConditions`)
- Additional B unread excludes AUQ — ✅ (Pass 2)

**cross-app-weirdness.md**
- V1 Reader Mode picker guard (`readerMode`) — ✅
- V2/U1 typecheck gate + U2 tsconfig include — ⏭️ roadmap Wave-0 foundation PR;
  edits package.json/CI and overlaps cross-app cluster; doing it inside a
  correctness cluster risks half-landing the gate. (Type changes still validated
  with manual `tsc --noEmit` — 0 real errors.)
- V3 dead command-palette ternary — ⏭️ plan calls it a **product micro-decision**
  (Escape target); behavior-neutral edit would discard the likely intent.
- V4/U3 `local_shell_call` shared resolver — ⏭️ needs fixture + touches ATP submodule rewind.
- V5/V6/V7/V8/V9/V10/V11/V12/V13/V14 — ⏭️ all in headless/parser **submodules**
  (absent) or proxy/lossy package code; not this cluster's files.
- V15 `lastActivityAt` cleanup — ⏭️ main-session-lifecycle cluster.
- V16/V17 dead transcript paths — ⏭️ main; gated on the typecheck gate (V2).
- V18 `disabledSessionIds` — ⏭️ dispatch cluster.
- V19 `gridRelatedSelections` persistence — ⏭️ product decision.
- V20 `inheritedParentContext` dormant branch — ⏭️ subagent cluster (planned-feature seam).
- V21 `[xcript-diag #283]` — ⏭️ real-bug decision spanning multiple clusters.
- V22 `replaceSession` timer cancel — ⏭️ renderer-workspace cluster (roadmap §4 helper).
- V23 build/config (proxy-demo, harness imports, .gitmodules, opencode submodule) — ⏭️ owner decisions.
- Latent typecheck cleanup found while gating: `extractCodexChildMeta` null-narrowing — ✅ fixed (it sits in a file I already touched and is a clean, behavior-neutral `payload?.source`).

### Commands run (Pass 2)

- `git diff --check` → **CLEAN** (after fixing one trailing-blank-line in `codexResumeSanitizer.ts`).
- `vitest run --project unit` over all touched test files → **51 passed / 7 files**.
- `vitest run --project unit src/renderer/src/workspace/conditions/` → **12 passed** (incl. new `conditionRequiresAttention` cases).
- `tsc --noEmit -p tsconfig.web.json` → **0 real errors** (29 reported are all
  `TS6305` stale-composite artifacts from the shared/symlinked `.tsc-out`).
- `tsc --noEmit -p tsconfig.node.json` → my files clean; only remaining error in a
  touched file is `sessionManager.ts:8 Cannot find module 'claude-code-headless'`
  = the **absent headless submodule** (my edit there was a comment only).

### Residual risks

1. **Submodules not checked out in this worktree** (`agent-transcript-parser`,
   `claude-code-headless`, `codex-headless`). Consequences: (a) 3 pre-existing
   unit-test files fail to *import* (environmental, not my changes); (b) `tsc`
   reports `Cannot find module` for headless imports; (c) `conditions-core:check`
   reports the vendored copies as "missing" (drift) — in a fully-checked-out repo
   it would compare real bytes. None of these are caused by this work, but a
   reviewer should run the suite/typecheck/`conditions-core:check` in a
   fully-initialized checkout.
2. **`tsc` is not yet gated** (V2 deferred). My type changes were validated by
   manual `tsc --noEmit` showing 0 real errors, but until the gate lands the repo
   has no automated guard. I added one latent-narrowing fix
   (`extractCodexChildMeta`) opportunistically; others remain across the tree.
3. **Tool-index clone cost**: cloning the tool maps on each `toolIndexVersion`
   bump is O(N). It runs only on a real tool-pairing change (not per append), so
   it is bounded and far cheaper than the prior O(N²) rebuild — but on an
   extremely tool-heavy single burst it is a new (small) allocation. Acceptable
   and commented; flagged for awareness.
4. **Legacy `pending*` mirrors still exist** (compaction status reads
   `pendingCompaction`). I intentionally did NOT delete them — the audit requires
   moving the compaction-status consumer first. The exit-clear + compatibility
   comment keep them safe in the interim.
5. **`conditions-core:check` / `package.json`**: added two npm scripts. If a
   parallel cluster also edits `package.json` scripts there could be a merge
   conflict; the additions are adjacent to existing `*:check` scripts to minimize
   it. The script change itself is self-contained.

### What remains (for follow-up PRs, by area)

- Conditions source-of-truth completion: compaction status → `compactionFromConditions`,
  slash-picker authority selector, then `pending*` mirror removal, then legacy
  prompt IPC/preload channel removal, harness condition forwarding. (conditions F3/F8/F1/F4/F11)
- Feed convergence/refactors: live Codex output renderer, live/committed dispatch
  sharing, shared tool-presentation helper, row primitives, Codex/ATP mapping
  parity. (feed F4–F7, F9)
- Cross-app: typecheck gate + tsconfig include (foundation), and the many
  package/submodule-scoped items (V4–V14) and other-cluster items (V15–V23).
- Claude `API.md` slash-picker doc once the submodule is available. (conditions F14)
