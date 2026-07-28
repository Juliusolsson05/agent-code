# Session Lifecycle Observability — Implementation Plan

**Status:** Ready for implementation

**Date:** 2026-07-28

**Branch:** `feat/session-lifecycle-observability`

**Worktree:** `.worktrees/session-lifecycle-observability`

**Decomposition:** [`docs/decomposition/agent-boot-readiness.md`](../../decomposition/agent-boot-readiness.md)
— read §0 and §3 before touching anything here. This plan implements **Stage 1
and Stage 2** of that decomposition. Stages 3–6 are deliberately out of scope and
cannot start until this PR has been running long enough to produce a corpus.

---

## Goal

Make the agent boot/readiness path **observable**, and stop one confirmed defect
from turning every delivery failure into a wedged pane.

Three shipped outcomes:

1. **A `session.lifecycle` event stream**, always on, in the existing incident
   journal — every spawn, recover, adopt, readiness transition, wake request
   (with its caller), prompt delivery, and kill, on one clock across all three
   processes.
2. **A pane that names its own stall.** `Replaying transcript… 4s` instead of a
   silent disabled composer, and `agent failed to start` replaced by the actual
   reason.
3. **The optimistic submit state unwinds on a provable non-delivery** — the
   `Sending · 17s` forever bug, which today can only be cleared by reloading the
   agent.

**Explicit non-goal: this PR does not fix why backends go missing.** It makes the
next occurrence diagnosable and non-wedging. That distinction is the whole point
of the decomposition; a PR that quietly also "fixes" the root cause would be
patch #31 and would invalidate the corpus it is meant to produce.

---

## Why this plan exists

Boot has been patched ~30 times since 2026-04-11 and has never converged.
`docs/decomposition/agent-boot-readiness.md` §0 establishes the reason with
measured evidence: **no boot event has ever been recorded.** Every fix was
authored from source reading against a failure nobody had captured.

