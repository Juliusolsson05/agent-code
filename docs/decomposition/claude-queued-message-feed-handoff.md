# Claude Queued-Message Feed Handoff — Staged Decomposition

> **Status:** decomposition only; implementation requires explicit approval.
>
> **Issue:** #665 — Claude queued prompts vanish after attachment consumption.
> Related umbrella: #339 — submitted prompts can lose a visible owner.
>
> **Scope:** Claude user-authored prompts that Claude accepts into its queue and
> later consumes. This does not redesign provider submission generally, and it
> does not add another recording or collection system.

## Why staged decomposition applies

Agent Code is well above the size threshold, and this failure sits at the
boundary between three independent sources of truth:

1. Claude's provider-owned `queue-operation` log says whether an item is still
   pending, but a departure record carries no item identity.
2. Claude's committed transcript is authoritative conversation history, but a
   mid-turn queue `remove` is delivered as an attachment and usually creates no
   committed `user` row.
3. Agent Code's ownership ledger decides what paints, but it cannot select a
   candidate that INGEST never created.

The queue itself was recently repaired through evidence-based reconciliation.
Adding another conditional at its React call site would distribute ownership
again and recreate the exact vanish/duplicate class the rendering ledger was
built to eliminate. This change therefore needs a recorded red test, one
isolated handoff projection, and shared live/replay behavior before UI code is
touched.

The repository already has collection infrastructure and a measured queue
corpus. Stage 1 reuses it. No recorder, transcript format, debug-bundle format,
or imagined provider fixture is added by this plan.

## A — concrete trusted starting point

### Provider acceptance and queue evidence

- `src/providers/claude/runtime/promptDelivery.ts` treats either a committed
  `user` row or `queue-operation/enqueue` as durable acceptance. This proves the
  reported prompt reached Claude; the missing bubble is downstream of delivery.
- `testing/fixtures/queue-operations/remove-is-not-persisted.json` is a redacted
  recording of ordered queue operations and committed user entries from a real
  Agent Code Claude session.
- `testing/fixtures/queue-operations/catalog.md` is the reproducible census over
  the existing local transcript corpus. For queued prompts, committed-user
  observability is 241/278 after `dequeue` and 230/678 after `remove`.
- `docs/decomposition/claude-queue-reconciliation.md` records the upstream
  semantics: `dequeue` delivers a turn input; the dominant `remove` path sends
  queued work as a mid-turn attachment that is not itself persisted as a user
  transcript row.

### Existing isolated queue authority

- `src/renderer/src/session-runtime/claudeQueue/` is the single pure owner of
  Claude queue membership and departure attribution.
- `ClaudeQueueState.pending` retains the exact enqueued content while the item
  is pending.
- `QueueDecision.reason` distinguishes `delivered-observed`,
  `delivered-inferred`, `consumed-as-attachment`, `popped-to-composer`, and
  `stale-unattributed`.
- `useIpcSubscriptions.ts` is the sole live consumer. It applies a queue
  operation, derives `queuedMessages`, then deliberately `continue`s before
  transcript mapping. A queue operation therefore creates no feed entry.

### Existing render authority

- Claude has `usesOptimisticUserEcho: false`; the composer intentionally does
  not mint the local row that Codex and OpenCode use.
- `RuntimeRenderInput.entries` contains committed rows plus explicitly marked
  local optimistic rows. `queuedMessages` is intentionally outside the feed
  contract while work remains pending.
- The ownership ledger is the only visibility/order decision point. Its P6
  rule prefers a surviving local candidate until committed evidence owns it.
- The live entry window already bounds retained rows at 2,000 entries or an
  estimated 32 MiB, trimming with hysteresis to 1,500 entries / 24 MiB.

### Current misleading test boundary

`src/renderer/src/rendering/fixtures.queueHandoff.test.ts` manually inserts an
`optimistic-codex-user:*` row while its fixture provider is Claude. That proves
the ledger can reconcile an optimistic row if one exists; it does not prove the
real Claude composer or queue fold can create that state. The new contract must
drive the production Claude queue transition from recorded raw events.

## Root cause stated as an ownership gap

The submission channel and queue channel are connected correctly. The missing
link is between **queue departure attribution** and **feed candidate creation**.

```text
queue-operation/enqueue
        │
        ▼
ClaudeQueueState.pending ───────────────▶ QueueStrip
        │ remove/dequeue attribution
        ▼
QueueDecision + pending item removed
        │
        └── no handoff artifact ──X──▶ RuntimeRenderInput ──▶ RenderLedger
```

