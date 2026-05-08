# Ghost system — findings, drift, and the actual fix

**Status:** synthesis doc, not yet executed. Written 2026-05-07 after a long
investigation triggered by orphan ghosts piling up at the bottom of the
feed across multiple Claude sessions.

**Audience:** another agent reading this cold. They will validate the
analysis and either green-light the implementation plan in §11 or push
back. Do NOT execute anything from §11 without re-reading the code at the
file:line references in §13 — comments may have drifted again by the time
you see this.

**TL;DR:**
- Ghost was designed to be the single live render path; that plan
  ("Phase 3" in the headless redesign) never landed.
- `SemanticStreamingTurn` still owns the live current-turn render off the
  semantic channel. Ghost is a parallel ledger that nothing visible
  reads in the current code (`mergedEntries.ts:60-69` returns
  `runtime.entries` unchanged).
- Three previous attempts to make ghost-merge rendering work
  (`10e4fc5`, `686b94e`, `2a83978`) regressed each time. The common
  failure: the orphan TTL fires for both "JSONL stalled past the proxy"
  (the actual race case) and "sidecar leaks Claude Code never logs to
  JSONL" (title-gen, predict-next-prompt). Tail-appending both produces
  permanent stale rows.
- The fix is to render an orphan ghost only when its `_atp.updatedAt` is
  strictly newer than the newest JSONL entry timestamp we have observed
  for the session. That predicate distinguishes the two cases by
  construction.
- Cleanup is small (~few hundred lines, mostly comments). No
  architectural surgery.
- `crash recovery` was a fiction in earlier framings — corrected here.

---

## 1. What ghost is, plainly

Two things are watching the same conversation:

1. **Claude Code (or Codex)** writes the *authoritative* JSONL transcript
   on disk. It batches writes every 100 ms (10 ms for remote sessions
   per `claude-code-src/full/utils/sessionStorage.ts:FLUSH_INTERVAL_MS`).
   Codex's `RolloutRecorder` queues writes through a tokio mpsc channel
   that drains on flush barriers. Either way, the file is structurally
   behind the live network stream.

2. **Our proxy** (mitmproxy with our addon) sees the model's reply
   *as it streams in*. It feeds those events into
   `ClaudeProxyAdapter` / `CodexResponsesAdapter`, which publish a flat
   stream of semantic events (`turn_started`, `text_delta`,
   `tool_input_delta`, `tool_input_finalized`, `block_completed`,
   `tool_result`, `turn_completed`, etc.).

cc-shell wants to show one feed. With both inputs available:
- *render only JSONL* → visible delay (model is talking, screen is blank).
- *render only proxy* → no durable record once cc-shell exits; on
  resume the partial turn is gone.
- *render both naively* → same sentence appears twice during the lag
  window.

Ghost was supposed to be the bridge: one merged feed, with provisional
rows that swap to authoritative when JSONL catches up.

## 2. What ghost is, technically

Defined in `agent-transcript-parser/src/ghost.ts`. A ghost is a
`ClaudeEntry` with an `_atp` sidecar:

```ts
type AtpGhostSidecar = {
  origin: 'ghost'
  turnId: string          // Claude message.id / Codex response_id
  blockIndex: number      // 0..N within the turn
  createdAt: number       // ms epoch, set once
  updatedAt: number       // ms epoch, bumped on every snapshot
  supersededBy?: string   // real upstream uuid once reconciled
  orphanedAt?: number     // set after TTL elapses without a match
  context?: Record<string, unknown>  // free-form: source/messagePhase/toolUseId
}
```

uuid is deterministic: `g-<turnId>-<blockIndex>`. That determinism is
load-bearing — ghost logs are append-only JSONL and the reducer
(`reduceGhostLog`) picks the freshest snapshot per uuid by `updatedAt`.
No mutation, no rewrite, no lock files. Quote from
`packages/agent-transcript-parser/src/ghost.ts:71-96`:

> WHY deterministic instead of random:
> Ghost logs are append-only JSONL. The reducer's last-write-wins rule
> only works if repeated snapshots for the same block share a key. A
> random uuid per write would force the reducer to invent its own
> grouping — a task with no non-heuristic solution for non-adjacent
> writes.
>
> The `g-` prefix ensures a ghost uuid can never collide with a Claude
> or Codex uuid in the same file. Claude uses `crypto.randomUUID()`
> which produces RFC-4122 uuids; those never start with `g-`.

Lifecycle, from `packages/agent-transcript-parser/docs/ghost.md:30-40`:

```
created ──► updated* ──► superseded
                  \──► orphaned
```

Reconciliation is consumer-driven. atp ships `mergeWithUpstream` as a
reference merger; it appends unsuperseded ghosts at the **tail** of the
upstream entry list. That tail-append is what every previous render
attempt got wrong (see §8).

Atp is intentionally library-quality: no IO, no event subscriptions, no
cc-shell vocabulary leak.

## 3. The components in cc-shell

