# The Rendering System

> **Status:** evergreen reference — describes the rendering pipeline as it is *today* (post the 2026-07 ownership-ledger rewrite, the #491/#492 block-level un-collapse, and PR #555 Phases 1–10's evidence-first provider painter). If you change the pipeline, change this doc in the same PR.
>
> **Companion:** [`rendering-design-principles.md`](./rendering-design-principles.md) — how we *work on* this system (test-first, fixture-gated). Read that before touching any file below.
>
> **Upstream design record** (why, decision-by-decision): [`rendering-rewrite-plan-2026-07.md`](./rendering-rewrite-plan-2026-07.md) (the `§`/`D`-numbered rules this doc cites), [`legacy-deletion-manifest.md`](./legacy-deletion-manifest.md), [`../design/ghost-system.md`](../design/ghost-system.md).

---

## 1. The shape of the whole thing

A provider (Claude, Codex, opencode) is a program emitting a messy, out-of-order stream of events — JSONL transcript lines, a live semantic event stream, terminal-screen snapshots, condition/permission state, process lifecycle. The rendering system turns that into the conversation you see, and it does so in **three stages with one direction of flow**:

```
   raw provider events                clean per-session state              decided + ordered rows              JSX
  ─────────────────────  ─INGEST─▶   ──────────────────────  ─DECIDE─▶  ─────────────────────  ─RENDER─▶  ──────────
  channels (SessionFeed)             SessionRuntime, read via            RenderLedger                      <Feed/>
  screen / jsonl-entries /           RuntimeRenderInput:                 rows[]  (FeedRenderItem[]         a dumb painter:
  semantic-event / conditions /      entries[] · semantic{current,        after the view bridge)           data in, JSX out,
  process-state / exit               history} · ghosts · streamPhase*    decisions[] · unknowns[]          zero decisions
```

- **INGEST** (reducers in `src/renderer/src/session-runtime/…`, wired to transports by `workspace/hook/ipc/useIpcSubscriptions.ts`) folds channels into **one immutable-per-tick `SessionRuntime`** per session. It is the *only* place that touches transports.
- **DECIDE** (`src/renderer/src/rendering/…`) is the **ownership ledger**: a pure function from the **`RuntimeRenderInput`** slice of `SessionRuntime` (see below) to an ordered, fully-explained list of rows. It decides *what is visible*, *who owns it*, and *in what order* — and records *why* for every candidate, chosen or rejected.
- **RENDER** (`src/renderer/src/features/feed/…`) is the **feed painter**. It consumes the ledger's ordered `FeedRenderItem[]` and emits JSX. It makes **no** visibility/ownership/order decisions.

The seam between DECIDE and RENDER is the hook `useLedgerFeedItems` (`src/renderer/src/features/feed/ledger/useLedgerFeedItems.ts`). Both consumers of the pipeline — the **desktop** (`TileLeaf`) and the **remote phone client** (`src/remote-client/src/ui/SessionView.tsx`) — mount the *same* `<Feed>` and hand it the *same* ledger output via `renderItemsOverride`. There is one rendering pipeline; the phone is not a second implementation.

### The folder layout is the layering (post-#493)

The three stages are three directories with **one-way imports** — `session-runtime/` → `rendering/` → `features/feed/` — and the boundary between the first two is a *declared type*, not a convention:

- `src/renderer/src/session-runtime/` — the INGEST reducers and the `SessionRuntime` type (`state.ts`), plus **`RuntimeRenderInput`** (`state.ts`): a `Pick` of exactly the fields the decide layer may read (`entries`, `semantic`, `ghosts` as a `ReadonlyMap`, `streamPhase`, `streamPhasePendingToolName`, `streamPhasePendingToolUseId`, `lastJsonlEntryAt`). It is a Pick — not a wrapper object — so callers pass the same runtime reference and the D11 identity chain survives. Adding a field to it is a contract change licensing the decide layer to depend on it.
- `src/renderer/src/rendering/` — the DECIDE layer. It imports only `RuntimeRenderInput`, never the full `SessionRuntime`; the other ~50 runtime fields (pane UI, lifecycle, paging, debug state) are structurally invisible to it.
- `src/renderer/src/features/feed/` — the RENDER layer, including the ledger→feed **view bridge** in `features/feed/ledger/` (it lives with the painter, not the decide layer, because it resolves drawable payloads — a presentation concern).

### Why three stages, and why this direction

The system before the 2026-07 rewrite painted several fixed JSX "planes" (committed entries, then semantic history, then semantic current, then work) and let each plane decide its own visibility. That produced a specific, recurring, *undiagnosable* class of bug: two planes believing they owned the same artifact (#172), a stale plane row sitting visually *below* a newer prompt so the prompt "never showed" (#239), or a row vanishing with no explanation anywhere (#344). The rewrite collapses all of that into **one ordered list decided by one owner**, so those bugs become expressible as a single broken invariant instead of an emergent interaction. Everything below exists to serve that.

---

## 2. The one invariant

Stated canonically in `src/renderer/src/rendering/model/types.ts:11-18`:

> Every visible feed artifact has **exactly one owner** at a time; every ownership transfer is **explicit and evidence-based**; every rejected candidate **keeps its rejection reason**; debug output is a **serialization of the SAME decisions React paints** — never a second derivation.

Four sub-properties, each with a real enforcement site:

| Property | Enforced by |
|---|---|
| Exactly one owner per slot | the ownership pass (`model/ownership.ts`) + replay invariant `checkSingleOwner` (`replay/invariants.ts`) |
| Explicit, evidence-based transfer | every suppression carries `evidence: string[]` + `suppressionOwnerId` (`model/types.ts:189-197`) |
| Rejected candidates keep their reason | every candidate gets an `OwnershipDecision`, selected or not; collection-time kills keep decisions too |
| **Debug == paint** | `OwnershipDecision` is the decide stage's decision record *and* its debug schema — `RenderLedger.decisions` is retained on every pass and consumed verbatim by the replay invariants. The runtime capture surfaces record *what was painted*, derived from the same pipeline output rather than re-deciding it: feed-debug logs the painter's `DebugVisibleRow`/`VisibleDecision` rows (`features/feed/types.ts`, emitted from `Feed.tsx`), and `saveDebugBundle.ts` writes `render-diagnostics.json` from runtime ownership sets (`buildRenderDiagnostics`). What is forbidden is a second *visibility derivation* that could disagree with the paint. |

That last property is the one that makes this system diagnosable. "Why did this row vanish?" is answerable because every candidate's decision is recorded in the ledger the paint came from — not guessed at by a parallel explainer. The whole pipeline is machine-checked against real recordings by five replay invariants (`replay/invariants.ts`): dual-render, vanish-without-replacement, unexplained-shrink, identity-instability (D11), and unrenderable-drop.

**The block-level rule.** Ownership is decided per *block* (one tool call, one text segment, one thinking block), never per *turn*. The ownership bugs are unit-granular: Codex commits one response item at a time (#165), a committed tool-use must not hide a still-live tool output, #194 suppressed by itemId. A "turn" is a grouping used only for *policy* application (e.g. Claude's whole-turn suppression), never the ownership atom.

---

## 3. Stage INGEST — channels → `SessionRuntime`

**Where:** reducers and state in `src/renderer/src/session-runtime/…`; the transport-facing fold glue in `workspace/hook/ipc/useIpcSubscriptions.ts`. **Produces:** one `SessionRuntime` per session (`session-runtime/state.ts`).

### The channels (`SessionFeed`)

`SessionFeed` (`src/shared/sessionFeed/SessionFeed.ts`) is the seam between "the UI wants live session I/O" and "where the bytes physically come from." It lives in `@shared` (not `@preload`) so non-Electron surfaces can implement it — the desktop uses `IpcSessionFeed` (over `window.api.*`), the phone uses `WebSocketSessionFeed` (over a WebSocket). Nine **listeners** (subscribed once, globally, dispatched by `sessionId` inside the callback to avoid N×N listener storms):

`onSessionStarted · onSessionScreen · onSessionJsonlEntries · onSessionJsonlError · onSessionSemanticEvent · onSessionConditions · onSessionProcessState · onSessionSubAgents · onSessionExit`

…and three **commands** — `sendInput`, `deliverPrompt`, `resolveCondition`. The command surface is deliberately narrow: lifecycle/spawn/kill/raw-terminal are *absent* so a remote transport cannot express them.

All nine listeners are wired in one place — `workspace/hook/ipc/useIpcSubscriptions.ts`, the central ingest orchestrator. Each handler is a `setRuntimes(prev => …)` reducer.

### The reducers (fold)

Ingest is a set of **reference-stable reducers** — each returns `prev` unchanged on a no-op so React memoization holds, and each runtime *slice* only changes reference when its own reducer really changed it. This is the foundation of the identity-stability chain (see §6).

- **JSONL / committed plane** — the bulk-burst handler in `useIpcSubscriptions.ts`, with the shared entry utilities in `session-runtime/entries.ts` (`indexEntryIntoMaps`, `entryTextContent`). Raw provider lines route through the provider mapper (see below), dedupe by UUID, and fold into `runtime.entries`. Tool blocks are folded into in-place lookup maps `toolUseIndex`/`toolResultIndex` (keyed by tool_use_id); `indexEntryIntoMaps` returns *whether it changed* so callers bump the monotonic `toolIndexVersion` only when a cross-entry pairing actually moved (the naive `useMemo([entries])` rebuild was O(N²) at bootstrap). `lastJsonlEntryAt` tracks the newest observed entry *timestamp* (producer clock, `null` — never `0` — as the "never seen" sentinel).
- **Semantic / live plane** — `session-runtime/semantic/foldEvent.ts`, `foldSemanticEvent(state, ev, sessionKind)`. The **one-session-one-reducer** contract: every semantic event flows through here before any UI reads it; surfaces select from `runtime.semantic`, they never open their own subscription. The model is **block-level**: a `SemanticLiveTurn` holds `blocks: Record<number, SemanticLiveBlock>` keyed by index plus a `blockOrder: number[]`, because streaming deltas arrive out of order. Blocks accumulate copy-on-write as `text_delta`/`thinking_delta`/`tool_input_delta`/… events arrive; `tool_result` attaches onto the originating block by correlation id. Turn *replacement* is policy-gated (`canReplaceMismatchedTurn`) — an ended turn is always replaceable, a live turn yields only to trusted sources.
- **Stream-phase plane** — `session-runtime/semantic/streamPhaseMachine.ts`, `reduceStreamPhase`, deliberately *outside* `foldSemanticEvent` because the phase lives on `SessionRuntime`, not `SemanticRuntimeState` (folding it in would be a layering violation). It drives the single in-feed `WorkIndicator`.

### Provider neutrality

All "which provider says what" knowledge is pushed into a capability registry — `src/providers/registry.renderer.capabilities.ts`, `getRendererProviderCapabilities(kind)`. Ingest-relevant capabilities: `createTranscriptEntryMapper` (raw line → neutral `Entry`; stateful for Codex's rolling turn cursor, stateless for Claude), `extractProviderSessionId`, `semanticFoldPolicy` (the per-provider turn-ownership data that replaced hardcoded `sessionKind === 'codex'` literals), `usesOptimisticUserEcho`, `isSpawnTool`. Adding a provider is: one mapper + one fold policy + one condition policy, and every ingest path picks it up.

### The provisional planes: ghosts and optimistic rows

- **Ghosts** (`session-runtime/ghosts.ts`) are a disk-backed ledger of *provisional* entries minted from the live semantic stream to paper over the gap between a provider streaming an event and durably writing it to JSONL. They exist for exactly one situation: committed truth stalled *past* the live stream (JSONL stuck mid-turn, or a crash + resume with partial JSONL). They are reconciled away (`reconcileUpstream`) when the authoritative entry lands.
- **Optimistic rows** are local user echoes appended into `runtime.entries` with a `optimistic-codex-user:` uuid prefix, reconciled by *text identity* (not tail position — the #290 double-render fix) when the committed user entry lands.

### The trust / provenance invariant

`RenderSourcePlane` is distinct from `RenderOwner` (see §4). The invariant (plan D9, `model/types.ts:42-45`):

> **Assistant content may only originate from `semantic` with source ∈ {proxy, rollout, opencode-sse} — never `screen`.**

The `screen` channel feeds only *current-state parsers* (trust dialog, slash picker, activity spinner) and never contributes assistant text. This is enforced in the fold layer, *before* candidates exist. Downstream, the `source`/`sourcePlane` on a candidate is evidence for a debug bundle, not something to re-litigate.

### What INGEST hands DECIDE: `RuntimeRenderInput`

The decide layer does not read `SessionRuntime` — it reads **`RuntimeRenderInput`** (`session-runtime/state.ts`), the declared #493 contract: a `Pick` of exactly the fields the pipeline consumes, each a cleanly separated plane changing reference independently:

| Slice | What it is |
|---|---|
| `entries: Entry[]` | committed JSONL window + embedded optimistic user rows |
| `semantic: { currentTurn, history }` | block-level live turns |
| `ghosts: ReadonlyMap` | provisional records for the stalled-committed case (read-only — mutation is the ghost reducers' job; ghost-less hosts satisfy it with a frozen empty map) |
| `streamPhase` + `streamPhasePendingToolName` + `streamPhasePendingToolUseId` | the WorkIndicator inputs |
| `lastJsonlEntryAt` | producer-clock watermark for the ghost predicate |

Everything else on `SessionRuntime` is *not* a decide input. The tool indices (`toolUseIndex`/`toolResultIndex`/`toolIndexVersion`) feed the RENDER-side tool-pairing context; `conditions`, `subAgents`, `queuedMessages`, and the status/lifecycle fields feed other UI surfaces. Because `RuntimeRenderInput` is a Pick, desktop callers pass the same runtime object unchanged (structural subtype — no wrapper, so per-plane reference identity survives), while the remote client and the replay harness construct honest partial inputs instead of casting.

---

## 4. Stage DECIDE — the ownership ledger

**Where:** `src/renderer/src/rendering/`. **Produces:** a `RenderLedger` = `{ rows, decisions, unknowns }`. The rule that governs the whole stage: **ownership before ordering** (plan D3). Visibility is decided first; ordering never changes what is visible, only the sequence.

### The data model (`model/types.ts`)

- **`RenderCandidate`** — one potential visible unit, block-level. Its identity fields are plural because no single id spans providers (Codex `resp_*`, rollout turn/task ids, Claude `message.id == turnId`, opencode `messageId + callID`); `id` is a pipeline-stable synthetic identity, synthesized at the **collection/observation boundary** (`rendering/observations/*.ts`) from source identities — `entry:<uuid>` for committed rows (position-at-ingest fallback when the provider gave no uuid; stable because `entries` is append-only), `sem:<turnId>:<blockIndex>` for live blocks, `ghost:<uuid>`, `optimistic:<uuid>` — and must never fall back to the visible index (that produced the React-subtree-reuse "phantom duplicate" class). Notable fields:
  - `timestampMs: number | null` — the **D4 trust hierarchy**: committed `entry.timestamp` (producer clock) > semantic `startedAt/endedAt` (local receipt) > `null`. Channel-receipt `ts` values are diagnostics and must *never* land here. `null` means "no trustworthy time" and sorts *after* timestamped content.
  - `textKey` / `normalizedTextKey` — exact and NFKC-collapsed text keys for committed-text ownership (never prefix/fuzzy).
  - `ownedToolUseIds` / `ownedToolResultIds` — block-grain ownership *evidence* mined from a committed entry's content array. They live on the entry-grain candidate (not separate block candidates) because committed rows must stay one-per-entry; without them the corpus proved committed tool ownership was empty for Claude and tool cards painted twice.
- **`RenderOwner`** (closed union) — *who* may paint: `committed · semantic-current · semantic-history · ghost-fallback · optimistic-submit · queue · work · condition · empty · unknown`. Adding one is an architectural event needing plan review.
- **`RenderReason`** (closed, **fixture-gated** enum) — *why* a candidate was selected or rejected. Every value has at least one fixture proving when it fires; **a reason without a fixture does not merge** (plan §7 rule 15). Examples: `committed-text-owned`, `claude-whole-turn-suppressed`, `collapsed-running`, `duplicate-turn-in-history`, the five `ghost-*` reasons, `empty-thinking`, `task-notification-joined`.
- **`OwnershipDecision`** — `{ candidateId, selected, reason, suppressionOwnerId?, evidence[] }`. *This is the debug schema.*
- **`RenderRow`** — `{ candidate, order: { sequence, timeMs, source } }`. `order.source` is a self-explanation string (`"phase:owner:timestamp"`) so a bundle answers "why is this row here" without reconstructing the sort.
- **`RenderLedger`** — `{ rows, decisions, unknowns }`, with the **identity-stability contract** (see §6).

### The pass (`model/ledger.ts`)

`computeLedger`, in strict order:
1. **Committed** candidates — selected by construction.
2. **Live** candidates — decided *against* committed ownership by `decideLiveCandidate` (below).
3. **Statics** — the work chip.
4. **Ghosts** — decided *last* by the five-rule predicate, because they are lowest-trust and only fill gaps.
5. **Empty** — appended after decisions if no content survivor exists (`empty + work` is a legal combination — work is a lifecycle fact, not text).
6. **Order** the survivors.

### Ownership decisions (`model/ownership.ts`)

`decideLiveCandidate` chooses a winner per slot. The discriminator that governs it: **committed *owns* the unit → suppress with a reason; committed has *not caught up* → the unit stays and gets ordered chronologically.** Suppressing un-owned history is data loss (#159/#290 — the committed channel can be permanently dead, and the history bridge may be a turn's only representation). In order:

1. **optimistic-submit** — reconciled by normalized text against committed user text keys → `optimistic-owned-by-committed`; otherwise it *survives* (vanishing early is the silent #339 class).
2. **claude-whole-turn-suppressed** — policy-gated, `semantic-history` only, turnId owned by a committed whole turn. Not applied to a *live* current turn.
3. **assistant-text** — exact or normalized text key owned by committed → `committed-text-owned`.
4. **tool-use** — id owned by committed → `committed-tool-use-owned`; else the **collapsed-running** rule folds an unresolved churn tool (Read/Glob/Grep/Bash) with no committed trace into a running receipt — but only behind a **tail gate** (`committedTailMs > candidate.timestampMs`, fix #465): committed truth has provably moved *past* the tool's turn yet never recorded it. This honors "not caught up means REORDER, never suppress."
5. **tool-result** — yields only to a committed tool *result*, never the tool-use commit alone (hiding live output at tool-use time made output vanish before the durable copy existed).

Per-provider asymmetry is **policy, not forks** (plan D10) — a `SUPPRESSION_POLICY` table sets `wholeTurnByMessageId` (Claude true; Codex/opencode commit one item at a time) and `hideUnresolvedHistoryTools` (Claude only; Codex's function_call_output lands in a *later* turn, so the rule over-fired).

### The ordering law (`model/order.ts`)

A **true chronological merge**, not plane concatenation. This is what kills #239. Phase ranks (`empty=0, content=1, work=2`); within `content`, sort by `timeOf` (`timestampMs ?? MAX_SAFE_INTEGER`, so null timestamps sort to the tail of their phase); a five-way source-rank tiebreak at equal timestamps (committed before semantic-history before semantic-current — the durable row is "the transcript," the bridge row is "the echo"); final tiebreak on `sequence`. Ordering **never** decides visibility.

### The ghost predicate (`model/ghostPredicate.ts`)

Five short-circuit rules, each the scar of a shipped regression: `ghost-superseded` (authoritative row landed) → `ghost-not-orphaned` (30s TTL guarding the ~100ms turn_completed→JSONL race) → `ghost-semantic-owned` (turnId owned by live semantic — retained even after `SemanticStreamingTurn`'s deletion because it dedups ghost-vs-live) → `ghost-older-than-jsonl` (render only when the ghost is newer than the JSONL watermark) → `ghost-sidecar-shape` (skip the small title-gen/predict-next-prompt single-text-block fingerprint).

### The unknowns contract (`model/unknowns.ts`)

Anything unrecognized — a proxy event type with no handler, a block kind with no policy, a committed row correlating with nothing — becomes a **structured finding**, never a silent row and never a silent drop: `{ provider, sourcePlane, eventType?, shapePaths, payloadHash, redactedPreview?, seenCount, disposition, evidence }`. Redaction is *structural*: `shapePathsOf` stores key *paths* (depth 3) and never values; a shared `SENSITIVE_KEY` regex retains a secret key's *name* (so a reader knows it was present) but drops the value. Unrecognized semantic block kinds still render via an assistant-text fallback (`rendered_fallback_dev_only`) — hiding content on an unrecognized label is the worse failure.

---

## 5. Stage RENDER — the feed painter

**Where:** `src/renderer/src/features/feed/`. **Consumes:** an ordered `FeedRenderItem[]`. **Rule:** makes no decisions.

### The view bridge (`features/feed/ledger/ledgerFeedItems.ts`) — the layer boundary

`ledgerToFeedItems(ledger, ctx)` maps `RenderLedger.rows` → `FeedRenderItem[]`. Because the ledger carries only turnId + blockIndex (not the drawable payload), the bridge looks each row up in `entriesByUuid`/`turnsById` and attaches the rich block/entry. Two mechanics matter:
- It **pre-groups semantic rows by turnId** and emits a turn's blocks contiguously at the turn's first position (the ordering law interleaves equal-timestamp turns; the bridge un-interleaves for paint).
- It carries a **`dropped[]`** list: a ledger-*selected* candidate whose payload can't be resolved is pushed to `dropped` and loudly `console.warn`-ed by `useLedgerFeedItems`, *never* silently omitted (a silent drop is the #239 present-but-invisible class).

`buildSemanticTurnItems` emits one `semantic-block` per approved block, folds consecutive churn tools into a `semantic-collapsed-activity` unit via **`groupSemanticActivity`** (grouping only — *suppression removed*, because the ledger is the sole suppressor; if the bridge re-ran suppression it would become a second decision-maker, the exact thing #491 killed), and emits `semantic-text` for blockless turns (Codex/opencode deliver text on `turn.text` with an empty block map). One deliberate carve-out: a **RUNNING collapsed-activity unit emits no item at all** — `SemanticCollapsedActivityRow` paints null while running (the WorkIndicator owns the busy surface), so emitting an item would put a null-painting row in the list while the ledger counts its blocks as content, the false-ownership class the pipeline exists to kill (#492 review finding). Only the finished "worked: N reads" receipt emits.

### The `FeedRenderItem` union (`feed/model/renderModel.ts`)

A discriminated union: `entry` (a committed/ghost/optimistic transcript entry) · `semantic-block` (one live block — the #491 block-level model) · `semantic-collapsed-activity` (a finished "worked: N reads" receipt) · `semantic-text` (blockless turn text) · `work` (the single WorkIndicator slot) · `empty` (the "waiting for <provider>…" placeholder). `feedRenderModelFromItems` attaches debug side-products only — **no sorting happens here; the ledger's order *is* the order.**

### `Feed.tsx` — the painter

`Feed = memo(FeedImpl)`: the whole component is memoized so composer typing / focus / split-resize bail the entire markdown subtree. Its core is a single `{renderItems.map(renderFeedItem)}` — **the one-owner rule** — where `renderFeedItem` is a switch over the six item types. The container owns its own scroll listener; sticky-bottom follow, scroll-position persistence across unmount, lazy mounting (`LazyEntry` + `EAGER_TAIL`, keyed on committed ordinal so a busy live turn can't push the newest prompt into lazy-mount), older-history load, and the picker auto-scroll tweens all live here as independent effects. **Performance is an identity-stability story:** memo-by-`text` prose is the single biggest win, every row is individually memoized, and the tool-index context clones only on `toolIndexVersion` bump.

### Row dispatch

`EntryRow` first offers each durable entry to the active provider's
`renderDurableEntry`, then falls back to neutral `ConversationRow` / `SystemRow`
containers. Claude/Codex compact artifacts and Claude task-notification carriers
are therefore admitted by their provider rather than by central entry-kind/XML
switches. `ConversationRow` renders string content as one `MarkerRow` and array
content as one `Block` per content block. **`Block`** is intentionally shallow:
text/thinking/image stay neutral; a correlated tool-use/result pair goes once
through `getRendererProviderCapabilities(provider).renderOperation`; explicit
render/fallback/absorb decisions then select provider UI or the bounded
`JsonToolRow` / `ToolResultRow` baseline. Git, questions, tasks, Agent Code MCP,
and all other provider vocabulary enter only through capabilities.

The apparent centrality of `Block` is intentionally shallow. Provider interpretation lives under `src/providers/<provider>/renderer/`: `adapters/` decode that provider's wire vocabulary, `components/<family>/` compose provider chrome, and `rows/dispatch.tsx` is the committed capability. Shared code starts only after an adapter has produced a narrow semantic protocol model (`providers/shared/renderer/protocols/{code-edit,command,mcp-content,structured-output,…}`). The feed imports no specific provider renderer; the filesystem-scanning boundary test in `src/providers/importBoundaries.test.ts` makes that architectural rule executable.

Live rows mirror committed ones so streaming ≈ final: **`SemanticLiveBlockRow`** first asks the provider's `renderSemanticBlock` capability, whose provider-local semantic dispatcher reuses the committed adapters/components when the wire shape is equivalent. Provider-neutral prose/reasoning and the total bounded JSON fallback remain central because they interpret no provider vocabulary. Everything hangs off **`MarkerRow`** — the universal `❯` (user) / `⏺` (assistant) / `⎿` (tool/sub-item) fixed-marker-column + hanging-indent primitive — and prose flows through `TextProse`/`StreamingProse` (react-markdown + remark-gfm). The single "agent is working" affordance is **`WorkIndicator`**, driven solely by `streamPhase`.

The former Phase 10 exceptions are closed. Providers adapt supported shell
wrappers to the shared Git command formatter only after content proves a pure
Git operation; mixed Git/non-Git chains decline, every claimed result retains a
lazy bounded exact-source disclosure, and the paired result is absorbed only by
the named command receipt. Durable compaction is provider-owned and replayable;
live condition state remains a separate plane with structured-first precedence
and screen-only fallback provenance.

### Shape memory and total fallback

The painter is instrumented at its actual decision points (`Block`, `EntryRow`, and `SemanticLiveBlockRow`). When developer session recording is armed, the observer in `features/feed/evidence/observer.ts` computes a bounded `fp2-*` structural fingerprint and records the paint outcome beside the ordinary recording. It retains literal structural key paths because this is developer evidence and the source recording already contains the complete local payload; scalar content is excluded from fingerprint *identity* so two different commands with the same grammar remain one shape.

Reviewed shape promises live in `src/providers/{claude,codex,opencode}/renderer/shapes.ts`. A catalog entry says where the structure was observed, which lifecycle milestones exist, which fixture proves it, and whether the route is specialized, generic, absorbed, or condition-owned; shipping catalogs may not retain `planned` entries. `scripts/audit-rendering-shapes.mts` joins the frozen bundle corpus with optional live recording sidecars. Current schema-v2 unknown, misrouted, unsupported-lifecycle, and unknown-outcome observations fail the audit. Schema-v1 receipts from the unreleased pre-catalog experiment are reported as obsolete and require a fresh capture rather than runtime reinterpretation. `src/providers/shapes.coverage.test.ts` permanently gates the checked-in corpus and every specialized/absorbed route's fixture evidence.

Unknown does not mean raw garbage or invisibility. Unknown tools use the bounded `JsonToolRow`; unknown results first try typed MCP, structured JSON/JSONL/path-line, and safe media presentations before the bounded raw result; an unknown semantic block exposes its normalized object lazily. Provider adapters are conservative and may decline to these same fallbacks. This is why the system can support open-world MCP without pretending to own every server schema.

---

## 6. Cross-cutting: identity stability (why the feed is fast)

The D11 **identity-stability contract**: a ledger pass whose inputs did not change **must return the previous object by reference**. This is load-bearing, not an optimization — every Feed memo keys on object identity, and violating it reintroduced the render-churn defect class *twice* in production (a double-render-per-transition, and always-clone ghost maps). Three tiers compose into "no real change ⇒ no repaint":

1. **Adapter per-plane caches** (`rendering/adapter/collectLedgerInput.ts`) — each plane recomputes only when its own runtime slice reference moved.
2. **Ledger last-call cache** — unchanged inputs return the previous `RenderLedger` by reference.
3. **Hook memo** (`useLedgerFeedItems`) — keyed on the *exact runtime slice references*, not `runtime` itself (which changes identity on unrelated fields like scroll state).

This is why typing in the composer never re-parses the transcript's markdown, and it is machine-checked by replay invariant `checkD11`.

---

## 7. Where to look

| You want… | Start at |
|---|---|
| the runtime object + the decide-layer contract | `session-runtime/state.ts` (`SessionRuntime`, `RuntimeRenderInput`) |
| how channels become the runtime | `workspace/hook/ipc/useIpcSubscriptions.ts` |
| the semantic fold | `session-runtime/semantic/foldEvent.ts` |
| provider neutrality | `providers/registry.renderer.capabilities.ts` + `shared/types/providerConfig.ts` |
| the ledger contract / one invariant | `rendering/model/types.ts` |
| ownership decisions | `rendering/model/ownership.ts` |
| the ordering law | `rendering/model/order.ts` |
| ghosts | `rendering/model/ghostPredicate.ts` + `session-runtime/ghosts.ts` + `docs/design/ghost-system.md` |
| unknowns / redaction | `rendering/model/unknowns.ts` |
| runtime → ledger seam | `rendering/adapter/collectLedgerInput.ts` |
| ledger → feed bridge | `features/feed/ledger/ledgerFeedItems.ts` + `useLedgerFeedItems.ts` |
| the painter | `features/feed/ui/Feed.tsx` |
| the item contract | `features/feed/model/renderModel.ts` |
| row dispatch | `features/feed/ui/rows/{EntryRow,ConversationRow,Block}.tsx` |
| live rows | `features/feed/ui/semantic/BlockRow.tsx` |
| provider interpretation + components | `providers/<provider>/renderer/{adapters,components,rows,semantic}/` |
| shared visual protocols | `providers/shared/renderer/protocols/` |
| shape catalogs + coverage gate | `providers/<provider>/renderer/shapes.ts` + `providers/shapes.coverage.test.ts` |
| runtime shape capture + audit | `features/feed/evidence/observer.ts` + `scripts/audit-rendering-shapes.mts` |
| the layout primitive | `features/feed/ui/MarkerRow.tsx` |
| machine-checked invariants | `rendering/replay/invariants.ts` |

### A note on what's *gone*

The pre-rewrite decision core is deleted: `deriveFeedRenderModel` (the plane partitioner), `deriveFeedCommittedProjection` (the dedup feeder), the `SemanticStreamingTurn` / `StreamingTurn.tsx` component (retired by #491 block-level un-collapse), the `AGENT_CODE_RENDER_PIPELINE` flag and the legacy runtime path it gated (Stage-3 cutover, parity was green over the incident corpus), and `rendering/policy/foldPolicy.ts` (dead since the per-provider fold policy moved to `src/providers/*/renderer/semanticFoldPolicy.ts`; removed in #493). PR #555 Phase 9 also deleted the old `ClaudeRows`/`CodexRows` feed barrels, central `ToolUseRow`, central answered-question exception, and duplicate result/partial-string decoders after provider adapters became canonical. Note that `rendering/shadow/shadowDiff.ts` is **not** gone — the runtime shadow *mode* died at cutover, but the normalization/diff engine survives as the comparison core of the bundle and recording corpus tests. Git and compact-entry behavior still exists, but its raw recognition and presentation now enter through provider capabilities; only their narrow visual protocols are shared.