When a committed `user` row follows a `dequeue`, the ordinary transcript mapper
creates the candidate and the bubble paints. When `remove` consumes the prompt
as an attachment—or a dequeue must be inferred—there is no committed row and
no local candidate. The queue item disappears correctly, Claude answers it,
and the feed has nothing it could render.

## D — concrete observable end state

1. A user-authored Claude prompt remains only in `QueueStrip` while genuinely
   pending; it is not prematurely painted as sent.
2. When Claude consumes that prompt as a mid-turn attachment, the prompt moves
   from the queue lane to one chronologically ordered user bubble in the same
   render transition.
3. When `dequeue` is followed by a matching committed user row, that committed
   row is the sole visible owner. No synthetic twin appears.
4. When a dequeue has to be inferred because no committed row claims it, one
   local handoff row survives rather than letting the prompt vanish silently.
5. If committed evidence arrives after a local handoff, the ledger explicitly
   transfers ownership to committed and records why; exactly one row remains.
6. Machine-generated task notifications never become user bubbles. They retain
   their existing Task-card/notification ownership.
7. `popAll` and `stale-unattributed` never mint a sent-message bubble: the first
   returns text to the composer, and the second is not delivery evidence.
8. Live ingestion, cold history hydration, and replay of the same recorded
   window produce the same ordered user rows and ownership decisions.
9. The fix introduces no unbounded full-content collection, no per-operation
   whole-transcript scan, and no render-time queue scan. Local rows participate
   in the existing count-and-byte bounded entry lifecycle.
10. Desktop and remote continue consuming the same ledger output; neither UI
    component learns Claude queue semantics.

## Intermediate stages

### Stage 1 — recorded failing ownership contract

**Produces**

- A narrowly scoped recorded-data test that replays the relevant windows from
  `testing/fixtures/queue-operations/remove-is-not-persisted.json` through the
  production queue attribution boundary.
- Assertions for the final ordered rows, owner, and reason—not merely queue
  length or text existence.
- A correction to `fixtures.queueHandoff.test.ts`'s stated scope so it is
  explicit that the current optimistic handoff fixture exercises echo-provider
  ledger behavior, not the real Claude queue producer.

**Verified by**

- Against untouched `main`, the attachment-consumed prompt test fails because
  no feed candidate is produced.
- The observed-dequeue case already yields exactly one committed row and stays
  green, proving the fixture distinguishes the missing path from the working
  path.
- The test names the source fixture and exact event indices/window it consumes;
  no test literal substitutes for recorded provider input.

**Why separate**

If the transition API is designed before the failing contract exists, the test
will encode whatever object the implementation happens to emit. Stage 1 fixes
the semantic expectation while the implementation still has no influence over
it.

**Reality check**

- The source session contains real prompt `enqueue → remove` windows with no
  matching committed user row, real notification removals, observed dequeue
  deliveries, and inferred prompt dequeues.
- The catalog establishes that `remove` is the dominant departure family and
  that missing committed prompt rows are common, not a theoretical edge.

### Stage 2 — isolated queue-to-feed handoff transition

**Produces**

- A pure handoff transition under
  `src/renderer/src/session-runtime/claudeQueue/` that returns queue state plus
  explicit, transient handoff effects for newly delivered user-authored items.
- A closed handoff-reason contract derived from existing `QueueDecisionReason`;
  it does not create a second explanation for the same departure.
- Reference-stability tests: a no-op returns the previous state and no effects.

**Verified by**

- Stage 1's recorded windows prove which exact pending item produced each
  effect and why.
- Existing queue-corpus replays remain green, including mixed prompt/
  notification attribution and multi-item departure runs.
- Unit tests prove `popped-to-composer`, `stale-unattributed`, and notification
  departures emit no user handoff.

**Why separate**

Queue attribution is the genuinely hard part: departure records carry no ID,
and only the reconciler knows which pending item left. Letting IPC glue or the
ledger rediscover the victim would create two queue authorities that can
disagree.

**Reality check**

The transition consumes the exact event vocabulary and attribution decisions
already measured in the 220-session corpus. It adds no new provider shapes.

### Stage 3 — one projection into the ownership ledger

**Produces**

- One session-runtime projection that consumes the Stage 2 effects and creates
  stable, provider-neutral local user artifacts.