| File | Role |
|---|---|
| `packages/agent-transcript-parser/src/ghost.ts` | atp primitives: `createGhost`, `updateGhost`, `supersedeGhost`, `orphanGhost`, `reduceGhostLog`, `reduceGhostLogSansSuperseded`, `mergeWithUpstream`. |
| `packages/agent-transcript-parser/src/types.ts` | `AtpGhostSidecar`, `GhostEntry`, `ClaudeContentBlock`, etc. |
| `src/main/ghostJournal.ts` | Disk writer. One file per session at `<userData>/ghost-logs/<sessionId>.ghost.jsonl`. 100 ms batched drain. Separate from the CLI's own JSONL — never write into Claude Code's or Codex's transcript files. |
| `src/main/ipc/ghost.ts` | IPC handlers `ghost:append` (fire-and-forget) and `ghost:read` (replay full log on resume). |
| `src/preload/api/ghost.ts` | Renderer-side bridge. `window.api.ghostAppend` / `window.api.ghostRead`. |
| `src/renderer/src/workspace/ghosts.ts` | Renderer reducer. `ghostsFromSemanticTurn` (mints/updates from semantic events), `reconcileUpstream` (supersedes on JSONL ingest), `orphanStale` (TTL sweep), `gcSupersededGhosts`, `ghostsToPersist` (diff-based persistence). |
| `src/renderer/src/workspace/mergedEntries.ts` | The render gate. `selectMergedEntries` decides which ghosts (if any) are visible in the main feed. **This is the file the fix changes.** |
| `src/renderer/src/workspace/tile-tree/TileLeaf.tsx` | Calls `selectMergedEntries(runtime, runtime.semantic.currentTurn?.turnId ?? null)` and passes the result as `entries={...}` to `Feed`. |
| `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | Wires up the ghost reducer at the semantic ingest site (`ghostsFromSemanticTurn`), the JSONL ingest site (`reconcileUpstream`), the orphan sweep timer (`orphanStale` every 1 s, TTL currently 3 s), and disk persistence (`ghostsToPersist` → `ghostAppend`). |
| `src/renderer/src/workspace/hook/actions/session.ts` | On session spawn: fire-and-forget reads the ghost log, folds via `reduceGhostLogSansSuperseded`, merges into the runtime ghost map, then runs `reconcileUpstream` against any already-loaded JSONL entries. Persists supersede records produced by that pass. |
| `src/renderer/src/workspace/workspaceState.ts` | `SessionRuntime.ghosts: Map<string, GhostEntry>` field; initialized empty in `emptyRuntime()`. |
| `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx` | `SemanticStreamingTurn` — the **other** live owner. Renders the current turn directly from `runtime.semantic.currentTurn` (the semantic reducer), not from ghosts. Mounted by `Feed.tsx:912-916` whenever `runtime.semantic.currentTurn !== null`. |
| `src/providers/claude/runtime/claudeSession.ts` | Sidecar opt-in (`getSessionModel`), and the committed `tool_result` bridge with its 250 ms quiet-window gate (`readyForLiveBridge`). The bridge is unrelated to ghost rendering — it deals with bootstrap-replay tool_result spam. |
| `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` | The proxy-side sidecar predicate (`isSidecarFlow`) that demotes title-gen / branch-name / compaction calls to `attribution: 'secondary'` so they don't open a turn at all. Catches some sidecar leaks but not all (predict-next-prompt slips through). |

## 4. The lifecycle wired through cc-shell

Per session, the dance is:

1. **Mint.** Proxy emits `turn_started` → `text_delta` (etc.). The
   semantic reducer (`foldSemanticEvent`) updates
   `runtime.semantic.currentTurn`. `useIpcSubscriptions.ts:711-715`
   calls `ghostsFromSemanticTurn(currentTurn, sessionId, current.ghosts)`.
   That returns the previous map unchanged for no-op events
   (reference-stable, see `ghosts.ts:235-242`) or a new map with one
   `createGhost` / `updateGhost` per affected block.

2. **Persist.** `ghostsToPersist(prev, next)` returns the entries whose
   `updatedAt` changed (or are new). Each is sent over IPC via
   `window.api.ghostAppend(sessionId, ghost)`. Main batches at 100 ms.
   This happens both on the semantic ingest path (line ~723) and on the
   JSONL ingest path (line ~1133, capturing supersede records).

3. **Reconcile.** When JSONL entries land via `onSessionJsonlEntries`,
   `reconcileUpstream(entry, ghosts)` walks the ghost map and
   supersedes any whose:
   - `turnId === entry.message.id` (Claude rule)
   - OR `turnId === entry.codexTurnId` (Codex rule, after
     `stampCodexTurnId` ran in the rollout mapper)
   - OR `_atp.context.toolUseId` / `context.callId` matches a
     `tool_use` block id in the entry (provider-shared fallback)

4. **Orphan.** `useIpcSubscriptions.ts:210-241` runs `orphanStale` every
   1 s. Any unsuperseded ghost whose `updatedAt + GHOST_ORPHAN_TTL_MS <
   now` gets `orphanedAt` set. `GHOST_ORPHAN_TTL_MS = 3000` currently.

5. **GC.** `gcSupersededGhosts` evicts entries that have been
   superseded for `gcMs` to keep the map bounded. Called from the same
   periodic tick.

6. **Resume.** On `spawnSession` (`session.ts:212-266`), after a 0-tick
   defer, read `<userData>/ghost-logs/<sessionId>.ghost.jsonl`, fold via
   `reduceGhostLogSansSuperseded` (drops anything already superseded on
   disk), merge into `runtime.ghosts` (skipping uuids the live session
   already produced), and re-run `reconcileUpstream` against
   `current.entries` (which by now contains the JSONL tail loaded by
   `loadInitialHistoryForSession`). Persist any newly-produced supersede
   records.

This whole dance is well-engineered and works. The problem is it ends
in step 7 — render — that no longer happens.

## 5. Reference-stability invariants that keep the system fast

Comments throughout `ghosts.ts`, `useIpcSubscriptions.ts`, and the atp
package make a load-bearing claim: each reducer returns `prev` unchanged
on no-op so React memoization holds. Quote from
`ghosts.ts:235-242`:

> WHY lazy clone: this runs on every semantic reducer tick, including
> no-op ticks (usage_updated, redundant block_started). The pre-fix
> version always allocated `new Map(prev)` at the top, which made
> `nextGhosts !== current.ghosts` always true downstream, forcing a
> setRuntimes cascade that busted every useMemo([entries]) in Feed via
> selectMergedEntries.

Same pattern in `reconcileUpstream` (line ~352-359), `orphanStale`
(line ~451), and `foldSemanticEvent` itself (no-op short-circuit at the
end, ~lines 798-820).

Implication for our fix: the new predicate must keep this contract.
Specifically, `selectMergedEntries` should return `runtime.entries` by
identity when no ghost survives the predicate, NOT a fresh
`[...entries]`. The pre-fix `mergeWithUpstream` returned a fresh array
even when `trailing` was empty, busting Feed memos.

## 6. The dual-owner problem (the architectural rot)

`Feed.tsx:912-916` mounts `SemanticStreamingTurn` whenever
`runtime.semantic.currentTurn !== null`. That component renders blocks
from `currentTurn.blocks` directly — not from ghosts.

So during a normal turn:
- semantic events arrive → `currentTurn` updates → `SemanticStreamingTurn`
  re-renders with fresh block content.
- *In parallel*, the same events mint/update ghost entries.
- JSONL lands → `currentTurn` closes (`turn_completed` →
  `currentTurn = null` if no pending tool_result), `SemanticStreamingTurn`
  unmounts, JSONL row takes over.
- *In parallel*, `reconcileUpstream` supersedes the ghost.

Two systems doing the same job in parallel. The ghost system was
supposed to *replace* `SemanticStreamingTurn` — that's the literal
content of "Phase 3" referenced everywhere in the comments. From
`mergedEntries.ts:71-92`:

> Phase 3 of the original headless redesign will delete
> SemanticStreamingTurn entirely and render everything through ghosts +
> the merged feed. Until then, single-ownership in the main feed is the
> surgical fix.

That deletion never happened. `SemanticStreamingTurn` is fine and
serves the live render need correctly. So ghost-as-render became
redundant — except for one residual case where ghost is the only
thing that knows: **when JSONL has stopped writing past the proxy.**

## 7. Comment drift to be aware of

The codebase has multiple WHY comments that describe ghost as the
canonical live render path. They're all from the period when Phase 3
was actively planned. Examples:

- `ghosts.ts:1-40` block comment: "The fix is a transcript-first feed
  with a ghost overlay." — describes the design intent that wasn't
  finished.
- `Feed.tsx:170-180`: "duplicate class is now prevented at its source"
  via the ghost reducer. Half-true: ghost reconciliation is doing work,
  but the duplicate-render avoidance currently relies on
  `SemanticStreamingTurn` being the sole owner of the live turn AND
  ghosts being hidden in the main feed.
- `mergedEntries.ts` various: described as a wrapper around
  `mergeWithUpstream`. Currently it isn't — it returns `entries`.
- `mergedEntries.ts:71-92`: describes the "Phase 3 delete" plan as if
  it's the next item on the queue. It hasn't moved in months.
- `TileLeaf.tsx:339-369`: call-site comments still say "earlier turns'
  orphaned or still-unreconciled ghosts fall through" — they don't.

These don't lie about facts that ARE in the code (the ghost reducer is
real, `mergeWithUpstream` does what it says) but they overstate what
the *render path* currently does. Future reader trying to understand
why a ghost isn't showing will be misled.

## 8. The fix history (every previous attempt)

### `10e4fc5` (2026-04-20) — "hide non-current ghosts from the main transcript"

Origin: session `69e61aa3-38af-428c-9f31-a614a6c4c4a7` showed
`entry:g-019dab01-...` (older ghost answer) rendering BELOW
`semantic:019dab02-...` (newer turn). atp's tail-append put a stale
old-turn ghost below newer committed rows.

Fix: filter all non-current-turn ghosts out of the merge. Render the
current turn via `SemanticStreamingTurn`. Result: stale-bottom-row bug
gone, but no orphan rendering at all.

Quote from the commit message:

> This is an immediate UI sanity fix, not the final architecture. It
> stops the transcript from inverting conversational order.

### `686b94e` (2026-04-24) — "render orphaned ghost fallback entries"

Came back to add the orphan-fallback story: orphaned ghosts (TTL
fired) ARE the only record of what proxy saw for that turn, so render
them. Code added the orphan-only filter and re-enabled
`mergeWithUpstream` for those.

Failure mode: didn't distinguish the two reasons a ghost orphans.
Sidecar leaks (title-gen, predict-next-prompt) orphan because Claude
Code never logs them to JSONL — same TTL signal as a stuck-mid-turn
case. Result: 7+ short fragments parked permanently at the bottom of
sessions.

### `2a83978` (2026-05-07) — "suppress orphan ghosts with title-gen / predict-next-prompt shape"

Symptom fix on top of `686b94e`. Added a renderer-side shape filter:
orphan ghost is suppressed if it's an assistant message with a single
text block ≤ 200 chars. Rationale from the commit message:

> Forensic confirmation from debug bundle 2026-05-07T08-26-35-212-5d948ab5:
> 7 orphan ghosts visible at the bottom of the feed, none of 23 flows
> demoted, all sidecar turns 12-41 chars and 188-602ms — well below any
> real assistant turn (≥76 chars, ≥808ms in the same bundle).

Failure mode: the 200-char cap is empirical against ONE bundle. A
sidecar variant that produces longer text (predict-next-prompt with
fuller context) defeats it. Genuine short assistant turns ("Done.",
"OK") would also be suppressed, accepted as a trade-off. Tool_use
ghosts not covered at all.

### Current branch `fix/hide-orphan-ghost-tail` (2026-05-07, this session)

User saw orphan ghosts from May 2026 sessions still leaking through
the shape filter. Initial branch went the conservative route again:
hide ALL ghosts from the main feed. Same as `10e4fc5`'s shape but
permanent.

This is what the branch currently does. It works (no stale rows) but
also kills the legitimate stuck-mid-turn case. After the user
hammered on this, we landed on the fix described in §10.

## 9. Why all four attempts had the same shape

Each attempt asked: "is this ghost stale enough to render?" The TTL
fires identically for:

- (a) JSONL is healthy and writing other turns, but this *specific*
  proxy event was a sidecar Claude Code never writes (title-gen,
  predict-next-prompt, branch-name gen, compaction summary, hook
  agent).
- (b) JSONL has actually stopped writing for this session entirely,
  while proxy is still emitting events for an in-flight turn.

A TTL-based predicate cannot distinguish these. (a) is the dominant
population in production bundles; (b) is rare but is the only case
ghost rendering should fire on. Tail-appending (a) produces the bug we
keep re-introducing.

The proxy-side `isSidecarFlow` predicate
(`ClaudeProxyAdapter.ts:1542-1610`) catches most of (a) at source.
It demotes flows when:
- the flow's model matches `/haiku/i` AND the session model doesn't, OR
- compound budget signal: `max_tokens ≤ 1024 AND messageCount ≤ 3`, OR
- system-prompt prefix matches one of `SIDECAR_SYSTEM_PROMPT_PREFIXES`
  (4 entries, English literal prefixes)

What it misses, per the `2a83978` commit message:

> The body-shape predicate misses the predict-next-prompt feature
> because those calls include the full conversation history
> (messageCount > 3 so the compound budget signal fails) and use a
> system prompt not in the 4-entry SIDECAR_SYSTEM_PROMPT_PREFIXES list.

So even with the proxy-side filter doing its job for the catchable
cases, some sidecar leaks reach the renderer. The renderer-side fix
must handle them.

## 10. The actual edge case ghost was built for

User's framing, restated:

> when we get in that weird stale state where like 50 seconds goes by a
> restart and claude and codex stops writing to the jsonl before the
> WHOLE turn is finished, the 100 milliseconds is just nothing? in that
> case we just use the semantic channel until the jsonl channel
> replaces it. BUT if we see that the semantic channel is growing with
> no updates in jsonl that is the race case ghosts where meant to solve

That's exactly right. The signal we want is per-session, not per-ghost:
*has JSONL gone silent while proxy is still alive (or has it stopped
permanently as of this resume)?*

The cleanest implementation of that signal is to compare against
**the newest JSONL entry timestamp this session has observed**. Then a
ghost is render-eligible iff its `_atp.updatedAt` is strictly newer
than that timestamp.

Walking the cases:

| Scenario | `lastJsonlEntryAt` | ghost `updatedAt` | predicate | correct? |
|---|---|---|---|---|
| Normal turn streaming, JSONL 100 ms behind | t-0.1 | t-0 | hidden (orphan TTL hasn't fired) | ✓ — `SemanticStreamingTurn` renders |
| Normal turn done, JSONL caught up | t | t (then superseded) | hidden (superseded) | ✓ |
| Sidecar leak (title-gen) at t=5, JSONL kept writing other turns to t=100 | t=100 | t=5 | hidden | ✓ |
| JSONL stopped at t=22, proxy still emitting, ghost `updatedAt=27` | t=22 | t=27 | rendered | ✓ — this is the case ghost was built for |
| Resumed after crash; JSONL tail loaded ends at t=22; ghost log has t=27 ghost reconciled to no-match | t=22 | t=27 | rendered | ✓ — the partial-turn-from-previous-run is recovered |
| Resumed; old sidecar at t=50 in ghost log, JSONL has entries up to t=100 | t=100 | t=50 | hidden | ✓ |

The predicate works for both live operation and resume because both
sides are **wall-clock-when-the-event-was-observed**, comparable.

## 11. The implementation plan

### 11.1. Data model

Add to `SessionRuntime` in
`src/renderer/src/workspace/workspaceState.ts` (next to `ghosts`):

```ts
/** Wall-clock ms of the newest JSONL entry's `timestamp` field we
 *  have observed for this session. Compared against ghost
 *  `_atp.updatedAt` in `selectMergedEntries`: when a ghost's update
 *  is strictly newer than this value AND the ghost is orphaned,
 *  JSONL has stalled past the proxy and the ghost is the only record
 *  of what happened — render it. When the ghost is older than this
 *  value, JSONL kept writing past it (sidecar leak that Claude Code
 *  was never going to log) — hide it. Null until any JSONL entry
 *  has been observed. Reset to null on session removal. */
