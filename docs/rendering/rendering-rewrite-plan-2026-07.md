# Rendering Rewrite — The Plan (2026-07-06)

Status: **the canonical plan.** Supersedes `rendering-rewrite-practical-plan.md`
(2026-05-22), `docs/superpowers/plans/2026-05-22-rendering-tdd-rewrite.md` (the
8-phase original), and the planning threads in #172. The knowledge dump
(`rendering-knowledge-dump.md`) remains the evidence bible; the
`research-2026-07/` directory holds the four extraction reports this plan was
synthesized from (GitHub archaeology, historical plans, rewrite-notebook digest,
code drift report). Where any older document disagrees with this one, this one
wins; where this one is silent, the dump's Non-Negotiable Rules apply.

Read this first. Then read `research-2026-07/` for the receipts.

## Stage 1 progress (updated 2026-07-06, integration branch)

Landed (slices 1-11, PRs #424-#437 into `integration/rendering-pipeline`):
ledger core (types / ordering law / ownership / identity stability), committed
collector with the #338 synthetic-user filter, ghost five-rule predicate with
the 10-case matrix and failed-fix regressions, semantic collector with the
#345 compaction kill, local collectors + optimistic→committed handoff,
unknown-behavior registry with structural redaction, ghost plane wired into
the ledger pass (#435), the runtime→collector adapter — the shadow seam —
with ghost collector, optimistic partition, plane-level reference stability,
and compile-time seam assertions against real runtime types (#436), the
fold-policy yield-hatch absorption (`policy/foldPolicy.ts` — the two
proxy-literal hatches from legacy foldEvent encoded as policy data with
parity tests) and six end-to-end fixtures: buried-prompt-239,
dead-committed-channel-159, opencode-interleave-87f0eeef, the ghost matrix,
sidecar-tail-ghost, and queue-handoff-race (#437). Suite: 67 pipeline tests.

**Stage 1 is COMPLETE.** Next: Stage 2 shadow wiring — call the adapter +
ledger beside the legacy renderer behind `AGENT_CODE_RENDER_SHADOW=1`, diff
outputs, divergences become fixtures. (Unknowns plumbing note: the registry
exists and `LedgerInput.unknowns` passes through; POPULATING it from real
IPC events is inherently a Stage 2 concern — unknowns are discovered at the
shadow seam, not in fixtures.)

---

## 0. Why this plan exists and what it refuses to be

We have fought feed rendering for months because the app runs **multiple
subsystems that each believe they own what is visible**: committed transcript
rows, a live semantic turn, archived semantic history, ghosts, optimistic
prompts, queued prompts, screen fallback, work state. Every incident in the
trail (#159, #168, #172, #191, #239, #241, #290, #338–#346) is one failure
shape: two owners claimed the same visible thing, or one suppressed another
before the replacement was visible, or an artifact was present-but-buried by
accidental JSX plane order.

Three generations of plans already exist. The first (2026-05-22 TDD plan) was
right about everything and too ceremonial to execute — 8 phases of scaffolding.
The second (practical plan) cut the ceremony but predates three-provider
reality. This plan is the third and final generation: **three stages, each
answering one question**, with the test-and-fixture spine as the non-negotiable
core and everything ornamental cut.

The three questions:

1. **Does the new model encode everything we know?** (Stage 1 — build the real
   pipeline from scratch, spec-first, against the invariant catalog and
   bundle-derived fixtures.)
2. **Does it survive reality?** (Stage 2 — shadow mode beside the old renderer;
   every divergence becomes a fixture.)
3. **Ship it.** (Stage 3 — cutover behind a flag; delete legacy guards as their
   ledger tests land.)

What this plan refuses to be: a framework. No detector DSL, no XState, no
15-PR scaffolding runway, no directory tree pre-split into 12 provider×channel
folders, no phase whose deliverable is another phase.

---

## 1. The invariant and the owner model

> Every visible feed artifact has exactly one owner at a time. Every ownership
> transfer is explicit, evidence-based, and recorded. Every rejected candidate
> keeps its rejection reason. Debug output is a serialization of the same
> decisions React paints — never a second derivation.

Owners (the candidate kinds of the ledger):

| owner | paints | notes |
|---|---|---|
| `committed` | durable transcript rows | JSONL / rollout / opencode assembled messages |
| `semantic-current` | the one live streaming turn | strictly one per session |
| `semantic-history` | completed live turns bridging committed lag | bounded, temporary |
| `ghost-fallback` | orphan recovery rows | ONLY when committed stalls past live |
| `optimistic-submit` | local submitted prompt pre-commit | echo providers only (codex, opencode) |
| `queue` | pending future prompts | **a lane, not feed rows** (Decision D1) |
| `work` | phase-only activity | never text; can coexist with `empty` |
| `condition` | blocking provider overlays | never feed rows; separate outlet |
| `empty` | placeholder | only when no content owner exists |
| `unknown` | nothing | logged, counted, fixture-able; never silently a row |

There is **no universal transfer rule** ("latest wins", "committed always
wins", TTL). The historical record proves each one wrong (see
`research-2026-07/historical-plans-extraction.md`, failed-fix history). Every
transfer needs source evidence, and the evidence is recorded in the ledger.

---

## 2. The decisions (all of them, with receipts)

These were open questions across the three plan generations. They are now
closed. Each cites its evidence.

**D1 — Queue is a composer-adjacent lane, not feed rows.** Four independent
sources land here: the shipped reality (feed-ui-rendering, README), the
submit-queue state machine doc, and upstream Codex's own
`queued_user_messages`/`PendingInputPreview` model. feed-render-item-plan's
Step 4 (queue into items) was never shipped and is overruled. The REAL
invariant is the **handoff**: when the committed user row replaces a queued
prompt, it must not paint above stale semantic history (the documented
queue-handoff race, #172 comment 6). That handoff gets a permanent fixture.

**D2 — Ledger granularity is the BLOCK/UNIT, not the turn.** #256 shipped
turn-granular items; the ownership bugs are unit-granular (Codex commits one
response item at a time; committed tool-use must not hide live tool output;
#194's itemId suppression). feed-ui-rendering's `FeedRenderUnit` +
`suppressedUnits[]` proposal is adopted: candidates are per-block units with
identity `(turnId, blockIndex | itemId | toolUseId | callId)`, and turns are a
grouping, not the ownership atom. Claude's whole-turn suppression becomes a
provider *policy* that suppresses all units of a turn at once — same engine,
different policy.

**D3 — Ownership before ordering; rejected candidates are preserved.** The
pipeline is: committed visibility → committed-ownership suppression of live
units → THEN order survivors. Never "one array sorted by timestamp" (rejected
in feed-render-item-plan: no shared stable ids across Codex proxy/rollout).
The suppress-vs-reorder discriminator is explicit: **if committed rows own a
unit, it is suppressed with a reason; if committed has NOT caught up, the
semantic-history unit is REORDERED chronologically, never suppressed** —
suppressing un-owned history is data loss (it may be the only representation
of that turn, per #159/#290 where committed never arrives).

**D4 — The ordering law** (from #172 comments 5/6 and feed-render-item-plan):
a true chronological merge. `semantic-history.endedAt < user-entry.timestamp
⇒ history sorts BEFORE that prompt`. Live semantic that started after the
prompt sorts after it. Timestamp trust hierarchy: committed `entry.timestamp`
(producer clock) > semantic `startedAt/endedAt` (local receipt, best
available) > channel `ts` (diagnostics only, never transcript order). Null
timestamps sort after timestamped content. Five-way tiebreak from
feed-render-item-plan carried verbatim. **Tests assert final order, not row
existence** — that is #172's rewritten acceptance bar.

**D5 — The ledger is the single source for paint AND debug.** The
`ownership_decision` schema from submit-queue-debug.md is adopted as the debug
serialization: per candidate — identity keys, source plane, selected owner,
previous owner, reason enum, visible, slot, supersededBy, blockedBy, evidence.
Emitted on first observation, owner change, and suppression. `visible_rows`
stays as the aggregate diff. The 2026-04-18 invariant WARNINGS finally ship as
ledger assertions: user-row-vanishes-with-no-replacement, dual-render of one
artifact, key-changed-but-source-same, unexplained visible-list shrink. This
kills #344 structurally.

**D6 — Ghost becomes a first-class ledger candidate: Phase 3, done right.**
Today ghosts fold into `entries` in a pre-pass the item model never sees, and
`SemanticStreamingTurn` renders the live turn directly — the knowingly-hybrid
two-live-owners architecture. The ledger's ordered view model IS the ordered
insertion `mergeWithUpstream` was waiting for. At **cutover** (Stage 3, not
before): `SemanticStreamingTurn` is deleted and ghost-predicate rule 3
("not semantic-owned") is dropped **in the same change** — never one without
the other (ghost-system.md's explicit warning). Until cutover, the old path
runs untouched.

**D7 — The five-rule ghost predicate ports intact, both rules 4 AND 5.** The
findings-doc's single-rule (timestamp-only) design was overturned by the later
predicate plan: the tail-sidecar case (real commit t=100, predict-next-prompt
sidecar t=105, user walks away) defeats the timestamp gate and is the dominant
production failure. The complete rule set, the 10-case matrix, the sidecar cap
(200 chars; empirical anchor: max sidecar 41ch vs min real 76ch), and the
documented accepted trade-off (a crashed short "Done." turn is invisibly lost)
become fixtures. New rule interactions found in drift: opencode mints ghosts
with no supersede key — Stage 1 decides gate-or-key (see §6 Drift).

**D8 — Upstream Codex's delta-vs-completion reconciliation is the semantic
engine.** Deltas create/extend a live unit. A completion event finalizes the
unit if deltas existed, and creates a row only if none did (non-streaming
responses). Flush the live assistant stream before tool/exec completion rows.
Turn lifecycle keys off TurnStarted/TurnComplete + item/call ids — never
proxy `resp_*` ids, never a "final message" heuristic. Replay ≠ live: replayed
events carry no correlation side effects. Rejected explicitly: latest-text-
wins, render-every-event, render-persisted-only.

**D9 — Content provenance is a trust invariant enforced upstream of the
ledger.** `semantic-current.source ∈ {proxy, rollout, opencode-sse}`. Screen
is a separate lower-trust channel: overlays, conditions, activity, baseline
detection — never assistant content (2026-04-15 decision record). The fold
refuses `source:'screen'` into content. Suppression by committed ownership
moves structurally BEFORE the view layer (it currently partly lives inside
`SemanticStreamingTurn`).

**D10 — Provider asymmetry is policy, not forks.** The `semanticFoldPolicy`
capability shipped this July (5 knobs, registry-resolved) is the proof of
shape and the migration input. The ledger generalizes it: per-provider
candidate policies (claude: whole-turn committed suppression legal,
auto-replace on mismatch; codex: unit-level only, strict live slot, proxy
yield hatches; opencode: unit-level, strict live slot, committed-assembly for
concurrency). The *remaining* hardcoded proxy-string yield hatches in
foldEvent (drift item) are absorbed into the policy at Stage 1.

**D11 — Reference stability is enforced structurally, not conventionally.**
Every reducer/selector returns its input by identity on no-op; the selector
returns `runtime.entries` by reference when nothing survives. This was a root
cause of real render-churn defects, is load-bearing for every Feed memo, and
gets a dedicated test per pipeline stage ("no-op in ⇒ identical reference
out") plus an ESLint-free structural pattern: each stage's output is memoized
on input identity.

**D12 — Three providers, N-ready.** Every type unions on `AgentProviderKind`.
OpenCode's realities are first-class inputs: no screen plane, server-side
concurrency (multiple assistant messages on one SSE), committed truth via
assembled `{info, parts}` messages with `uuid = messageId` and callID-keyed
tools, and the strict live-slot policy. The detector/policy matrix tolerates
empty cells (opencode has no screen; claude has no rollout).

---

## 3. The ledger contract

```ts
// Candidate: one potential visible unit. Provider-neutral after normalization.
type RenderCandidate = {
  id: string                       // stable artifact identity, assigned at ingest
  owner: RenderOwner               // see §1 table
  provider: AgentProviderKind | 'unknown'
  sourcePlane: 'committed' | 'semantic' | 'ghost' | 'local-submit' | 'queue' | 'process'
  source?: string                  // 'proxy' | 'rollout' | 'opencode-sse' | ...
  sessionId: SessionId
  turnId?: string
  blockIndex?: number
  itemId?: string                  // codex response item id
  messageId?: string
  toolUseId?: string               // reserved as first-class (subagent surface, #178)
  callId?: string
  contentKind: 'user-text' | 'assistant-text' | 'tool-use' | 'tool-result'
    | 'thinking' | 'image' | 'compact-boundary' | 'compact-summary'
    | 'work' | 'empty' | 'unknown'
  timestampMs: number | null       // per D4 trust hierarchy
  sequence: number                 // stable fallback
  textKey?: string                 // exact; for committed-text ownership
  normalizedTextKey?: string       // NFKC+collapse; conservative, never fuzzy/prefix
}

type OwnershipDecision = {
  candidateId: string
  selected: boolean
  reason: RenderReason             // closed enum; grows only with a fixture
  suppressionOwnerId?: string      // who won the slot
  evidence: string[]               // id matches, text-hash matches, timestamps
}
```

Reason enum seeds (each existing reason has ≥1 fixture): `selected`,
`committed-text-owned`, `committed-tool-use-owned`,
`committed-tool-result-owned`, `claude-whole-turn-suppressed`,
`meta-entry`, `synthetic-user-filtered` (#338), `not-conversation`,
`ghost-not-orphaned`, `ghost-superseded`, `ghost-semantic-owned`(† dies at
cutover), `ghost-older-than-jsonl`, `ghost-sidecar-shape`,
`empty-thinking`, `empty-write-stdin`, `collapsed-running`,
`compaction-synthesis` (#345/#343), `optimistic-owned-by-committed`,
`queue-owned` , `duplicate-turn-in-history`, `wrong-session-lineage`,
`unknown-hidden`, `unknown-queued-for-implementation`.

Unknown behavior contract (verbatim intent from the dump, redaction rules from
#115): unknowns are structured findings with provider/plane/type/shape-hash/
first-last-seen/count/disposition; never full prompt text or auth material;
`queued_for_implementation` is how future provider behavior gets discovered
without bundle archaeology.

---

## 4. Stage 1 — build the real thing, spec-first

One worktree. New code under `src/renderer/src/rendering/` (final name), built
from scratch, not wired into the app. The old code is reference material; its
distilled truths arrive via the invariant catalog, not via testing the old
functions.

```text
src/renderer/src/rendering/
  observations/        # provider-neutral normalization (types + fromClaude/fromCodex/fromOpencode)
  model/               # state, reduce, candidates, ownership, order, viewModel
  view/                # (Stage 3) Feed + dumb rows; not built in Stage 1
  __tests__/
testing/fixtures/rendering/   # bundle-derived fixture corpus (shared w/ headless pkgs)
testing/support/builders/     # entry/turn/block/ghost/queue/runtime builders
```

No `detectors/` matrix. Detection logic starts inside `model/`; a file splits
when it actually grows, not before.

**The spec = the invariant catalog + the fixture corpus.**

Invariant catalog sources (all already extracted, see research dir):
- the ~60 salvaged script-test invariants (dump's salvage matrix)
- the 18 render-model invariants + ghost 10-case matrix + queue matrix
- the headless-channel 10 Feed Invariants
- the ordering law + 5-way tiebreak + timestamp hierarchy (D4)
- the hard invariants list (§7 below)

First fixtures (each directory: inputs, expected.ledger.json,
expected.rows.json, expected.unknowns.json, README with bug/issue/bundle ref):

| fixture | guards | source |
|---|---|---|
| `buried-prompt-239` | ordering law, prompt at tail | #239 bundle + #172 c5 |
| `queue-handoff-race` | committed replaces queued w/o re-burying | #172 c6 |
| `prompt-no-committed-owner-339` | durable owner when committed never arrives | #339 bundles |
| `stale-web-search-191` | itemId committed-tool suppression | #191/#194 |
| `codex-id-split-dup-170` | exact/normalized text ownership across resp_*/rollout | #170 |
| `tool-use-committed-output-live` | output NOT hidden by tool-use commit | dump inv. 10 |
| `ghost-matrix` (10 cases) | full predicate incl. tool_use-short + null-tail | 2026-05-07 docs |
| `ghost-failed-fixes` (4) | 10e4fc5/686b94e/2a83978/hide-all regressions | findings §8 |
| `dead-committed-channel-159/290` | ledger behavior when JSONL never arrives | #159 c2-4, #290 |
| `claude-cross-turn-tool-result` | pinned turn + next-turn open; one-tick null | 04-17/04-20 docs |
| `codex-3-producer-flicker` | strict slot + producer gating | 04-17 flicker doc |
| `opencode-interleave-87f0eeef` | concurrent messages via committed assembly | this session |
| `opencode-parts-assembly-e8e82431` | assembled {info,parts} → committed units | this session |
| `compaction-xml-c973322e` | synthesis never renders raw; one compaction owner | #343/#345 |
| `synthetic-user-rows-338` | command envelopes filtered w/ reason | #338 |
| `sidecar-tail-t105` | rule 4+5 interaction | predicate plan |
| `bootstrap-37-ghost-flash` | trustSupersededFlag + reconcile-after-bootstrap | 04-20 doc |
| `replay-not-live` | no correlation side effects on replay | upstream doc |

Stage 1 exit: model passes the full catalog + corpus; ledger serialization
schema stable; identity-stability tests green; unknowns logged for every
uncovered input in the corpus. **No production wiring, no behavior change.**

PR slicing inside Stage 1 is free-form (one PR or several) — stages are the
conceptual units, not PR ceremony. Test-file conventions: the "no new tests in
fix PRs" rule is formally exempted for `src/renderer/src/rendering/` and
`testing/{fixtures,support}` — this project IS its tests.

## 5. Stage 2 — shadow: reality corrects the spec

Wire the model to observe real inputs beside the untouched old renderer:
- same IPC feeds fold into the new model in parallel (behind
  `AGENT_CODE_RENDER_SHADOW=1`)
- per session, diff `newModel.rows` vs the old renderer's `visible_rows`
- every divergence auto-captures a minimized fixture draft (inputs + both
  outputs) into the debug bundle
- the ledger's invariant WARNINGS run live (dual-render, vanish-without-
  replacement, unexplained shrink)

Shadow rides normal daily use — Claude, Codex, OpenCode, MCP orchestration,
resumes, compaction, subagents. Divergences are triaged into: old-renderer bug
(fixture proves the new model right — document, keep), new-model bug (fix,
fixture), or spec gap (extend catalog). Stage 2 exits when a week of real use
produces no untriaged divergence classes.

## 6. Stage 3 — cutover

Behind `AGENT_CODE_RENDER_PIPELINE=1`, then default-on, flag kept one release:
- `Feed.tsx` consumes the new view model; rows become dumb (typed data in, JSX
  out; zero ownership logic)
- `SemanticStreamingTurn` deleted + ghost rule 3 dropped (D6, atomically)
- old suppression guards in renderUnits/BlockRow/renderModel deleted as each
  one's ledger fixture is verified green
- live tool rows route through the SAME provider registry dispatch committed
  rows use (kills the BlockRow bypass drift)
- migration hazards honored: LazyEntry eager/lazy from entry-ordinal;
  autoscroll off item-list tail signature; work item carries hint inputs
  explicitly; TextProse/StreamingProse split preserved; ingest-time synthetic
  ids so keys never fall back to visible index

### Drift corrections absorbed along the way (from the drift report)
- Claude unified-conditions regression: **already fixed** on main — dropped
  from the bug list. Conditions remain outside the feed plan.
- foldEvent policy generalization is half-done: proxy-string yield hatches +
  `tool_started` codex literals move into the fold policy (Stage 1 model
  encodes them as policy; old fold untouched until cutover).
- `committedClaudeMessageTurnIds` naming lie (opencode populates it too):
  becomes `committedWholeTurnOwnerIds` driven by a provider policy bit.
- opencode ghosts: Stage 1 decision — **gate opencode out of ghost minting**
  (its committed channel is assembled server truth; the stall-recovery case
  ghost exists for is a file-tailing pathology opencode doesn't have). One
  policy bit; revisit if a real opencode stall bundle ever appears.
- headless named bug (rollout `agent_message_delta` soft-open never
  startTurns): filed and fixed in codex-headless independently of the rewrite.

---

## 7. Hard invariants carried forward (the do-not-break list)

1. Never ghost/synthesize tool **outputs** — fabricates model output.
2. `lastJsonlEntryAt`: from `entry.timestamp`, never `Date.now()`; null not 0;
   never stamped by older-history pagination.
3. Reference stability on no-op, everywhere (D11).
4. One bulk committed-ingestion path; no singular JSONL handler, ever.
5. Dedupe is deterministic: ids or exact/normalized text; never prefix/fuzzy.
6. Codex/opencode: never whole-turn suppression; Claude whole-turn only via
   the policy bit with committed `message.id == turnId` evidence.
7. Committed tool-use ownership ≠ tool-output ownership (separate decisions).
8. `streamPhase !== 'idle'` always yields a work surface; `empty + work` is a
   legal output; work is never text.
9. Screen never becomes assistant content; conditions never become feed rows.
10. Submit ownership signal is renderable semantic content, never streamPhase
    (the setStreamingBaseline-before-optimistic-add trap).
11. Optimistic reconciliation by marker + normalized text, never tail position.
12. Bootstrap replay is bulk + quiet-window repaired; replay is not live.
13. atp and app ship as a pair when ghost semantics change
    (`trustSupersededFlag` lesson).
14. `toolUseId` is reserved as a first-class surface key (subagent fleet,
    #178/#341) — the ledger schema carries it from day one.
15. Every suppression reason in the enum has a fixture; a reason without a
    fixture does not merge.

---

## 8. Issue closure map

The rewrite closes or structurally discharges: **#172** (the umbrella — its
comment-5 criteria are §2 D2–D5), **#339** (durable prompt owner), **#183**
(the fixture suite IS the regression coverage), **#344** (ledger reasons),
**#343/#345** (single compaction owner + synthesis reason), **#338**
(synthetic-row filter with reason), **#346** (prose-split convergence checked
by row-level fixtures), **#185** (queue lane + handoff fixtures). It
deliberately does NOT absorb: #290/#193 (provider tailing/lineage — headless
scope; the ledger only needs to represent "committed channel dead" honestly),
#178/#341 subagent surface (reserved key, own feature), #375 (byte windowing —
model-adjacent, separate), #98/#289 question-tool UI (row-layer feature after
cutover), #99 conditions evolution (separate subsystem).

## 9. Stop conditions

Do not merge Stage 1 unless: catalog + corpus green; ledger/debug single-
sourced; identity-stability tests green; zero unknowns silently rendered.
Do not enter Stage 3 unless: one week of shadow with no untriaged divergence
class; the queue-handoff, buried-prompt, and ghost-matrix fixtures pass against
SHADOW-captured real traffic, not only synthetic inputs.
Do not call #172 closed unless: every owner in §1 has selected AND rejected
fixtures; order-assertion tests exist for the D4 law; `SemanticStreamingTurn`
is deleted; debug bundles contain the ledger.

## 10. What was cut, explicitly

- The 8-phase ceremony and the "test the old code first" evidence-freeze phase
  (its value is captured by the invariant catalog + shadow mode instead)
- The detectors/ directory matrix, the diagnostic code generator, XState,
  bitemporal modeling, per-stage Vitest projects, DOM snapshots for ownership
- Conditions rework from the critical path (already fixed where it was broken)
- Queue-as-feed-rows (D1)
- Any rewrite of headless packages beyond the named soft-open bug — headless
  gets contract fixtures, not rewrites
