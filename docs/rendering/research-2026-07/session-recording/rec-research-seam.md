# Session Recording — Replay Seam Map

Goal: record the rendering-pipeline INPUT stream so tests can replay it deterministically
through the real adapter→ledger→view pipeline.

## 0. The pipeline at a glance (exact call chain)

Live producer hook: `src/renderer/src/rendering/view/useLedgerFeedItems.ts:70-95`

```
runtime  ──(build slices)──►  RuntimeLedgerSlices
   │  useLedgerFeedItems.ts:74-83
   ▼
createLedgerInputAdapter()(slices)  →  LedgerInputBundle { input: LedgerInput, collectorDecisions }
   │  adapter/collectLedgerInput.ts:165-428   (per-plane caches, D11)
   ▼
createSessionLedger()(bundle.input)  →  RenderLedger { rows, decisions, unknowns }
   │  model/ledger.ts:126-152                 (last-call cache, D11)
   ▼
ledgerToFeedItems(ledger, ledgerFeedContextFromRuntime(runtime, provider))
   │  view/ledgerFeedItems.ts:63-203          →  FeedRenderItem[]
   ▼
Feed `renderItemsOverride`
```

The **shadow twin** `src/renderer/src/rendering/shadow/useRenderShadow.ts:135-146` builds the
SAME `RuntimeLedgerSlices` and runs the SAME two-stage core, then diffs against the legacy
`deriveFeedRenderModel`. Both hooks live in TileLeaf; both are gated behind dev-debug flags.

The **blessed replay harness already exists**: `__tests__/bundleCorpus.test.ts:145-181` reads a
JSON fixture, constructs `RuntimeLedgerSlices` (lines 147-156), and calls
`createSessionLedger()(createLedgerInputAdapter()(slices).input)` (line 157). A recording is
literally "that fixture × N ticks."

---

## 1. `RuntimeLedgerSlices` — the record contract (adapter/collectLedgerInput.ts:77-89)

This is the exact "what must be recorded to reconstruct one tick" object.

| field | type | origin in runtime (useLedgerFeedItems.ts:74-83) | why needed |
|---|---|---|---|
| `provider` | `AgentProviderKind` | session meta (`sessions[id].kind`) | selects suppression policy, gates opencode ghosts, ownership rules |
| `sessionId` | `string` | session id | stamped into every candidate id; cache key salt |
| `entries` | `readonly RawCommittedEntry[]` | `runtime.entries` | committed plane + embedded optimistic rows (uuid prefix `optimistic-codex-user:`) partitioned out at adapter.ts:235-247 |
| `semanticCurrent` | `RuntimeSemanticTurn \| null` | `runtime.semantic.currentTurn` | live turn; block-level candidates via `toTurnLike` |
| `semanticHistory` | `readonly RuntimeSemanticTurn[]` | `runtime.semantic.history` | archived turns (capped at SEMANTIC_HISTORY_CAP=20) |
| `ghosts` | `ReadonlyMap<string, GhostLike>` | `runtime.ghosts` | ghost-fallback plane; 5-rule predicate |
| `streamPhase` | `string` | `runtime.streamPhase` | statics plane: `=== 'idle'` → work vs empty |
| `lastJsonlEntryAtMs` | `number \| null` | `runtime.lastJsonlEntryAt` | ghost predicate rule 4 timestamp gate (GhostPredicateContext) |

`RuntimeSemanticTurn` (adapter.ts:55-75): `turnId, source, text?, blocks: Record<number, block>,
blockOrder: number[], startedAt, endedAt, isCompactionSynthesis?, lookups?.toolCallsById`. The
real `SemanticLiveTurn` (workspaceState.ts:187-215) is asserted assignable at compile time
(`_SemanticTurnSeam`, adapter.ts:162). Only `blockOrder`-referenced blocks + `lookups.toolCallsById[id].status`
are consumed — the ~40 Codex-specific block fields ride along untouched.

### View-stage extras (NOT in RuntimeLedgerSlices)
`ledgerFeedContextFromRuntime` (ledgerFeedItems.ts:63-87) reads **two more** runtime fields the
adapter never sees, used only to build the `work` row key/label:
- `runtime.streamPhasePendingToolName` (string|null)
- `runtime.streamPhasePendingToolUseId` (string|null)

Plus it rebuilds `entriesByUuid` (from `entries` + `ghosts`) and `turnsById` (from
`currentTurn` + `history`) — all derivable from slices already listed, no new source.