lastJsonlEntryAt: number | null
```

Initialize `null` in `emptyRuntime()`.

### 11.2. Stamp from live JSONL ingest

In `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`,
inside the `onSessionJsonlEntries` setRuntimes block (~line 1170 area
where the runtime patch is built), walk `appended` and update the
field:

```ts
let lastJsonlEntryAt = current.lastJsonlEntryAt
for (const entry of appended) {
  const ts = (entry as { timestamp?: unknown }).timestamp
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    if (Number.isFinite(ms) && (lastJsonlEntryAt === null || ms > lastJsonlEntryAt)) {
      lastJsonlEntryAt = ms
    }
  }
}
```

Add `lastJsonlEntryAt` to the runtime spread (line ~1175). Use
`entry.timestamp` (ISO string, present on both Claude entries and
Codex-mapped entries) NOT `Date.now()` so the comparison is
apples-to-apples with ghost `_atp.updatedAt`.

NEEDS VERIFICATION: confirm that mapped Codex entries via
`mapCodexRolloutToFeedEntries` consistently set `timestamp`. Looking
at `src/renderer/src/workspace/codex/rollout.ts`,
`codexConversationEntryFromMessageItem` accepts `timestamp` as
parameter and writes it into the entry. Source value comes from the
rollout entry's outer `timestamp` field (Codex JSONL has it on every
line). Should be consistently populated. Same path for tool_use /
tool_result mapped entries. **Validator: grep
`src/renderer/src/workspace/codex/rollout.ts` and confirm every emit
path threads `timestamp` through.**

### 11.3. Stamp from initial-history load

`src/renderer/src/workspace/hook/actions/initialHistory.ts` (~line 193
where `entries:` is set):

```ts
let lastJsonlEntryAt = current.lastJsonlEntryAt
for (const entry of initialEntries) {
  const ts = (entry as { timestamp?: unknown }).timestamp
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    if (Number.isFinite(ms) && (lastJsonlEntryAt === null || ms > lastJsonlEntryAt)) {
      lastJsonlEntryAt = ms
    }
  }
}
```

`history.ts` (older-history pagination, line ~178): does NOT touch
this field. Prepended entries are by construction older than entries
already in `runtime.entries`.

### 11.4. The new `selectMergedEntries`

`src/renderer/src/workspace/mergedEntries.ts` — replace the body:

```ts
import type { Entry } from '@shared/types/transcript'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import type { GhostEntry } from 'agent-transcript-parser/ghost'
import { mergeWithUpstream } from 'agent-transcript-parser/ghost'