The concrete instance that triggered this work (decomposition §0, "First
candidate shape"):

> `Cannot deliver prompt: 9dc65b98-… is not a live agent session` — and then the
> pane shows `Sending · 17s`, counting up forever, until the agent is reloaded.

That is two defects compounding, and only one of them is diagnosable from source:

- **A (cause, unknown):** `sessionManager.ts:1740-1752` finds no registry entry
  for a session the renderer believes is live and ready. Why is not derivable
  from source. **This PR does not fix A. It records it.**
- **B (amplifier, confirmed):** the submit path sets `streamPhase: 'submitting'`
  *before* the attempt and never unwinds it on failure. **This PR fixes B.**

---

## Confirmed defect B — the full trace

Recorded here because the fix must not be re-derived later from the symptom.

1. `useComposerKeybinds.ts:223` calls `workspace.setStreamingBaseline(...)`.
2. `streaming.ts:141-176` sets `streamPhase: 'submitting'`, `submittedAt: now`,
   `awaitingAssistant: true`, `turnStartedAt: now`, `phaseChangedAt: now`.
3. `caps.composerSubmit(...)` throws when delivery fails.
4. `useComposerKeybinds.ts:279-307` catches: sets `promptDelivery`, removes the
   optimistic Codex echo, shows a toast. **It never touches `streamPhase`.**

There are exactly three ways `streamPhase` can return to `'idle'`, and under a
`before-write` delivery failure **none of them can fire**:

| Path | Why it cannot fire |
|---|---|
| `onSessionExit` → `useIpcSubscriptions.ts:831` | Requires a real exit event. Main has no registry entry *to* exit — that is the failure. |
| `emptyRuntime()` → `session-runtime/state.ts:729` | Only on a fresh runtime, i.e. **agent reload**. This is why reload is the only escape. |
| `reduceStreamPhase` from a provider semantic event | Nothing was ever written, so no event will arrive. And `streamPhaseMachine.ts:118` **deliberately refuses to stomp `submitting`/`requesting`** from screen-derived signals (rationale at `:105`). |

`WorkIndicator.tsx:112` renders `'submitting'` as `Sending`, and
`useElapsed(submittedAt)` counts up at 1 Hz. Hence `Sending · 17s → 4m → …`.

### The fix, and the trap it must avoid

The decomposition's standing warning is that a guard added to protect a path
becomes the next weapon (#548's kill-timeout → #596; `TileLeaf`'s `!inputReady`
gate → #598). So the discriminator is explicit:

- **Unwind ONLY when main reports `promptWritten === false && enterWritten ===
  false`.** That is a fact already on the wire in `PromptDeliveryResult`, not an
  inference about *why* delivery failed. Nothing was written ⇒ no turn can start
  ⇒ the optimistic phase is provably a lie.
- **Do NOT unwind the `uncertain` case** (`promptWritten` or `enterWritten`
  true). There we genuinely do not know whether a turn began; unwinding could
  hide a real running turn. That case keeps today's behaviour and is a Stage 4
  catalog question.
- **Do NOT relax `streamPhaseMachine.ts:118`.** That guard is a shipped
  regression's tombstone. The unwind belongs at the submit site that *owns* the
  optimistic set, which is the same site that set it.

---

## Design

### Where the code lives, and what may import it

Per decomposition §4:

| Path | Contents | Consumers |
|---|---|---|
| `src/shared/lifecycle/events.ts` | The closed event-name vocabulary, the `SessionLifecycleEvent` payload type, and the redaction contract. Pure types + constants. No I/O, no Electron, no React. | main, preload, renderer |
| `src/main/lifecycle/SessionLifecycleJournal.ts` | Thin typed emitter over the existing `AppRunJournal`. Single sink. | `sessionManager`, `ipc/lifecycle` |
| `src/main/ipc/lifecycle.ts` | `session:lifecycle-report` — renderer → main bridge, defensive parsing + token bucket, modelled on `ipc/incident.ts`. | main only |
| `src/renderer/src/lifecycle/report.ts` | Renderer-side emit helper (fire-and-forget). | renderer emit sites |
| `scripts/summarize-lifecycle.mts` | Reads a run's `events.jsonl`, prints one phase ladder per session. | humans |

**Forbidden:** `src/renderer/src/rendering/**` must never import `lifecycle/**`.
The one-way `session-runtime/ → rendering/ → features/feed/` layering does not
gain a fourth edge. `lifecycle/**` must never import `features/**`.

**The journal is a sink, never a decider.** No production branch may read a
lifecycle event to make a runtime decision. If a future fix needs that, the state
belongs in `shared/` as real state with the journal as its *serialization* —
same rule as rendering's P4 (`debug output is a serialization of the same
decision, never a second derivation`).

### Why extend `AppRunJournal` instead of a new store

`AppRunJournal` already solves every hard part, with scar tissue we must not
re-earn: always-on (unlike `AGENT_CODE_PERF`, which is why we have zero
recordings), per-run 50 MiB hard ceiling, drop-oldest pending bound, atomic
heartbeat, redaction via `sanitizePerformanceData`, degrades to a silent no-op
when `~/.config` is unwritable, and synchronous flush on quit.

`SessionManager` already holds a journal reference and already emits three
`session.recovery` events (`sessionManager.ts:435-451`). This plan widens that
seam; it does not open a new one.

**Corollary benefit:** lifecycle events land in the same `events.jsonl` as heap
pressure, window-unresponsive, and crash breadcrumbs — so a stall can be
correlated against main-process health without joining two files.

### Event vocabulary (closed)

`area: 'session.lifecycle'`. Names are a closed set; adding one is a deliberate
contract change.

| Name | Emitted by | Key data |
|---|---|---|
| `rehydrate.start` / `rehydrate.complete` | renderer | tab/leaf/detached/buried counts, resolved count, duration |
| `recover.request` | renderer | kind, hasResumeId, caller |
| `recover.claim` / `recover.join` | main | claim state |
| `recover.adopted` / `recover.spawned` | main | lifecycle, durationMs |
| `recover.conflict` / `recover.cancelled` / `recover.failed` | main | typed code |
| `spawn.begin` / `spawn.end` | main | kind, durationMs, ok |
| `provider.start.begin` / `provider.start.end` | main | kind, durationMs |
| `gate.eval` | main (provider) | kind, gate state, reason, **every evaluation, not only transitions** |
| `readiness.publish` | main | ready, reason, revision |
| `wake.request` | renderer | **caller identity** (which of the nine sites) |
| `wake.result` | renderer | disposition, durationMs |
| `history.load.start` / `history.load.end` | renderer | durationMs, entryCount, status |
| `submit.begin` | renderer | provider, hasImages |
| `submit.result` | renderer | ok, stage, code, promptWritten, enterWritten |
| `submit.unwound` | renderer | **the Bug B fix firing** — phase restored |
| `delivery.reject` | main | code, stage, registryHit |
| `kill.request` | main | cause |

`gate.eval` on **every** evaluation is the single most important choice here. The
edge-triggered `publishPromptGate` (`claudeSession.ts:785`) is why a
never-ready session is currently invisible: it emits nothing. Recording every
evaluation is what makes "stuck at `composer-unpainted` for 90 s" a fact instead
of a guess.

### Redaction

Metadata only: ids, kinds, phases, reasons, counts, durations, booleans. **Never**
prompts, assistant text, tool payloads, file contents, commands, MCP URLs, or
tokens. Enforced by routing every payload through the journal's existing
`sanitizePerformanceData`, and by a unit test asserting the emitter drops unknown
keys rather than passing them through.

---

## Delivery slices

Red-green-refactor. Behaviour and its regression test land together.

### Slice 1 — Vocabulary and the main emitter

**Files:** `src/shared/lifecycle/events.ts` (new),
`src/main/lifecycle/SessionLifecycleJournal.ts` (new).

**Tests first** — `src/main/lifecycle/SessionLifecycleJournal.test.ts`:

1. A known event name reaches the underlying journal with `area:
   'session.lifecycle'`.
2. Unknown top-level data keys are dropped, not forwarded.
3. A throwing journal never propagates out of the emitter (recovery correctness
   outranks forensics — same contract as `recordRecovery`).
4. A null journal is a silent no-op.

### Slice 2 — Main emit points

**Files:** `src/main/sessionManager.ts`.

Widen `recordRecovery` into the typed emitter and add emissions at the existing
decision points: `recover()` claim/join/adopt/spawn/conflict/cancel, `spawn()`
begin/end, provider `start()` begin/end, `setInputReadiness`, the
`deliverPromptToAgent` registry miss (`:1745`), and `kill`.

**Tests** — extend `src/main/sessionManager.recover.test.ts`:

1. Adoption emits `recover.adopted` exactly once with a duration.
2. Cold spawn emits `recover.spawned` and both `provider.start.*`.
3. A typed conflict emits `recover.conflict` carrying the code.
4. Kill-during-recovery emits `recover.cancelled`, not a phantom success.
5. The registry-miss delivery rejection emits `delivery.reject` with
   `registryHit: false`.

### Slice 3 — Renderer bridge and emit points

**Files:** `src/main/ipc/lifecycle.ts` (new), `src/preload/api/lifecycle.ts`
(new), `src/preload/api/{index,types}.ts`,
`src/renderer/src/lifecycle/report.ts` (new), `rehydrate.ts`,
`hook/actions/session.ts`, `hook/actions/initialHistory.ts`, and the nine wake
call sites (**instrumented in place — not consolidated**, per decomposition §4).

**Tests:**

1. IPC rejects an unknown event name.
2. IPC rate-limits a storm and emits one suppression summary.
3. `wake.request` carries a distinct caller identity for each of the nine sites
   (this is the data that will tell Stage 4 which of them actually differ).
4. `rehydrate.start`/`complete` bracket a restore with the resolved count.

### Slice 4 — Provider gate evaluation

**Files:** `providers/claude/runtime/claudeSession.ts`,
`providers/codex/runtime/codexSession.ts`,
`providers/opencode/runtime/opencodeSession.ts`.

Emit `gate.eval` on every `derivePromptGateState` evaluation (Claude) and each
provider's equivalent. **Do not change any gate logic in this PR.**

**Tests:** a resumed Claude session that never quiesces emits repeated
`gate.eval` with `reason: 'replay-pending'` — i.e. the currently-silent stall
becomes a visible fact.

### Slice 5 — Stage 2a: the pane names its stall

**Files:** `renderer/.../TileLeaf/readiness.ts`, the composer status badge, and
the failure toast sites.

Surface `SessionInputReadiness.reason` + elapsed. Replace the reasonless
`'agent failed to start'` with reason + session id.

**Tests:** each readiness reason maps to its user-facing string; a failure with a
typed code renders the code, not the generic string.

### Slice 6 — Stage 2b: unwind the optimistic submit (Bug B)

**Files:** `renderer/.../TileLeaf/useComposerKeybinds.ts`,
`renderer/.../hook/actions/streaming.ts`.

Add an explicit unwind that restores `streamPhase`, `submittedAt`,
`turnStartedAt`, `phaseChangedAt`, and `awaitingAssistant` to their pre-submit
values, called from the catch **only** when the delivery result proves nothing
was written.

**Tests first** — `useComposerKeybinds.renderer.test.tsx`:

1. `deliverPrompt` rejects with `promptWritten: false, enterWritten: false` ⇒
   phase returns to `idle`, `submittedAt` null, draft preserved, toast shown.
2. `deliverPrompt` rejects with `promptWritten: true` ⇒ phase **stays**
   `submitting` and `promptDelivery` is `uncertain` (today's behaviour, pinned).
3. A successful submit is unaffected.
4. `streamPhaseMachine`'s `submitting`/`requesting` guard is unchanged —
   existing test stays green.

### Slice 7 — Summarizer and docs

**Files:** `scripts/summarize-lifecycle.mts` (new), `package.json` script,
`docs/decomposition/agent-boot-readiness.md` status update.

One phase ladder per session, terminal state, and elapsed per phase. This is the
reader that makes Stage 3's corpus usable.

---

## Invariants

1. The journal is a **sink**. No production branch reads a lifecycle event.
2. Emission **never** throws into a caller and never awaits.
3. Metadata only. No prompts, payloads, commands, URLs, or tokens.
4. Always on. No env flag gates lifecycle events.
5. Bounded — inherits the per-run 50 MiB ceiling and drop-oldest pending bound.
6. `gate.eval` fires on every evaluation, not only transitions.
7. The nine wake sites are **instrumented, not merged**, in this PR.
8. Submit unwind requires proof nothing was written; never an inference.
9. `streamPhaseMachine.ts:118` is unchanged.
10. No gate/readiness/ownership **logic** changes anywhere in this PR.

---

## Non-goals

- Fixing why backends go missing (Bug A). Recorded, not fixed.
- Consolidating the nine wake call sites.
- Splitting `sessionManager.ts`, `pane.ts`, `useIpcSubscriptions.ts`, or
  `hook/index.ts`.
- Touching Tier 3 transport (`SessionFeed`, preload contracts, remote wire) —
  #548 built it correctly.
- Changing the `uncertain` prompt-delivery path.
- A new metrics subsystem, dashboard, or settings toggle.
- Renaming `rehydrate` (noted in decomposition §3 as opportunistic; not here —
  it would bury the diff).

---

## Verification

Per `project_verification_tsc_gate`: electron-vite and vitest do **not**
type-check. Raw `tsc` on both projects is the gate.

```bash
npm run typecheck          # builds workflow-mcp, then tsc -b
npm run test:contract
npm run test:core
npm run test:renderer
npm run test:system
```

Run the full suite **once at the end**, not per slice.

**Not verified by launching the app** (`feedback_never_launch_app`) — correctness
is argued from source and pinned by tests.

---

## Risks

| Risk | Mitigation |
|---|---|
| Journal volume — `gate.eval` on every evaluation could be chatty | Inherits the 50 MiB per-run ceiling and drop-oldest bound. Slice 4 measures event rate in its test and coalesces identical consecutive evaluations if needed. |
| The unwind hides a real running turn | Gated on `promptWritten === false && enterWritten === false`, a main-reported fact. The `uncertain` path is explicitly untouched and pinned by test 2. |
| Instrumentation drifts from the paths it claims to record | Every emit point sits at an existing decision site; no new control flow is introduced. |
| Scope creep into fixing A | Stated as invariant 10 and non-goal 1. A reviewer should reject any gate-logic change in this diff. |