### MINIMAL RECORD-SET (field-by-field)
To reproduce **every RuntimeLedgerSlices tick + the view stage**, a recording MUST capture,
per tick, exactly **10 runtime fields** (the 8 slice fields minus sessionId/provider which are
session-constant, plus the 2 pending fields):

1. `entries` — committed + optimistic rows
2. `semantic.currentTurn`
3. `semantic.history`
4. `ghosts` (Map → serialize as entries object; bundleCorpus does `new Map(Object.entries(...))`)
5. `streamPhase`
6. `streamPhasePendingToolName` — view-only (work row)
7. `streamPhasePendingToolUseId` — view-only (work row)
8. `lastJsonlEntryAt`
   plus session-constant: `provider`, `sessionId`.

**NOT part of this seam** (important negative result): `subAgents`, `queuedMessages`,
`toolUseIndex`/`toolResultIndex`, `totalEntries`, `conditions`, all `pending*` dialogs, screen
strings. The ledger pipeline renders NONE of these — subagent rows (TaskSubagentRow) and the
queue strip (QueueStrip) are painted by Feed OUTSIDE the ledger override. A recorder scoped to
the ledger seam does not need them; a whole-Feed recorder would.

The `bundleCorpus` `BundleFixture.input` shape (bundleCorpus.test.ts:83-94) is ALREADY exactly
this record-set for a single tick: `{ provider, streamPhase, streamPhasePendingToolName,
streamPhasePendingToolUseId, lastJsonlEntryAt, entries, semanticCurrent, semanticHistory, ghosts }`.

---

## 2. `LedgerInput` — the downstream surface (model/ledger.ts:46-63)

The adapter's OUTPUT (recording this instead would skip the adapter and lose translation/D11
coverage — NOT recommended). Fields: `provider`, `committed: RenderCandidate[]`,
`live: RenderCandidate[]`, `statics: RenderCandidate[]`, `unknowns: UnknownBehavior[]`,
`ghosts?: GhostLedgerCandidate[]`, `ghostContext?: { lastJsonlEntryAtMs, semanticOwnedTurnIds }`.
Derivation from slices happens per-plane in the adapter body:
- `committed`/optimistic ← `entries` (partition + `collectCommittedCandidates`) adapter.ts:224-275
- `live` ← `semanticCurrent`+`semanticHistory` (`collectSemanticCandidates`) + optimistic merge, adapter.ts:277-391
- `ghosts` ← `ghosts` map (`collectGhostCandidates`) adapter.ts:331-337
- `statics` ← two booleans (`streamPhaseIdle`, `hasContentCandidates`) adapter.ts:343-366
- `ghostContext` ← `lastJsonlEntryAtMs` scalar + `semanticOwnedTurnIds` set derived from turn ids

---

## 3. Mutation layer — the events a recorder taps

`SessionRuntime` is mutated by `useIpcSubscriptions` (ipc/useIpcSubscriptions.ts, one big
useEffect) + a few optimistic action hooks. Rendering-relevant events, by IPC channel:

| event / channel (via injected `SessionFeed`) | handler | rendering slice(s) it moves |
|---|---|---|
| `feed.onSessionJsonlEntries` (`session:jsonl-entries`) | useIpcSubscriptions.ts:1151+ | **`entries`** (append, dedup by seenUuidsRef), `lastJsonlEntryAt`, `totalEntries`, queue reconciliation, pendingCompaction |
| `feed.onSessionSemanticEvent` (`session:semantic-event`) | :833-1085 | **`semantic`** (`foldSemanticEvent`), **`streamPhase`**+pending+timestamps (`reduceStreamPhase`), **`ghosts`** (`ghostsFromSemanticTurn`), promptSuggestion, awaitingAssistant |
| `feed.onSessionProcessState` (`session:process-state`) | :784-831 | processActive/status, activityStatus, queue clear (not a ledger slice, but affects statics via streamPhase only indirectly) |
| `feed.onSessionExit` (`session:exit`) | :721-772 | `streamPhase→'idle'`, clears `semantic.currentTurn`, pending fields |
| `feed.onSessionScreen` (`session:screen`) | :565-682 | screen strings only — **NOT a ledger slice** |
| `feed.onSessionConditions` (`session:conditions`) | :1087-1120 | pending dialogs — NOT a ledger slice |
| `feed.onSessionSubAgents` (`session:sub-agents`) | :1126-1132 | `subAgents` — NOT a ledger slice |
| `window.api.ghostAppend` side-channel + orphan sweep timer | :349-452 | **`ghosts`** (orphanStale/gcSupersededGhosts every 1000ms) |
| Optimistic submit: `setStreamingBaseline` | actions/streaming.ts:140-178 | `streamPhase→'submitting'`, `submittedAt/phaseChangedAt/turnStartedAt`, awaitingAssistant |
| Optimistic submit: `addOptimisticCodexUserEntry` | actions/streaming.ts:180-282 | appends `optimistic-codex-user:` row to **`entries`** OR pushes `queuedMessages` |
| `removeOptimisticCodexUserEntry` | :284-313 | pops optimistic row from `entries` |