/**
 * Decide which (if any) ghost entries get merged into the rendered
 * feed. The ghost system mints provisional records for every semantic
 * event. Most of those never need to render: the live current turn is
 * owned by `SemanticStreamingTurn` directly off the semantic channel,
 * and JSONL catches up within ~100 ms via `reconcileUpstream`, which
 * supersedes the ghost.
 *
 * The one case ghost rendering exists for is JSONL stalling past the
 * proxy. Two situations produce that:
 *   1. Live: agent process gets wedged, JSONL stops writing while
 *      proxy keeps emitting events for the in-flight turn.
 *   2. Resume after crash: ghost log on disk has events past the
 *      newest JSONL entry; JSONL never caught up before the previous
 *      run died.
 *
 * Both are detected by the same predicate: a ghost is render-eligible
 * iff its `_atp.updatedAt` is strictly newer than the newest JSONL
 * entry timestamp we have observed for this session
 * (`runtime.lastJsonlEntryAt`). Sidecar leaks (Claude Code routing
 * title-gen / predict-next-prompt / branch-name gen calls through
 * /v1/messages without writing to the rollout) fail this check by
 * construction, because JSONL kept writing real turns past them.
 *
 * Full rule:
 *   1. Skip if superseded.
 *   2. Skip if not yet orphaned — JSONL might still arrive within TTL.
 *   3. Skip if `turnId === currentTurnId` — `SemanticStreamingTurn`
 *      owns the live turn render. Surfacing a ghost for the same turn
 *      would double-render.
 *   4. Skip if `_atp.updatedAt <= lastJsonlEntryAt` — JSONL has
 *      written past this point, so the ghost is either already
 *      reconciled or a sidecar leak.
 *
 * Surviving ghosts are tail-appended via atp's `mergeWithUpstream`
 * with `trustSupersededFlag: true`. Tail-append is correct here
 * because by predicate-3 these ghosts are NOT for the active turn,
 * and by predicate-4 they are newer than every committed entry —
 * so they belong at the very end chronologically.
 *
 * Reference stability: when no ghost survives the predicate, return
 * `runtime.entries` by identity (NOT a fresh array). Feed's row
 * memos rely on entries-array identity to skip re-renders;
 * `[...entries]` would bust them on every tick.
 */
