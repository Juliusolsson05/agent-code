# Ghost system

> **Source-of-truth design doc.** Be careful changing this file — it explains *why* the ghost subsystem is shaped the way it is, and the load-bearing invariants downstream code relies on. If you are about to alter ghost minting, reconciliation, the render predicate, or the orphan TTL, **read the [Warning](#warning) section first.** Bug fixes that don't change the design don't change this file.

## What ghost is, in plain English

cc-shell talks to the agent (Claude Code, Codex) two ways at the same time:

- It **reads the agent's authoritative transcript file** (Claude Code's `~/.claude/projects/<proj>/<sid>.jsonl`, Codex's rollout JSONL). That file is the durable record of what happened — but it's written *lazily*. Claude Code batches transcript writes every 100 ms (10 ms for remote sessions); Codex queues writes through a tokio mpsc channel that drains on flush barriers. The file is structurally behind reality.
- It **observes the agent's network traffic via a per-session mitmproxy.** The proxy emits a flat semantic stream — `turn_started`, `text_delta`, `tool_input_delta`, `tool_input_finalized`, `block_completed`, `tool_result`, `turn_completed`, etc. — as the model's reply streams in. The proxy is roughly real-time.

The proxy is ahead. The file catches up. Eventually they agree.

A **ghost** is a provisional `ClaudeEntry` cc-shell mints from the proxy stream, tagged `_atp.origin = 'ghost'`, with a deterministic uuid (`g-<turnId>-<blockIndex>`). It exists to bridge the gap between the two sources without producing duplicate-render bugs. When the authoritative JSONL entry lands, the ghost is *superseded* and dropped from the visible set. If it never lands, the ghost is *orphaned* and (sometimes — see the predicate) surfaces as the only record of what the proxy observed.

The ghost primitive is general-purpose and lives in the standalone `agent-transcript-parser` package (`./packages/agent-transcript-parser/src/ghost.ts`, doc at `./packages/agent-transcript-parser/docs/ghost.md`). cc-shell's job is to wire it up: mint ghosts from semantic events, persist to disk, reconcile against JSONL, decide when to render.

## Why ghost exists

The naive alternatives all fail:

| Approach | Failure |
|---|---|
| Render only the JSONL file. | Visible 100 ms+ delay between the model talking and the screen showing anything. Worse during slow batched flushes or large tool_results. |
| Render only the proxy stream. | No durable record. Closing cc-shell mid-turn loses the partial turn. Resume after crash has nothing to show. |
| Render BOTH unconditionally — JSONL above, proxy below. | The same sentence appears twice during the lag window. Documented historical bug on Codex (`docs/superpowers/plans/2026-04-20-rendering-fixes.md`). |

The design idea was: one merged feed. Authoritative entries from the file, plus provisional ghost rows when the proxy is ahead, with automatic supersedure when the file catches up. The user sees one row that transitions seamlessly from "live preview" to "committed."

That plan was never fully completed (see [Phase 3: deliberately out of scope](#phase-3-deliberately-out-of-scope)). What ships today is the *bookkeeping* half of the system — minting, reconciling, persisting — combined with a tightly-scoped render path that surfaces ghosts only in the rare case where they're actually needed: when JSONL has stalled past the proxy.

## The two visible owners of the live turn

This is the most-confusing part of the current architecture, and it's load-bearing for every rule below.

In cc-shell today, the **live current turn** (the assistant's in-flight reply) is rendered by `SemanticStreamingTurn`, which reads `runtime.semantic.currentTurn` directly off the semantic reducer. **Not from ghosts.** See `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx` and the call site at `src/renderer/src/features/feed/ui/Feed.tsx:912-916`.

Ghosts exist *in parallel* with that live render. Every semantic event that updates `currentTurn` ALSO mints / updates a corresponding ghost via `ghostsFromSemanticTurn` in `src/renderer/src/workspace/ghosts.ts`. The two paths don't collide because the render predicate (below) explicitly excludes any ghost whose `turnId === currentTurn.turnId` — `SemanticStreamingTurn` owns that turn, ghosts can't surface for it.

So the practical question for the ghost system is: **what is rendering ghost rows actually for, given that `SemanticStreamingTurn` covers the normal live-turn case?**

Answer: a small set of fallback cases where `SemanticStreamingTurn` can't help.

1. **JSONL stuck mid-turn.** The agent process gets wedged or its writer backlogs while the proxy keeps emitting events. `currentTurn` eventually clears (or doesn't), JSONL never lands. The ghost on disk is the only record of the turn.
2. **Crash + restart.** cc-shell exited mid-turn. Semantic state was in-memory and is gone. JSONL has a partial transcript that ends before the in-flight turn. The ghost log on disk preserves what the proxy saw; on resume it surfaces the lost partial turn.

Both reduce to the same condition: **proxy state is past the JSONL tail with no recovery in sight.** The render predicate detects this structurally.

## Architecture: components and roles

The whole subsystem reads in one direction — semantic events flow in, the rendered feed flows out — but it touches a lot of files. Here is what each one does.

```
                 ┌────────────────────────────────────────────────┐
                 │ ClaudeProxyAdapter / CodexResponsesAdapter      │
                 │ (in packages/claude-code-headless,              │
                 │     packages/codex-headless)                    │
                 │                                                 │
                 │ Sees raw network events, publishes the          │
                 │ semantic stream. Filters known-bad sidecars     │
                 │ at source via isSidecarFlow.                    │
                 └─────────────────────────┬───────────────────────┘
                                           │ semantic events
                                           ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ src/renderer/src/workspace/semantic/foldEvent.ts              │
   │ Reduces semantic events into runtime.semantic.currentTurn.    │
   │ Provider-aware turn ownership (Codex strict, Claude auto-     │
   │ replace). Drops events for the wrong turnId.                  │
   └───────────────────────────────────────────────────────────────┘
                                           │
                ┌──────────────────────────┴─────────────────────┐
                ▼                                                ▼
   ┌────────────────────────────┐         ┌─────────────────────────────┐
   │ SemanticStreamingTurn      │         │ src/renderer/src/workspace/ │
   │ (Feed.tsx mounts this)     │         │   ghosts.ts                 │
   │                            │         │                             │
   │ Renders the live current   │         │ ghostsFromSemanticTurn —    │
   │ turn DIRECTLY off          │         │ mints / updates ghosts from │
   │ runtime.semantic           │         │ each semantic tick.         │
   │   .currentTurn.            │         │                             │
   │                            │         │ Reference-stable: returns   │
   │ This is the everyday       │         │ prev unchanged on no-op.    │
   │ live-turn path.            │         └────────────┬────────────────┘
   └────────────────────────────┘                      │
                                                       │ next ghost map
                                                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts       │
   │                                                                  │
   │ - Calls ghostsFromSemanticTurn at the semantic ingest site.      │
   │ - Calls reconcileUpstream at the JSONL ingest site to supersede  │
   │   ghosts whose authoritative entry just landed.                  │
   │ - Stamps lastJsonlEntryAt from the JSONL stream.                 │
   │ - Runs orphanStale every 1s with TTL=30s.                        │
   │ - Persists changed ghosts via window.api.ghostAppend.            │
   └────────────┬──────────────────────────────────────┬──────────────┘
                │                                      │
                ▼                                      ▼
   ┌──────────────────────────┐         ┌──────────────────────────────┐
   │ src/main/ghostJournal.ts │         │ src/renderer/src/workspace/  │
   │ (main process)           │         │   mergedEntries.ts           │
   │                          │         │                              │
   │ One JSONL file per       │         │ selectMergedEntries — the    │
   │ session under            │         │ five-rule render predicate.  │
   │ <userData>/ghost-logs/.  │         │ Decides which ghosts (if     │
   │ Append-only, batched     │         │ any) merge into the rendered │
   │ at 100ms.                │         │ feed via mergeWithUpstream.  │
   │                          │         │                              │
   │ Read on resume by        │         │ Most ticks returns           │
   │ src/renderer/src/        │         │ runtime.entries unchanged.   │
   │   workspace/hook/        │         └──────────────┬───────────────┘
   │   actions/session.ts.    │                        │
   └──────────────────────────┘                        ▼
                                          ┌─────────────────────────┐
                                          │ Feed.tsx renders this   │
                                          │ as committed transcript │
                                          │ rows.                   │
                                          └─────────────────────────┘
```

### Components

- **atp ghost primitives** — `packages/agent-transcript-parser/src/ghost.ts`. Pure library: `createGhost`, `updateGhost`, `supersedeGhost`, `orphanGhost`, `reduceGhostLog`, `reduceGhostLogSansSuperseded`, `mergeWithUpstream`. No IO. Reusable outside cc-shell.
- **cc-shell renderer reducer** — `src/renderer/src/workspace/ghosts.ts`. Bridges semantic events to atp primitives: `ghostsFromSemanticTurn`, `reconcileUpstream`, `orphanStale`, `gcSupersededGhosts`, `ghostsToPersist`. Reference-stable on no-op.
- **render predicate** — `src/renderer/src/workspace/mergedEntries.ts`. The five-rule selector. Source of truth for "does this ghost surface in the feed."
- **IPC wiring** — `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`. The orchestration layer: mint on semantic, reconcile on JSONL, sweep orphans on a 1s timer, stamp `lastJsonlEntryAt` from JSONL bursts, persist diffs.
- **bootstrap on resume** — `src/renderer/src/workspace/hook/actions/session.ts` (ghost log read + reconcile against loaded JSONL tail) and `src/renderer/src/workspace/hook/actions/initialHistory.ts` (stamping `lastJsonlEntryAt` from the loaded tail).
- **disk persistence** — `src/main/ghostJournal.ts` (writer with batched 100 ms drain), `src/main/ipc/ghost.ts` (`ghost:append` / `ghost:read`), `src/preload/api/ghost.ts` (renderer bridge).
- **runtime field** — `src/renderer/src/workspace/workspaceState.ts` — `SessionRuntime.ghosts: Map<string, GhostEntry>` and `SessionRuntime.lastJsonlEntryAt: number | null`.
- **proxy-side sidecar filter** — `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:isSidecarFlow`. Demotes Claude Code's auxiliary calls (title gen, branch-name, compaction summary, hook-agent) to `attribution: 'secondary'` so they don't open a turn at all. Catches most known sidecars but not the predict-next-prompt variant; the renderer-side shape filter (rule 5 below) is the backstop.
- **the parallel live owner** — `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx`. Reads `runtime.semantic.currentTurn` directly. Not part of the ghost system but inseparable from it: rule 3 of the predicate exists specifically because `SemanticStreamingTurn` owns the live current turn.

## Lifecycle

```
created ──► updated* ──► superseded
                  \──► orphaned
```

- **created** — `createGhost` mints a fresh ghost with a deterministic `(turnId, blockIndex)` uuid. `createdAt = updatedAt = now`. Append to the journal.
- **updated** — `updateGhost` produces a revised snapshot with new content and bumped `updatedAt`. Same uuid. Append to the journal. The reducer `reduceGhostLog` picks the freshest by `updatedAt` at read time.
- **superseded** — `supersedeGhost` sets `_atp.supersededBy = realUuid`. Triggered by `reconcileUpstream` when a JSONL entry lands that matches the ghost's `(turnId, blockIndex)` (or `tool_use_id`). Append to the journal as the final state record.
- **orphaned** — `orphanGhost` sets `_atp.orphanedAt`. Triggered by the TTL sweep (`orphanStale`, every 1 s, threshold 30 s). The ghost is now eligible for the render predicate's rule 2.

A ghost is appended-only on disk. There is no in-place mutation, no file rewrite, no lock file. `reduceGhostLog` folds the append stream into a `Map<uuid, GhostEntry>` at read time.

## The render predicate

This is the source-of-truth rule for whether a ghost appears in the rendered feed. Implemented in `selectMergedEntries` (`src/renderer/src/workspace/mergedEntries.ts`).

A ghost is **render-eligible** iff ALL FIVE of the following hold:

1. **Not superseded.** `ghost._atp.supersededBy === undefined`. JSONL has not caught up; the ghost is still potentially the only record.
2. **Orphaned.** `ghost._atp.orphanedAt !== undefined`. The TTL has elapsed without a JSONL match. JSONL has had its chance for this ghost.
3. **Not the live current turn.** `ghost._atp.turnId !== currentTurnId`. `SemanticStreamingTurn` owns the live turn render; surfacing a ghost for the same turn would double-render.
4. **Past the JSONL tail.** `lastJsonlEntryAt !== null && ghost._atp.updatedAt > lastJsonlEntryAt`. The ghost was minted from a proxy event that occurred *after* the most recent JSONL entry this session has observed. This structurally distinguishes "JSONL stalled past the proxy" from "JSONL kept writing past this ghost."
5. **Not sidecar-shaped.** `!ghostHasSidecarShape(ghost)`. The shape predicate matches Claude Code's known auxiliary-call fingerprint: assistant role, single text block, ≤200 chars. This is the backstop for tail-sidecar leaks rule 4 cannot see.

Why rules 4 AND 5, not just rule 4: the timestamp predicate is structurally correct for "stale orphan from earlier in the session, JSONL kept writing past it" — rule 4 catches that. But it cannot tell apart these two TAIL cases:

- (a) JSONL stopped mid-turn, ghost has the lost partial turn — *should render.*
- (b) Last real JSONL entry committed at `t=100`, then a sidecar leak (predict-next-prompt / title-gen / branch-name) at `t=105`, no later real turn ever supersedes it — *should NOT render.*

Both have `ghost.updatedAt > lastJsonlEntryAt`. Rule 5 is the structural shape check that picks (b) out of the tail.

When all five rules pass, surviving ghosts are merged via `mergeWithUpstream` with `trustSupersededFlag: true`. Tail-append is correct here because by predicate-3 these ghosts are not the active turn, and by predicate-4 they are newer than every committed entry — they belong at the very end chronologically.

When NO ghost passes, `selectMergedEntries` returns `runtime.entries` *by identity* (not a fresh copy). This is load-bearing for Feed's row memoization (see [Reference stability](#reference-stability)).

### Trade-off in rule 5 (knowingly accepted)

A real assistant turn that crashed before any JSONL write AND happened to be a single short text block (e.g. "Done.") would also be hidden — it matches the sidecar shape. Production data shows this is a rare invisible loss; the alternative (orphan title-gen / next-prompt fragments piling up at the bottom of every session) is a daily UX harm. Two prior fix attempts (`686b94e`, `2a83978`) traded along this axis; the current predicate keeps the shape filter as backstop.

## Reconciliation matchers

When a JSONL entry lands, `reconcileUpstream` walks the ghost map and supersedes anything whose authoritative record this entry is. Provider-aware:

- **Claude:** assistant entries carry `message.id` which equals the `turnId` we used for the ghost. Match by `turnId === message.id`. One upstream entry can supersede every ghost block for that turn at once.
- **Codex:** rollout emits one entry per content block, each with its own uuid. The rollout response_id is stamped onto every mapped entry by `stampCodexTurnId` in `src/renderer/src/workspace/codex/rollout.ts`. Match by `(turnId === codexTurnId, blockIndex)`.
- **Both providers, fallback:** if the upstream entry has any `tool_use` block whose id matches a ghost's `_atp.context.toolUseId` or `context.callId`, supersede that specific ghost. This handles edge cases where turn ids don't line up (Codex rollout can mint fresh uuids on replay).

Reconciliation is reference-stable: `reconcileUpstream` returns the input map unchanged when no match was found, so Feed's row memoization holds across no-op JSONL bursts.

## Reference stability

Three reducers MUST return their input unchanged on no-op:

- `ghostsFromSemanticTurn` — many semantic ticks (`usage_updated`, redundant `block_started`, etc.) don't actually mutate any ghost. The reducer lazy-clones: returns `prev` directly until it has a real mutation to land.
- `reconcileUpstream` — most JSONL entries don't match any ghost (compact boundaries, system entries, entries whose ghosts already superseded earlier). The reducer returns `prev` when no match.
- `selectMergedEntries` — when no ghost passes the five-rule predicate, returns `runtime.entries` by identity, NOT a fresh `[...entries]`.

This is not an optimization — it is **load-bearing for Feed's row memos.** If any of these reducers always allocates, every memoized row in Feed busts on every tick, and ReactMarkdown re-parses every text/code block from scratch. The pre-fix versions had this bug; performance was unusable.

If you add a new code path that touches the ghost map, **uphold the contract**: clone only when you actually mutate, and return the input by identity when you didn't.

## Persistence and resume

The ghost journal lives at `<userData>/ghost-logs/<sessionId>.ghost.jsonl`. One file per session. Append-only JSONL. Owned by the main process; the renderer fires-and-forgets `window.api.ghostAppend`.

Why a separate file and not the agent's own JSONL: cc-shell never writes into Claude Code's `~/.claude/projects/<proj>/<sid>.jsonl` or Codex's rollout file. Those belong to the agent and are actively written by its batched queue; two writers on the same file is a torn-line / lost-write disaster. Ghosts are also a cc-shell-internal concern — no external tool needs them.

Why batched at 100 ms: matches Claude Code's own transcript batch interval (`FLUSH_INTERVAL_MS` in `claude-code-src/full/utils/sessionStorage.ts`). Per-entry fsync during streaming would be tens of writes per second across every active pane. The trade-off — up to 100 ms of data loss on hard crash — is acceptable because ghost is provisional by definition and the agent's own JSONL survives independently.

On resume (`src/renderer/src/workspace/hook/actions/session.ts:199-266`):

1. After session spawn, fire-and-forget `window.api.ghostRead(sessionId)`.
2. Fold the returned entries via `reduceGhostLogSansSuperseded` (drops ghosts already superseded on disk so they don't resurface on a fresh session).
3. Merge into `runtime.ghosts` — disk ghosts only fill slots the live runtime hasn't already produced. If a uuid exists in-memory, prefer the in-memory copy because it's strictly fresher.
4. Run `reconcileUpstream` against `current.entries` (the JSONL tail loaded by `loadInitialHistoryForSession`). This catches the case where the previous session's ghost log has entries whose authoritative JSONL has already landed in the loaded tail — without this pass they'd resurface as orphans.
5. Persist any newly-produced supersede records.

The `lastJsonlEntryAt` field is also primed on resume from the loaded tail's max `entry.timestamp` (see `initialHistory.ts`), so the predicate's rule 4 has the right anchor against ghost `_atp.updatedAt` from the previous run.

## The orphan TTL

`GHOST_ORPHAN_TTL_MS = 30000` (30 s). `GHOST_ORPHAN_SWEEP_MS = 1000` (sweep every second).

A ghost is marked orphaned when `now - updatedAt > TTL` and it isn't already superseded or orphaned. The TTL is **not** "how fast we paint fallback" — it's "how long we wait before concluding JSONL isn't coming for this ghost." After the orphan flag fires, the ghost is merely *eligible* for the render predicate; rules 3, 4, 5 still gate visibility.

In practice, during healthy operation the orphan flag rarely fires for a real assistant turn:

- Active streaming bumps `updatedAt` on every `text_delta`, so the TTL never reaches threshold.
- Long tool execution freezes `updatedAt` on the tool_use ghost between `tool_input_finalized` and `tool_result`, but `currentTurn` stays alive across pending tools (`hasPendingSemanticTools` in `semantic/helpers.ts:158-175`), so rule 3 hides the ghost regardless of orphan state.

The TTL does fire reliably in the genuine stuck cases:

- **Live-stuck:** `currentTurn` cleared (or hangs), JSONL stalled, semantic stream went silent → orphan after 30 s, predicate evaluates, ghost may render.
- **Resume-after-crash:** ghost log loaded from disk, ghost's `updatedAt` is from before the crash → orphan sweep fires within the first second of resume → predicate evaluates against the loaded JSONL tail.

## Phase 3: deliberately out of scope

The original design intent was for ghost to be the **only** live render path. `SemanticStreamingTurn` would be deleted. The merged feed would render committed entries plus ghosts (in chronological position via ordered insertion in `mergeWithUpstream`), with seamless supersedure on JSONL catch-up.

That deletion never happened. Deferring it is fine — `SemanticStreamingTurn` reliably handles the everyday live-turn case, and the gap that ghost rendering covers is genuinely small (just the JSONL-stalled-past-proxy fallback). The cost is the dual-owner relationship described in [The two visible owners of the live turn](#the-two-visible-owners-of-the-live-turn) and the extra rule 3 in the predicate.

To do Phase 3, atp's `mergeWithUpstream` would need to learn ordered insertion (anchor by `parentUuid` / `turnId` / nearest committed neighbor instead of always tail-appending), and Feed would need to render the merged list as the only source of live blocks. Until that work happens, the predicate's rule 3 keeps the two paths from colliding.

## Warning

Be careful changing this subsystem. The five-rule predicate has been wrong four times in production:

| Commit | What it tried | Why it regressed |
|---|---|---|
| `10e4fc5` (2026-04-20) | Hide all non-current-turn ghosts | Lost the legitimate orphan-fallback case entirely |
| `686b94e` (2026-04-24) | Render orphan ghosts as fallback after TTL | Couldn't tell stuck-mid-turn apart from sidecar leaks; orphan title-gen fragments piled up at feed tail forever |
| `2a83978` (2026-05-07) | Add 200-char shape filter on top of `686b94e` | Worked for short sidecars but missed predict-next-prompt with full conversation history |
| `fix/hide-orphan-ghost-tail` (abandoned local v1, 2026-05-07) | Hide all ghosts again | Killed the legitimate stuck-mid-turn fallback; user noticed |

The current predicate (timestamp gate + shape filter) layered fix passed cross-review and lands in `fix/render-stuck-ghosts`. Each prior attempt looked correct in isolation. The lesson is that *any* simplification of the rules breaks at least one production case. Specifically:

- **Don't drop rule 3** without first deleting `SemanticStreamingTurn`. The two surfaces will double-render the live turn.
- **Don't drop rule 4** by going back to a TTL-only orphan render. Stale-old-orphan-below-newer-rows comes back, plus every sidecar leak.
- **Don't drop rule 5** without first widening the proxy-side `isSidecarFlow` predicate to cover predict-next-prompt with full-history bodies. The tail-sidecar case is the dominant production failure mode.
- **Don't bump the orphan TTL aggressively** in either direction without thinking through what new code reads `orphanedAt`. Today the only consumer is the predicate; future code may treat orphan-ness as a stronger signal.
- **Don't lose the reference-stability invariants** in `ghostsFromSemanticTurn`, `reconcileUpstream`, or `selectMergedEntries`. Feed's row memos depend on them. Allocating a fresh map / array on no-op invalidates every memoized row in the feed.
- **Don't ghost tool RESULTS.** `blocksFromSemantic` deliberately drops `tool_result` / `function_call_output` / `custom_tool_call_output`. Their authoritative form arrives in upstream JSONL and synthesizing a provisional one would fabricate output the model never produced. Ghosting tool-call *inputs* is safe; ghosting outputs is not.
- **Don't change `entry.timestamp` semantics.** `lastJsonlEntryAt` is parsed from `entry.timestamp` (ISO 8601 string) on both Claude and Codex paths. The comparison against ghost `_atp.updatedAt` only works because both are wall-clock-when-the-producer-observed-the-event. If a future JSONL entry path stamps `Date.now()` instead of the real timestamp, rule 4 silently degrades on resume.

## Pointers to deeper analysis

If you need more than this doc:

- `packages/agent-transcript-parser/docs/ghost.md` — the standalone library's design rationale for the ghost primitive.
- `docs/superpowers/plans/2026-05-07-ghost-system-findings.md` — long-form forensic write-up of the system, including the four prior fix attempts, evidence from production debug bundles, and the case table the predicate satisfies. Date-stamped because it's a snapshot in time, not an ongoing source of truth.
- `docs/superpowers/plans/2026-05-07-ghost-rendering-predicate.md` — the implementation plan that landed the current predicate.
- `docs/superpowers/plans/2026-04-20-rendering-fixes.md` — the original plan for the dual-render fix wave that introduced the ghost system.
- `docs/superpowers/plans/2026-04-18-headless-live-turn-redesign.md` — the original (un-finished) Phase 3 plan.