The **four ledger-relevant taps**: (a) jsonl-entries burst, (b) semantic event, (c) exit,
(d) ghost orphan-sweep timer + ghostAppend, plus (e) the two optimistic-submit action calls.
Everything else in the 1985-line effect touches non-ledger state.

---

## 4. Identity / reference-stability contract (D11) — the crux for replay

The adapter caches **per plane on the runtime slice references themselves** (`!==` comparison):
- `committedCache.entries !== slices.entries` (adapter.ts:226)
- `liveCache.current !== slices.semanticCurrent || liveCache.history !== slices.semanticHistory` (:279-280)
- `ghostCache.ghosts !== slices.ghosts` (:331)
- statics key off two booleans; final bundle returned by reference if all planes hit (:398-410)

The ledger's own cache (ledger.ts:129-145) then compares `LedgerInput` array references. So the
chain is: **reducer keeps a slice reference stable iff it didn't really change → adapter plane
cache hits → same LedgerInput arrays → same RenderLedger object → Feed memo skips.** The
adapter.test.ts "keeps untouched planes reference-stable" test (adapter.test.ts:119-149) is the
executable spec: change one slice's reference, assert the OTHER three `input.*` arrays are `===`
the previous call.

**What a faithful replay MUST reproduce:** the exact per-tick pattern of *which slice references
changed*. This is the hard part, because:

> **JSON serialization destroys reference identity.** Every deserialized array/object/map is a
> fresh reference. A naive "record JSON snapshot per tick → deserialize → feed" replay makes
> EVERY slice look changed on EVERY tick — the adapter recomputes all planes every tick, the
> ledger never returns a cached object, and the D11 contract the tests assert is NOT exercised.
> Output ROWS are still correct (the pipeline is pure); only the identity/caching behavior is
> falsified.

Two ways to get identity back:
1. **Reference canonicalization at replay** (feed snapshots, re-canonicalize): keep the prior
   tick's slice objects; for each of the 8 slices, if structurally equal to the prior tick,
   reuse the prior reference. This reproduces "unchanged slice ⇒ same reference," which is
   *exactly* the reducer's own documented contract ("reference-stable on no-op"). Sound
   approximation — the reducers (foldSemanticEvent returns `state` on no-op; ghosts.ts returns
   same Map on no-op; entries only grows on append) mint a new reference iff structurally
   changed, so structural-equality canonicalization is faithful.
2. **Re-apply events through real reducers** (record deltas): reference pattern is perfect by
   construction because it IS the production reducer code.

---

## 5. Existing harnesses (mirror these exactly)

- `__tests__/adapter.test.ts` — hand-builds `RuntimeLedgerSlices` (baseSlices(), :56-85), calls
  `createLedgerInputAdapter()` + `createSessionLedger()`. Asserts row ids AND reference stability
  (:119-149). This is the *unit* shape.
- `__tests__/bundleCorpus.test.ts` — reads 46 JSON fixtures, each ONE captured tick, replays
  `createSessionLedger()(createLedgerInputAdapter()(slices).input)` (:157) and diffs rows against
  recorded legacy `visible_rows` via `shadowDiff`. This is the *recorded-tick* shape and the
  **direct ancestor of the recorder**. Fixture format = the record-set from §1.
- Fixtures generated by `scripts/extract-rendering-fixtures.mjs` (from real debug bundles).

---

## DELIVERABLE

### (a) Minimal record-set — see §1 table. Per session: `{provider, sessionId}`. Per tick:
`{entries, semanticCurrent, semanticHistory, ghosts, streamPhase, streamPhasePendingToolName,
streamPhasePendingToolUseId, lastJsonlEntryAt}`. Nothing else feeds the ledger→view pipeline.

### (b) Two candidate replay architectures