export function selectMergedEntries(
  runtime: SessionRuntime,
  currentTurnId: string | null,
): Entry[] {
  const { ghosts, entries, lastJsonlEntryAt } = runtime
  if (ghosts.size === 0) return entries

  const visible = new Map<string, GhostEntry>()
  for (const [uuid, ghost] of ghosts) {
    if (ghost._atp.supersededBy !== undefined) continue
    if (ghost._atp.orphanedAt === undefined) continue
    if (currentTurnId !== null && ghost._atp.turnId === currentTurnId) continue
    if (lastJsonlEntryAt !== null && ghost._atp.updatedAt <= lastJsonlEntryAt) continue
    visible.set(uuid, ghost)
  }
  if (visible.size === 0) return entries

  return mergeWithUpstream(entries, visible, {
    trustSupersededFlag: true,
  }) as Entry[]
}

export function shouldShowSemanticStreaming(runtime: SessionRuntime): boolean {
  return runtime.semantic.currentTurn !== null
}
```

The 200-char sidecar shape filter from `2a83978` is **deleted**. The
new predicate replaces it correctly: a sidecar's `updatedAt` is by
construction older than the next real-turn JSONL entry, so rule 4
catches it. The shape filter was a heuristic; the new rule is structural.

### 11.5. Bump the orphan TTL

`useIpcSubscriptions.ts:97`:

```ts
const GHOST_ORPHAN_TTL_MS = 30000   // was 3000
```

3 s was set when `686b94e` wanted aggressive fallback rendering. Now
that orphan-ness gates rendering AND we have an additional newer-than-
JSONL check, 3 s is too aggressive — a slow Read of a 5000-line file
can take a few seconds during which the proxy emits no new events,
which would currently flip the ghost to orphaned mid-turn. 30 s
matches atp's library default and safely covers all known
slow-tool_result cases without prematurely qualifying a ghost.

Leave `GHOST_ORPHAN_SWEEP_MS = 1000` alone — that's the polling rate.
The 1 s sweep is what drives the visibility flip when JSONL goes
silent live: the orphan flag flips → setRuntimes fires → re-render →
predicate re-evaluates → ghost appears.

### 11.6. Comment cleanup

Update these block comments to match reality. Each rewrite is small.

- `mergedEntries.ts` file-level comment: replace the "thin wrapper
  around `mergeWithUpstream`" / "Phase 3 will delete
  `SemanticStreamingTurn`" framing with: ghost rendering is reserved
  for the JSONL-stalled-past-proxy case; otherwise the live turn is
  owned by `SemanticStreamingTurn` and JSONL owns committed history.
- `ghosts.ts:1-40` block comment: rewrite. New framing: "Ghost is a
  parallel disk-backed ledger of semantic events. Used for (a)
  reconciliation against JSONL (live duplicate-render avoidance), (b)
  the JSONL-stalled-past-proxy case where ghost is the only record of
  what happened — see `selectMergedEntries`. Most ticks the ghost map
  has no rendered output; the persistence and reconciliation work
  goes on in the background."
- `TileLeaf.tsx:333-369` call-site comments: tighten to the new
  rule. Drop the "earlier turns' orphaned or still-unreconciled
  ghosts fall through" claim — they don't unless predicate 4 is
  satisfied.
- `Feed.tsx:170-180`, `:670-676`, `:945-950`: leave alone. They
  describe `SemanticStreamingTurn` ownership accurately.
- `mergedEntries.ts` `shouldShowSemanticStreaming` doc-comment: trim.
  The body is one line; the docstring doesn't need to be 20.

DO NOT touch:
- atp ghost primitives (`packages/agent-transcript-parser/`)
- `ghostJournal.ts`, IPC, preload — persistence layer is fine.
- `reconcileUpstream`, `orphanStale`, `gcSupersededGhosts`,
  `ghostsFromSemanticTurn`, `ghostsToPersist`.
- `claudeSession.ts` committed-tool_result bridge — different problem.
- `ClaudeProxyAdapter.isSidecarFlow` and friends — keep proxy-side
  filtering. Catching sidecars at the proxy is still preferred when
  possible; the renderer predicate is the safety net.

### 11.7. Test update

`scripts/test-ghost-fallback.ts` already exists and is wired to the
`test:ghost-fallback` script in `package.json`. **Do not add new test
files** (per project memory `feedback_no_test_bloat.md`). Modify the
existing one.

Replace the current "all ghosts hidden" assertions with the four-rule
matrix:

```ts
// 1. orphaned + updatedAt > lastJsonlEntryAt + no current turn → render
// 2. orphaned + updatedAt < lastJsonlEntryAt → hide (sidecar/catchup case)
// 3. orphaned + turnId === currentTurnId → hide (live owner is SemanticStreamingTurn)
// 4. not orphaned → hide (handoff window, JSONL might still land)
// 5. superseded → hide
```

The existing helper `emptyRuntime()` will pick up the new
`lastJsonlEntryAt: null` automatically. Tests set it via direct field
assignment on the test runtime, same pattern as `runtime.entries =`
in the current test.

### 11.8. Branch hygiene

Current branch `fix/hide-orphan-ghost-tail` describes the wrong
behavior now. Rename to something like
`fix/render-ghost-when-jsonl-stalls` or
`fix/ghost-rendering-predicate`. Force-push fine — branch isn't
shared upstream (gh remote is on `Juliusolsson05`, see
`reference_gh_account.md`). The current single commit on this branch
will be replaced by a more accurate commit message.

Per project memory `feedback_worktree_default.md`, branch work goes
in `.worktrees/<name>` with main checkout staying on main. Verify
this branch is in a worktree before continuing.

## 12. Open questions / things to verify before committing

1. **Codex `entry.timestamp` coverage.** Verify every emit path in
   `src/renderer/src/workspace/codex/rollout.ts` populates
   `timestamp`. If any path drops it, `lastJsonlEntryAt` won't
   advance for those bursts and orphan ghosts could erroneously
   render. Mitigation if found: fall back to `Date.now()` when the
   entry has no timestamp (less semantic but doesn't break the
   predicate).

2. **Compact-boundary entries.** These have a `uuid` but may not
   carry `timestamp`. They're not conversation entries and shouldn't
   reset the JSONL clock, but they currently flow through
   `appended`. Test: confirm parse failure on missing/non-string
   timestamp degrades to "no update" not "set to NaN."

3. **First-turn fresh session.** No JSONL has been received yet
   (`lastJsonlEntryAt === null`). A ghost minted from the very first
   semantic event has `updatedAt > null` (treats null as 0), so
   predicate 4 passes. Predicate 3 (`turnId === currentTurnId`) hides
   it because `currentTurn` is open. ✓ — but ASSUMPTION: the
   semantic reducer always opens `currentTurn` BEFORE the first
   ghost is minted. Verify by tracing `foldSemanticEvent` for
   `turn_started` (opens currentTurn) vs the first `text_delta` /
   `block_started` (which is what mints the first ghost). Looking at
   `foldEvent.ts:111-172`, `turn_started` runs before any block
   events; `useIpcSubscriptions.ts:711-715` runs `ghostsFromSemanticTurn`
   AFTER `foldSemanticEvent` AFTER the new event has updated state.
   ✓ ordering is fine.

4. **`turn_completed` / `turn_stopped` race.** When the semantic
   reducer closes `currentTurn` (sets it to null) but the JSONL
   entry hasn't landed yet — a window of ~100 ms where:
   - predicate 1 ✗ (not yet superseded)
   - predicate 2: depends on TTL — orphan_TTL=30s, so the ghost is
     not orphaned yet at this moment. Predicate 2 hides it.
   - predicate 3: passes (currentTurn=null, no match)
   - predicate 4: passes (updatedAt > lastJsonlEntryAt by definition,
     since the proxy emitted past the last JSONL entry)

   Predicate 2 is what saves us. The TTL must be long enough that
   normal `turn_completed → JSONL lands` never crosses it. 30 s is
   plenty (turn_completed → JSONL is bounded by Claude Code's 100 ms
   batch; Codex by its mpsc flush, both well under 30 s in healthy
   operation).

5. **What if Claude Code's JSONL writer is healthy but lags by 5+
   seconds?** Pathological case: a really big tool_result floods
   the queue, batched write delays, ghost gets to TTL=30s, predicates
   1-3 pass, predicate 4 passes (last JSONL was the user message
   from a minute ago). Ghost renders. Then JSONL lands, supersedes,
   ghost disappears. User sees a brief flicker. **Probability low,
   visible glitch minor, acceptable.** If this becomes a problem,
   tune TTL upward.

6. **Resume + ghost log fully empty.** Edge case where the previous
   session crashed before any ghost was persisted but JSONL has
   partial state. Nothing to render. Predicate trivially passes for
   no ghosts. ✓ — but worth a sanity test.

7. **`gcSupersededGhosts` interaction.** Superseded ghosts get
   evicted after `gcMs`. After eviction, predicate 1 has nothing to
   match (the ghost is gone). Doesn't affect rendering — the ghost
   was already hidden. ✓

8. **Multiple sessions, one stuck.** `lastJsonlEntryAt` is
   per-session; one stuck session does not affect another's
   predicate. ✓

9. **`bootstrapping` flag.** Feed suspends auto-scroll while
   `bootstrapping=true`. Ghost rendering during bootstrap could
   cause a small jump when the orphan flips to visible. Probably
   fine because the orphan TTL (30 s) is much longer than the
   bootstrap quiet window (150 ms).

## 13. File-and-line cheat sheet

For the next agent. All paths are absolute under
`/Users/juliusolsson/Desktop/Development/cc-shell/`.

| Concern | File | Line |
|---|---|---|
| `SessionRuntime` shape | `src/renderer/src/workspace/workspaceState.ts` | 248-394 |
| `emptyRuntime()` | `src/renderer/src/workspace/workspaceState.ts` | 425-481 |
| `ghosts` field doc | `src/renderer/src/workspace/workspaceState.ts` | 379-393 |
| `ghostsFromSemanticTurn` | `src/renderer/src/workspace/ghosts.ts` | 230-287 |
| `reconcileUpstream` | `src/renderer/src/workspace/ghosts.ts` | 348-428 |
| `orphanStale` | `src/renderer/src/workspace/ghosts.ts` | 447-462 |
| `gcSupersededGhosts` | `src/renderer/src/workspace/ghosts.ts` | 478-493 |
| `ghostsToPersist` | `src/renderer/src/workspace/ghosts.ts` | 513-528 |
| Live JSONL ingest (`onSessionJsonlEntries`) | `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | 846-1232 |
| Ghost reconcile call | `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | 1111-1135 |
| Runtime patch (entries:) | `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | 1170-1210 |
| Orphan sweep | `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | 210-241 |
| TTL constant | `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | 97 |
| Ghost mint on semantic tick | `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | 695-725 |
| Initial history load | `src/renderer/src/workspace/hook/actions/initialHistory.ts` | 102-200 |
| Older-history pagination | `src/renderer/src/workspace/hook/actions/history.ts` | 170-200 |
| Resume ghost bootstrap | `src/renderer/src/workspace/hook/actions/session.ts` | 199-266 |
| `selectMergedEntries` (current) | `src/renderer/src/workspace/mergedEntries.ts` | full file |
| `TileLeaf` call-site | `src/renderer/src/workspace/tile-tree/TileLeaf.tsx` | 333-379 |
| `SemanticStreamingTurn` mount | `src/renderer/src/features/feed/ui/Feed.tsx` | 912-916 |
| `SemanticStreamingTurn` impl | `src/renderer/src/features/feed/ui/semantic/StreamingTurn.tsx` | full file |
| Semantic reducer | `src/renderer/src/workspace/semantic/foldEvent.ts` | full file |
| `currentTurn` lifecycle | `src/renderer/src/workspace/semantic/foldEvent.ts` | 111-172, 707-731 |
| Codex rollout mapper | `src/renderer/src/workspace/codex/rollout.ts` | full file |
| `stampCodexTurnId` | `src/renderer/src/workspace/codex/rollout.ts` | 198-201 |
| Claude proxy session | `src/providers/claude/runtime/claudeSession.ts` | full file |
| Committed tool_result bridge | `src/providers/claude/runtime/claudeSession.ts` | 378-459 |
| Sidecar opt-in (getSessionModel) | `src/providers/claude/runtime/claudeSession.ts` | 257-292 |
| Ghost journal writer | `src/main/ghostJournal.ts` | full file |
| Ghost IPC handlers | `src/main/ipc/ghost.ts` | full file |
| Ghost preload bridge | `src/preload/api/ghost.ts` | full file |
| atp ghost primitives | `packages/agent-transcript-parser/src/ghost.ts` | full file |
| atp ghost types | `packages/agent-transcript-parser/src/types.ts` | 38-105 |
| atp `mergeWithUpstream` | `packages/agent-transcript-parser/src/ghost.ts` | 410-451 |
| atp `MergeOptions` | `packages/agent-transcript-parser/src/ghost.ts` | 354-381 |
| Sidecar predicate | `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` | 1542-1610 |
| Sidecar prefix list | `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` | 385-390 |
| `MAX_TOKENS_SIDECAR_THRESHOLD` | `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` | 410 |
| `AUXILIARY_MESSAGE_COUNT_THRESHOLD` | `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` | 429 |

## 14. Alternative approaches we considered and rejected

### Option A — rip the ghost system out

Delete `ghosts.ts`, `ghostJournal.ts`, IPC, preload, the field on
`SessionRuntime`, the orphan sweep, the bootstrap merge, the
reconcile-on-ingest. Net ~500 lines deleted.

Rejected because:
- Closes the door on Phase 3 cleanly handling the
  JSONL-stalled-past-proxy case. The user cared about that case.
- Loses the disk-backed forensic record that debug bundles benefit
  from.
- The work needed to bring it back would be larger than the work to
  fix the predicate.

### Option B — keep plumbing, gate behind debug flag

Same renderer behavior as today (ghosts hidden) but only mint /
persist when feed-debug is open or `CC_SHELL_GHOST_DEBUG=1` is set.

Rejected because:
- Doesn't actually fix the bug (the user-visible regression on stuck
  mid-turn cases). Just makes the system smaller.
- Adds a runtime mode bit. More state to reason about.

### Option C — Phase 3 (delete `SemanticStreamingTurn`, render via ordered ghost insertion)

The original architectural plan. Add ordered insertion to atp
`mergeWithUpstream` (anchor by `parentUuid` / `turnId` / nearest
committed neighbor). Delete `SemanticStreamingTurn`. Render the live
turn entirely through the merged feed.

Rejected as the immediate fix because:
- It's a project, not a cleanup. Several days of work in atp + cc-shell.
- Ordered insertion has its own correctness traps (parent uuid chains
  break on resume; turn_id ordering depends on rollout invariants
  that vary between providers).
- Doesn't deliver new user value, only refactor value.
- Future Phase 3 still benefits from the smaller predicate landing
  first as a stepping stone.

### Option D — chosen — predicate fix in `selectMergedEntries`

Smallest viable fix. Captures the exact case ghost was built for.
Sidecar leaks structurally excluded by the timestamp comparison.
Few hundred lines, mostly comments. See §11.

## 15. What is NOT being changed

For the next agent's benefit, things that LOOK related but are out
of scope:

- The proxy-side sidecar predicate (`ClaudeProxyAdapter.isSidecarFlow`).
  Catches the catchable cases at source. Keep it. Extending the
  prefix list and budget thresholds is independent work; this fix
  doesn't depend on it.
- The committed `tool_result` bridge in `claudeSession.ts`. Solves
  bootstrap-replay tool_result spam. Unrelated to ghost rendering.
- The orphan sweep cadence (`GHOST_ORPHAN_SWEEP_MS = 1000`).
  Polling rate; the threshold is `GHOST_ORPHAN_TTL_MS`.
- atp's library code. The primitives are correct as-is. We don't
  need a new merge option or a new lifecycle state.
- `gcSupersededGhosts`. Memory hygiene; doesn't affect rendering.
- The bootstrap quiet-window flag (`bootstrapping`) and its 150 ms
  debounce. Unrelated; affects auto-scroll, not ghost visibility.
- The work indicator stream phase (`streamPhase`). Shows "agent is
  thinking / using a tool"; not coupled to ghost.

## 16. Useful evidence locations

For verifying behavior against real bundles:

- `~/.config/cc-shell/feed-debug/<sessionId>.jsonl` — per-session
  append-only feed-debug log. Contains layered entries:
  - `layer: SEM` — semantic events
  - `layer: JSONL` — JSONL ingest bursts
  - `layer: STATE` — bootstrap_complete, ghost_orphan_sweep,
    conditions, etc.
  - `layer: RENDER` — Feed's visible-row reconciliation
- `~/Library/Application Support/cc-shell/ghost-logs/<sessionId>.ghost.jsonl` —
  the ghost log itself. Each line is a `GhostEntry` snapshot.
- `~/.config/cc-shell/debug-bundles/` — autosaved bundles with
  cross-cut state (runtime summary, semantic log slice, feed-debug
  slice, ghost map size, conditions).

The session referenced in `10e4fc5` is
`69e61aa3-38af-428c-9f31-a614a6c4c4a7`. The session referenced in
`2a83978` is bundle `2026-05-07T08-26-35-212-5d948ab5`.

## 17. What ghost is NOT (corrections to earlier framings in this thread)

- **Not crash recovery.** Earlier in the investigation I described
  ghost as "crash recovery." That was wishful — the on-disk ghost
  log only contributes to user-visible state if ghosts render, and
  they currently don't. The persistence is real but its only consumers
  today are the bootstrap merge (which feeds back into a hidden map)
  and debug bundle counters. Calling that "recovery" overstates it.
  The fix in §11 *makes* it crash recovery for the stuck-mid-turn case.
- **Not the live render path.** The semantic channel via
  `SemanticStreamingTurn` is. Ghost minting happens in parallel; nothing
  visible reads the ghost map during normal operation.
- **Not solving the 100 ms JSONL lag.** That's solved by
  `SemanticStreamingTurn` directly. Ghost is for the abnormal
  long-stall case.
- **Not "the merged feed."** That term shows up in old comments. The
  current feed is committed-entries-only, with `SemanticStreamingTurn`
  appended for the live turn. After this fix, "merged" partially
  comes back, but only for orphans past JSONL.

## 18. Summary for the cross-reading agent

Cross-read priorities:

1. Verify §10's case table by walking each scenario mentally against
   the four-rule predicate in §11.4. Look for missed cases.
2. Verify §12 open questions, especially Codex `timestamp` coverage
   in `rollout.ts` and the `bootstrapping`/auto-scroll interaction.
3. Look for stale comments not enumerated in §7 — there are likely
   more across the workspaceStore, claudeSession, and Feed paths
   that drift from current behavior.
4. Sanity-check the §11.5 TTL bump (3000 → 30000) against any other
   consumer of `GHOST_ORPHAN_TTL_MS`. Currently only the sweep uses
   it, but verify with a grep.
5. Confirm `entry.timestamp` is consistently ISO-8601-string for both
   providers. Specifically: Claude entries from
   `claudeHistoryMarker`, `extractEmbeddedClaudeProgressEntry`, and
   the live JSONL tail; Codex entries from
   `mapCodexRolloutToFeedEntries` and its synthetic
   compact-boundary / compact-summary helpers.
6. Confirm renaming `fix/hide-orphan-ghost-tail` to a more accurate
   branch name does not orphan any open PR or in-flight comment.
7. Run `npm run test:ghost-fallback` after the change. The test must
   still pass; if it doesn't, the predicate or test update is wrong.
8. Run `npm run build` after the change. TypeScript will catch any
   field-shape mismatch on `SessionRuntime`.

If §11 holds up, hand it back to the user for execution.