- A local ownership candidate/decision in the ledger for queue-delivered user
  prompts, with committed-by-normalized-identity taking ownership when present.
- The single live IPC call site reduced to forwarding ordered evidence and
  applying the projection result; no visibility decision remains there.

**Verified by**

- The recorded attachment window moves `QueueStrip → local user owner` in one
  tick and paints exactly one row at the departure timestamp.
- The recorded observed-dequeue window paints only the committed entry.
- A recorded late-commit window, if present in the corpus selection, proves the
  local-to-committed transfer. If no such recorded window exists, the behavior
  remains an explicit unknown and cannot be blessed by an invented fixture.
- Ledger assertions cover order, selected owner, rejection reason, and zero
  bridge drops through the real `ledgerToFeedItems` projection.
- D11 tests prove unchanged planes retain their references.

**Why separate**

Stage 2 decides **what left**. Stage 3 decides **who may paint it**. Combining
those responsibilities would make queue membership depend on renderer policy
and make the pure corpus replay impossible.

**Reality check**

The candidate is created only from a handoff effect whose pending item came
from a recorded `enqueue`. No screen text, guessed content, or component-local
queue scan can create it.

### Stage 4 — hydration, pagination, and heap-bound parity

**Produces**

- A shared live/history projection path so recent cold hydration of the
  recorded transcript produces the same handoff rows as live ingest.
- A defined reload/pagination contract for a handoff whose `enqueue` and
  departure straddle a history-page or live-window boundary.
- Memory/lifecycle verification showing that local handoff rows are included in
  the existing live-entry count and byte budgets and are reclaimable/reloadable
  rather than permanently pinning the window.

**Verified by**

- The same recorded event window is replayed through live ingestion and initial
  history hydration; row identities, order, ownership decisions, and content
  match.
- A boundary test is derived by cutting the recorded event sequence at a real
  marker; it may change chunking, but it may not invent provider records.
- Heap assertions inspect retained object counts/bytes and reference reuse. No
  benchmark may pass merely because garbage collection happened to run.
- Existing `liveEntryWindow` count/byte, pagination-marker, trimmed-UUID, and
  pair-integrity tests remain green.

**Why separate**

A live-only bubble would look fixed until reload or trimming, then silently
vanish again. Conversely, solving durability first without the ownership
contract would add a persistent duplicate source. Stage 4 may proceed only
after Stage 3 has exactly-one-owner behavior.

**Reality check**

The history loaders already stream transcript files with bounded ring buffers;
they return the raw recorded queue operations. This stage reuses those readers.
It must not load an entire transcript into an array or introduce another
full-content sidecar without revising this decomposition and obtaining review.

### Stage 5 — whole-pipeline verification and delivery

**Produces**

- Updated rendering architecture documentation for the new local handoff plane
  and its ownership transfer.
- A PR linked with `Fixes #665` and `Refs #339`, containing the approved implementation,
  recorded tests, performance evidence, and known limitations.
- Two independent code reviews after the branch is complete.

**Verified by**

- Focused queue, ledger, live-window, renderer, and history-loader tests.
- The rendering bundle corpus, recording corpus, invariant replay, typecheck,
  and the applicable system/renderer suites.
- Review of every corpus divergence; no blind blessing.
- Final diff audit confirms no unrelated changes and no private transcript
  content.

**Why separate**

Local green tests do not prove the three-plane ownership system still agrees.
The final stage checks the full artifact and records its limitations before the
PR is offered for merge.

**Reality check**

Verification uses the checked-in recorded queue fixture and existing rendering
corpora. Any newly discovered source shape must be recorded through the
existing hard-redacted infrastructure before it can change behavior.

## What is isolated

### Hard component

The hard component is **attributing a queue departure and emitting a user
handoff exactly once without competing with committed history**.

It remains under:

```text
src/renderer/src/session-runtime/claudeQueue/
```

The pure attribution/handoff transition has one consumer: a session-runtime
projection module. Live IPC, initial hydration, and replay consume that
projection; they do not import the hard transition directly.

### Forbidden dependency and ownership directions

- `QueueStrip`, `Feed`, and row components may not import `claudeQueue` or
  inspect queue-operation records.
- `rendering/` may not infer which queued item a `remove` or `dequeue` consumed.
- `claudeQueue/` may not import React, IPC, `features/feed`, or provider renderer
  components.
- The IPC hook may not synthesize visibility based on operation strings with a
  new inline conditional.