**A — Snapshot per tick** (record the §1 record-set at each producer-hook recompute):
- Fidelity (rows): high — bundleCorpus already proves single-tick snapshot replay.
- Fidelity (D11 references): LOST on naive replay; RECOVERABLE with structural-equality
  canonicalization pass (reuse prior tick's reference when a slice is deep-equal). Sound because
  it reproduces the reducers' own no-op-stability contract.
- File size: LARGE — full `entries`/`semantic` repeated each tick (entries grows unbounded).
  Mitigate with structural sharing / per-slice dedup-by-hash on write (only store a slice blob
  when it changed; ticks reference blobs by id — which ALSO gives you the reference pattern for free).
- Coupling to reducer internals: NONE. Records only the adapter's public input contract. Immune
  to the churning provider/reducer refactor (#394).
- Determinism: full — adapter+ledger pure. `Date.now()` in adapter only feeds unknown-sighting
  telemetry (adapter.ts:264,308), never rows.

**B — Event stream re-applied through reducers** (record raw IPC events + optimistic action calls):
- Fidelity (rows + D11 references): PERFECT by construction — replay IS the production reducer path.
- File size: SMALL — deltas, no repeated snapshots.
- Coupling to reducer internals: HIGH and painful. Replay must drive the 1985-line inline
  `useIpcSubscriptions` effect, which is entangled with React `setRuntimes`, module-level maps
  (`jsonlProviderStreamBySession`, `codexCurrentTurnIdBySession`, `seenUuidsRef`), `window.api.
  ghostAppend`, and a `setInterval` orphan sweep. None of it is a callable pure function today.
  You'd need to extract the reducer core or build a stub harness (fake window.api, injected clock,
  virtual timers). It also couples the recording to a layer that #394 is actively rewriting.
- Determinism: requires injecting a clock (Date.now used in orphan TTL, ghost orphanedAt,
  submittedAt, unreadSince) and virtualizing the 1000ms sweep timer.

**RECOMMENDATION: Architecture A, tapped at the producer-hook seam, with per-slice
dedup-by-reference on write.** Rationale:
1. The blessed harness (`bundleCorpus.test.ts:157`) and fixture format ALREADY implement
   single-tick snapshot replay — the recorder is "bundleCorpus × N ticks," minimal new code.
2. Zero coupling to the reducer/IPC layer that #394 is churning — the recording stays valid
   across the provider refactor.
3. Solve D11 fidelity AND file size with one mechanism: on write, store each slice value in a
   content-addressed pool and have each tick reference slices by pool-id. Identical
   pool-ids across ticks ⇒ replay hands back the SAME deserialized object reference ⇒ the
   adapter's plane caches hit exactly as production. This reproduces the reference-change pattern
   *deterministically from the recording itself* (no structural-eq guessing) and dedups the
   repeated `entries`/`semantic` blobs. The pool-id sequence per slice IS the recorded reference
   pattern.
   Fall back to structural-equality canonicalization only if you record plain snapshots without
   the pool.
   Use B only if the recorder must also cover reducer-level bugs (ghost sweep timing, provider-id
   quarantine, queue reconciliation) — those live above this seam and A cannot see them.

### (c) Exact seam a replay test calls

Minimal (rows only, mirrors bundleCorpus.test.ts:157):
```ts
const adapter = createLedgerInputAdapter()   // ONCE per replayed session (holds D11 caches)
const ledger  = createSessionLedger()        // ONCE per replayed session
let prev: RuntimeLedgerSlices | null = null
for (const tick of recording.ticks) {
  const slices = rehydrateSlices(tick, prev, pool) // pool-id → shared reference (D11)
  prev = slices
  const bundle = adapter(slices)                    // adapter/collectLedgerInput.ts:165
  const rendered = ledger(bundle.input)             // model/ledger.ts:126  → RenderLedger
  assertRows(rendered.rows)                          // or diff via shadowDiff, like bundleCorpus
}
```
Full (through the view stage → FeedRenderItem[]):
```ts
  const { items, dropped } = ledgerToFeedItems(
    rendered,
    ledgerFeedContextFromRuntime(reconstructedRuntimeView(tick), tick.provider),
  ) // view/ledgerFeedItems.ts:63,109
```
`ledgerFeedContextFromRuntime` needs `entries`, `ghosts`, `semantic.currentTurn`,
`semantic.history`, `streamPhase`, `streamPhasePendingToolName`, `streamPhasePendingToolUseId` —
all in the record-set — so `reconstructedRuntimeView(tick)` is a thin `{semantic:{currentTurn,
history}, entries, ghosts, streamPhase, streamPhasePending*}` shim, not a full SessionRuntime.

**Recorder capture point:** wrap `useLedgerFeedItems` (view/useLedgerFeedItems.ts:74-83) — the one
place slices are already assembled from runtime — emitting `{ ...the 8 slices, pending*, refGen
per slice }` each time the memo recomputes. That memo's dep array (:100-112) is already keyed on
the exact slice references, so a recompute == a tick worth recording, and equal-reference ticks
are naturally skipped.