- History hydration may not implement a second queue reconciler.
- Task-notification XML recognition remains in the existing queue/provider
  adapters; the feed may not sniff raw XML to decide whether a row is a user
  prompt.
- No debug-only derivation may explain a different reason than the decision
  that actually painted.

## Heap and runtime constraints

1. Full prompt content must not be copied into `ClaudeQueueState.decisions`,
   which is append-only for the session. Decisions retain the existing bounded
   preview only.
2. Handoff effects are transient return values. If a local render entry is
   needed, it reuses the already-retained string reference and then participates
   in the existing entry-window byte/count lifecycle.
3. The current `optimistic-codex-user:` prefix may not be reused blindly. The
   trimmer deliberately stops before optimistic rows; a delivered Claude row
   using that protected prefix could pin every later entry for the rest of a
   long session.
4. No `Array.find`/`filter` over the complete transcript for every queue event.
   The existing ordered fold and bounded pending queue are the hot-path inputs.
5. No module-level content map may outlive its session. Any index must have the
   same teardown sites as queue/runtime state and must be bounded by live
   ownership, not historical transcript length.
6. No `JSON.stringify` of the whole transcript or whole runtime is introduced.
   Existing sampled/cached live-entry byte estimates remain the memory gate.
7. No-op inputs return the exact previous references through the reducer,
   adapter, and ledger chain.

## Unknowns that must remain explicit

1. **Late committed prompt after `remove`.** The corpus reports 33.9% prompt
   observability after remove, but the selected fixture window must establish
   whether any is a true late twin versus repeated/independent text before a
   dedupe rule is broadened.
2. **Repeated identical queued prompts.** Text is the only prompt identity in
   Claude's records. The corpus contains repeated synthetic tokens; we must
   determine whether FIFO plus departure time is enough to avoid one committed
   row suppressing multiple legitimate identical local rows.
3. **Slash-command presentation.** Slash commands are dequeued but may commit
   as expanded text rather than their literal input. The user-visible contract
   for showing the typed command versus Claude's expansion must come from a
   recorded case, not preference.
4. **Bash-mode indistinguishability.** Claude logs a bash-mode command as bare
   text, so the queue reconciler cannot distinguish it from a prompt even though
   upstream attachment eligibility differs. The existing conservative
   attribution rule remains the boundary unless new evidence exists.
5. **History page split.** A page can theoretically contain a departure without
   the earlier enqueue that gives it identity. Stage 4 must measure this against
   real marker spacing and define state carry-over without turning pagination
   into a full-file materialization.
6. **Remote live parity.** Desktop and remote share the ledger painter, but the
   remote transcript store has its own ingestion lifecycle. The shared
   projection must either cover it or the limitation must stay explicit.
7. **Existing queue decision retention.** `QueueDecision[]` itself is currently
   append-only. This fix must not enlarge its retained payload. Bounding that
   pre-existing diagnostic history is a separate performance decision unless
   measurement shows it blocks this work.

If investigation changes any of these from an unknown into a design decision,
this document must be revised before code proceeds. Do not patch forward.

## Fixture plan

### Existing real sources only

- Primary: `testing/fixtures/queue-operations/remove-is-not-persisted.json`.
- Corpus guard: the other checked-in `testing/fixtures/queue-operations/*.json`
  replays.
- Frequency/provenance: `testing/fixtures/queue-operations/catalog.md`.
- Whole-render regression net: existing bundle and recording corpora.
- Issue evidence: #339's captured queue-only/screen-only failures, without
  copying private bundle content into public fixtures.

### Required red-first cases

1. Recorded `enqueue(prompt) → remove` with no matching committed user row:
   pending queue row leaves; one local user handoff appears.
2. Recorded `enqueue → dequeue → matching user`: one committed user row; no
   local twin.
3. Recorded inferred dequeue: one surviving local user row, reason retained.
4. Recorded task-notification departure: no user bubble.
5. Recorded pop-to-composer when publishable evidence becomes available; until
   then the existing synthetic unit case may guard only the already-known pure
   queue rule and may not be presented as handoff evidence.

The tests are written before implementation. A failing assertion against a
recorded case is never weakened or deleted to make the implementation green.
If the recorded data contradicts D, stop and request the user's semantic
judgment rather than blessing a new interpretation.

## Approval boundary

This file is the only repository artifact authorized in the decomposition
step. After it is committed, work stops. No production code, test code, fixture,
or corpus expectation may change until the user explicitly approves this
decomposition.
