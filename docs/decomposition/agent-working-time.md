# Agent Working Time — Stage Decomposition

> **Status:** DRAFT, awaiting approval. No implementation code exists yet. The
> only code on the branch is the reproduction in Stage 1, which asserts today's
> behaviour.
>
> **Branch:** `feat/agent-working-time`. **Worktree:** `.worktrees/agent-working-time`.
> **Base:** `origin/main` at `d12cd347` (2026-09-12).
> **Bug:** [#963](https://github.com/Juliusolsson05/agent-code/issues/963).
> **Feature issue:** filed once the decisions in §6 are made (conventions require
> motivation, intended behaviour and acceptance criteria, and §6 changes all three).
>
> **For agentic workers:** REQUIRED SUB-SKILL: `staged-decomposition`. Do not start a
> stage before its predecessor's artifact exists and is verified independently. If
> a stage disproves this document, revise the document — do not patch forward.
>
> **Triggers (verbatim, speech-to-text):**
> 1. "there's a big bug where agents are active, like, twenty hours. For example, if
>    I close and kill my computer, we're not going to detect a change of activity.
>    So it's going to say that an agent has worked for, like, twenty hours when I
>    open boot it up" — confirmed afterwards: it is the in-feed **Thinking** counter.
> 2. "I want to build up a new model that will open and break down to me exactly how
>    much time I spent running agents in each of my projects … in these last seven
>    days, agent code has been running agents for a total amount of n hours, and you
>    have had n amount of agents running … and in this other project …"
> 3. "One thing we need to fix if we want to implement this new thing is [the bug]."
> 4. On method: "I do not want to wait 20+ hours, we should just be able to read the
>    code and maybe write an integration test to figure this out."

---

## 0. Why the bug and the analytics are one decomposition

The user put it exactly: the analytics cannot be built until the bug is fixed. Both
ask the same question — **"was this agent working at time t?"** — and today the app
has no trustworthy answer to it:

- The only live "working" clock is renderer state (`turnStartedAt`) that counts
  wall-clock time, never learns the machine slept, and can stay non-idle forever.
- Nothing durable records working time at all (§2.3). The closest in-memory flag,
  `AgentProcessState.active`, is never persisted.

If the analytics sums the same signal the counter shows, the analytics inherits
"20 hours of Thinking" as 20 hours of work. If it derives a second, slightly
different signal, the counter and the analytics disagree about the same agent.
Either way the substrate is wrong, so the decomposition fixes the substrate once
(Stages 2–3) and builds both consumers on it.

### Method note: no recording period

The skill's default first stage is live instrumentation. That is replaced here, at
the user's direction, by two things that need no waiting:

1. **Recordings already on disk** (§2.4): a turn that ran through a confirmed
   clamshell sleep, captured independently by Claude, Codex, the Agent Code run
   journal and the macOS power log; an unclean shutdown with a 20.7 h gap; controls.
2. **Integration tests that drive the real code** (§3 Stage 1): the real provider
   proxy adapters feed the real renderer reducers in the order the desktop hook runs
   them, with only the wall clock simulated.

This keeps the rule that matters — tests are causally independent of the
implementer's beliefs — without a live soak.

---

## 1. A and D

### A — what exists and is trusted (verified by reading source at `d12cd347`)

**The counter.**
- `src/renderer/src/features/feed/WorkIndicator.tsx`: hidden when `phase === 'idle'`,
  otherwise `label · formatElapsed(elapsedSeconds)` (e.g. `Thinking · 20h03m`).
- `src/renderer/src/lib/useElapsedSeconds.ts:21,30`: `Math.floor((Date.now() - since) / 1000)`,
  1 Hz, no clamp, no sleep awareness.
- `src/renderer/src/session-runtime/semantic/streamPhaseMachine.ts:54-72`: on a phase
  change `turnStartedAt = submittedAt ?? now` **only while it is null**; cleared only
  by an `idle` phase (`:63-65`) or a `turn_completed` that is not in `awaiting-tool`
  and has no pending tools (`:128-151`). Also cleared by session exit
  (`useIpcSubscriptions.ts:955-964`) and by a fresh runtime on reload.
- `src/renderer/src/workspace/hook/actions/streaming.ts:180-196`
  (`submitJoinsLiveWork`): a prompt sent while the phase is non-idle joins the live
  turn and stamps no new clock — documented there as an "accepted cost".
- The phone client runs the same reducer (`src/remote-client/src/transcript/store.ts:707`).

**Who returns a pane to idle, per provider.**
- **Claude, proxy on** (`packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`):
  idle comes only from the adapter — `onEnd` on `response-end` (`:1068-1128`), an API
  error, or `reapStaleActiveFlow` (`:1162-1187`). The reap runs **only inside the next
  candidate flow's first chunk** (`:1009-1022`, `STALE_ACTIVE_FLOW_MS = 30_000` at
  `:650`). There is no timer. Screen-derived idle is suppressed while a proxy exists
  (`ClaudeCodeHeadless.ts:769-778,843-851`).
- **Codex, proxy on** (`packages/codex-headless/src/proxy/CodexResponsesAdapter.ts`):
  a watchdog interval (10 s tick, 60 s silence, `:356-362,500-513`) seals a silent
  active turn with `finishTurn` (`:983-1021`) but publishes no idle phase; the
  renderer's `turn_completed` bridge then idles it — except out of `awaiting-tool`.
  `response.completed` with client tool calls publishes `awaiting-tool` (`:1541-1555`).
- **OpenCode** (`packages/opencode-headless/src/dispatcher/turnTracker.ts:96-121`): turn
  completion force-publishes idle; no status re-sync on SSE reconnect was found
  (inferred, `SseClient.ts:60-86`).

**Sleep awareness.**
- `src/main/index.ts:672-673`: `powerMonitor.on('suspend'|'resume')` feeds only
  `MainProbe` for performance sleep gaps (`src/main/performance/MainProbe.ts:55-56,90-93`).
  No lock-screen or shutdown listeners; nothing is forwarded to renderers, adapters
  or `SessionManager`; nothing is journaled.
- Every activity clock uses `Date.now()`. The run journal's `monotonicMs`
  (`performance.now()`, `AppRunJournal.ts:499`) advanced **with** wall time across
  real sleeps (evidence case A: Δts 39,882,845 ms vs Δmono 39,883,009 ms), so clock
  drift cannot detect sleep.

**Restart.** Nothing about turns is persisted (`persistence.ts:21-53`; zustand
persists settings only; rehydrate starts from `emptyRuntime`). A cold relaunch
cannot resurrect a stale counter.

**Main-side signals a recorder could use** (`src/main/sessionManager.ts:149-200`):
`started {sessionId, sessionRunId, kind, projectDir}`, `process-state {active}`,
`semantic-event`, `conditions`, `terminal-foreground`, `removed` (the reliable end:
`forwarder.ts:146-153`), `exit`. `ownsEntry()` drops events from replaced runs.

**Durable history today** — see §2.3. Short version: nothing records working time
per agent per project.

### D — the end state, as observable behaviour

**Bug (#963).**
1. After the machine sleeps, no pane shows a work counter that includes the sleep.
2. A turn whose stream died during sleep and is not retried does not stay
   `Thinking`: after a bounded grace period following wake it leaves the working
   state (exact presentation is decision §6 Q1).
3. A turn that genuinely continues after wake shows working time **excluding** the
   sleep (§6 Q2).
4. A prompt sent after wake starts its own clock.
5. Dispatch "working" rows, Close Old Agents and Close Idle Orchestration Agents stop
   treating such a pane as working, because they read the same phase.

**Analytics.**
6. A palette command opens an Agent Analytics modal. For a selected range (default
   last 7 days) it shows total agent working hours and the number of agents, and the
   same two numbers per project, with the project's worktrees folded in.
7. Sleep, unclean shutdowns and stuck phases never count as working time.
8. The numbers are the same in every window, and they survive app restarts.

---

## 2. Verified findings the stages rest on

### 2.1 Reproduction results (Stage 1 test, all passing against today's code)

`src/renderer/src/session-runtime/semantic/turnClockAcrossSleep.test.ts`, 8 tests,
real adapters + real `foldSemanticEvent` + real `reduceStreamPhase`:

| # | Scenario | Claude proxy | Codex proxy |
|---|---|---|---|
| 1 | Turn streaming before the lid closes | clock stamped at prompt | — |
| 2 | Stream severed by sleep, no retry | **stuck `Thinking` forever on the pre-sleep clock**; zero timers exist to close it; a new prompt joins the stuck turn; reads `20h03m` next morning | shows the sleep until the first watchdog tick (≤10 s after wake), then idle |
| 3 | Retry after wake | reap → `idle` → clock restarts at the retry (correct) | — |
| 4 | Turn finished before sleep | no counter after wake (correct) | — |
| 5 | Client tool across sleep, never returns | — | **stuck `awaiting-tool` on the pre-sleep clock** |
| 6 | Tool returns / turn continues after wake | **counter includes the whole sleep** | **counter includes the whole sleep** |

Rows 2, 5 and 6 are the bug. Row 6 is not "stuck" — the turn is live — but it is the
same wrong number, and it is exactly what real case A would have painted for the
17 s between wake and Claude's `turn_duration`.

### 2.2 Sources of truth disagree about sleep

From the real case-A turn: Claude's `turn_duration` = 11.08 h (wall clock, includes
sleep); Codex's `duration_ms` for its overlapping turn = 1.48 h against an 11.62 h
wall span (excludes sleep); OpenCode stores wall-clock ms. **Provider-reported
durations cannot be summed as-is** — two of three count sleep.

### 2.3 Durable data inventory (what analytics could read today)

| Source | Working time? | Agents? | Project key | Retention / since |
|---|---|---|---|---|
| Native transcripts (Claude `turn_duration`; Codex `task_started`→`task_complete`/`turn_aborted`; OpenCode `time.completed`) | yes, per turn, with the sleep caveat above | per conversation | `cwd` per record | Claude 30 d; history back months; includes CLI use outside Agent Code |
| Conversation ledger (`STATE_DIR/conversations/ledger.jsonl`) | no (`lastSeenAt` not persisted when unchanged) | yes: provider, nativeId, latest localSessionId, cwd, orchestration role | cwd | since 2026-09-12; excludes terminals and pre-native-id sessions |
| Session lifecycle journal (run journal `events.jsonl`) | no turn end; `submit.*` only from the composer | `provider.start.end` per sessionId | none (no cwd by allowlist) | ~50 newest runs, then 48 h TTL |
| Performance monitor history | no (processes alive incl. terminals, peak per minute) | no | none | 7 d, since 2026-09-12 |
| Workflow run journals | exact attempt start/end | workflow agents only | run cwd | unpruned |
| `workspace.json` | no timestamps except `detachedAt` | current panes only | cwd, tab | snapshot |
| TLDR / Goal history | write times only, opt-in | via `tldrIdentity` only | none for closed panes | 100 entries/identity |

Conclusion: forward analytics needs a new, small, durable record. Backfill from
transcripts is possible but would include non–Agent Code CLI sessions and would have
to subtract sleep that only the OS power log knows about (and on this Mac that log
holds transitions only for 2026-08-29 → 09-02).

### 2.4 Evidence corpus (already on disk; privacy: timestamps, entry types, durations only)

- **Case A — turn across a confirmed clamshell sleep (2026-08-31 → 09-01).**
  Claude `~/.claude/projects/-Users-…-bringdown/a531e423-481c-4f5b-ad9a-30b2f0e3de53.jsonl`
  (prompt 20:57:09 PDT, tool result 21:02:42, assistant 22:45:08, `turn_duration`
  39,888,429 ms at 08:01:57); Codex `~/.codex/sessions/2026/08/30/rollout-…01a05588…jsonl`
  (`turn_aborted`: 20:25:17 → 08:02:15, `duration_ms` 1.48 h); run journal
  `incidents/runs/2026-08-31T02-48-19-110Z-main-74831-b8e42f/events.jsonl`; power log
  sleep 23:43:59 → wake 08:01:40.
- **Case B — app idle through sleep (control).** Run `2026-09-01T20-33-12-431Z-main-75074-2f6565`
  (`submit.result` 01:07:52 → `submit.begin` 10:27:31) and power log sleep 01:11:14 → 10:25:02.
- **Case C — unclean shutdown, 20.71 h gap.** Claude `…-agent-code/5a657d7b-86a0-4dd3-a365-13b72cb01027.jsonl`
  (`tool_use` 08-29 13:16:29 with no result; next entries 08-30 09:59:23); previous
  run tail (last heartbeat 13:16, no quit) and next run head
  (`app.prior_unclean_shutdown`, `force_quit_or_power_loss`).
- **Controls.** Codex `rollout-2026-09-02T14-49-55-01a06419…jsonl` (11.76 h open turn,
  `duration_ms` equals wall span → idle-open, not sleep); OpenCode
  `ses_d7a1e6448f6a5a598dc28f42a08f4477` (9.53 h aborted message after a suspected crash).

### 2.5 Identity facts (for the analytics)

- **Project:** tab ids die on close/merge, differ per window and are unknown to main;
  `cwd` splits worktrees into pseudo-projects (what #908 removed). The repository
  family root (`src/main/conversations/family.ts:71-134`, first `git worktree list`
  entry, normalized) survives restarts, tab changes, windows and worktrees, and main
  can resolve it. It must be resolved **at record time** (a deleted worktree cannot be
  resolved later).
- **Agent:** `sessionId` is replaced by reload/switch/rewind/resume (over-counts);
  `provider:nativeId` changes on switch/rewind and is missing for terminals;
  `agentNameId` is carried across replacement and new only for duplicates, but is
  renderer-owned, can be absent when names are off, and reaches main only through
  the workspace save (`ConversationLedger.projectWindows` already parses it).

---

## 3. Stages

### Stage 1 — Reproduction and evidence fixtures

- [x] **1a. Integration reproduction** — `turnClockAcrossSleep.test.ts` (§2.1).
- [ ] **1b. Evidence fixtures** — extract cases A, B, C and the controls into
  `testing/fixtures/agent-working-time/` as JSON holding only timestamps, entry
  types, durations, provider, anonymized cwd keys and the power-log transitions.
  One small extractor script beside the existing `scripts/extract-*.mts`; no
  verify gate (avoid enforcement bloat).

| Field | |
|---|---|
| **Produces** | The reproduction test (done) and a fixture directory with one file per case. |
| **Verified by** | 1a runs the real adapters and reducers and passes against today's code. 1b: each fixture names its source file and time window, and a reviewer can re-derive every timestamp from that source. |
| **Why separate** | Stage 3 flips these tests from "today" to "correct". If the fix and its tests were written together, the tests would bless the fix's own assumptions — the 481/481 failure. |
| **Reality check** | §2.4 recordings; the adapters' own code paths. |

### Stage 2 — One main-owned suspension signal

A single source of "the machine was not running between S and R", consumed by the
turn clock, the adapters and the recorder.

- Main listens to `powerMonitor` `suspend` / `resume`, and also detects suspension
  **without** relying on those events: a coarse main-process tick that observes a
  wall-clock gap far larger than its interval means the process was frozen (timers
  do not run while asleep). Clock drift cannot be used (§1 A, sleep awareness).
- Main publishes `{ suspendedAt, resumedAt, source: 'power-monitor' | 'tick-gap' }`:
  broadcast to renderers (app-wide state, `broadcastToWindows`), delivered to
  `SessionManager` so each provider runtime can tell its adapter, and journaled in
  the run journal (area `system.power`) so future debug bundles show sleep.
- Contract type in `src/shared/`, IPC + preload in the usual places.

| Field | |
|---|---|
| **Produces** | `SystemSuspension` contract, main detector, broadcast channel, journal event. |
| **Verified by** | Unit tests with a fake power-monitor emitter and a fake clock: suspend/resume pair → one interval; missing `resume` but a tick gap → one interval from the gap; duplicate events → one interval. Journal record written. No later stage needed. |
| **Why separate** | The turn clock (Stage 3) and the recorder (Stage 4) both need sleep intervals. Two consumers deriving sleep independently is two truths — the reconciliation rule. |
| **Reality check** | Cases A and B timings; `MainProbe`'s existing suspend handling; the observation that `monotonicMs` does not pause. |

### Stage 3 — Fix the turn clock (#963)

Three changes, each driven by flipping a Stage 1 row to its correct expectation
**before** the change is made:

- **3a. Seal streams that died during sleep.** On resume, a proxy flow that has had no
  transport activity since before the suspension gets a grace window (default 60 s)
  to show life — a chunk, `response-end`, or a new flow (which already reaps it). If
  none arrives it is sealed exactly like today's reap: `turn_stopped` (medium
  confidence) + `idle`. Claude gains the resume hook and a periodic reap; Codex runs
  its watchdog on resume and publishes `idle` when it seals. `awaiting-tool` is **not**
  cleared on wake: the tool's process was suspended too and usually completes (row 6).
  These are package changes (`claude-code-headless`, `codex-headless`) → package PRs,
  gitlink bumps and a lockfile resync.
- **3b. Working time excludes suspension.** One pure function owns the displayed
  number: `workingSeconds(turnStartedAt, suspensions, now)`. `WorkIndicator` calls it
  instead of raw `useElapsedSeconds`; the phone client gets the same function.
- **3c. A prompt after wake starts its own clock.** Verify it falls out of 3a (the
  stale phase is gone, so `submitJoinsLiveWork` is false). Only if a flipped Stage 1
  test still fails does `submitJoinsLiveWork` itself change — its #889 queue contract
  must be preserved.

| Field | |
|---|---|
| **Produces** | Adapter resume/seal behaviour, `workingSeconds`, the flipped Stage 1 suite. |
| **Verified by** | Stage 1 rows 2, 5 and 6 inverted to the §6-decided behaviour and passing; rows 1, 3 and 4 unchanged; existing #889 queue tests (`streamingQueuedSubmit.renderer.test.tsx`, `useComposerKeybinds.queueAcceptance.renderer.test.tsx`) unchanged. |
| **Why separate** | Stage 4 records working intervals from the same semantics. Recording before the substrate is right records the bug. |
| **Reality check** | Stage 1 fixtures; the adapters' code paths in §1 A. |

**Shippable on its own.** Stages 1–3 fix #963 and are a complete PR.

### Stage 4 — Working-interval recorder (main, durable)

- **The hard part, isolated:** `src/shared/agentActivity/workingState.ts`, a pure
  reducer over `semantic-event`, `process-state`, `conditions`, `removed`/`exit` and
  Stage 2 suspensions → closed `WorkingInterval`s. It reuses the stream-phase machine
  (moved from `src/renderer/src/session-runtime/semantic/` to `src/shared/` so main and
  renderer run literally the same reducer — it is already pure and already shared
  with the phone client).
- **Recorder:** `src/main/agentActivity/` subscribes to `SessionManager` like the
  forwarder, seeding from `manager.list()`. Each interval row:
  `{ sessionId, sessionRunId, provider, cwd, repoRoot, agentKey, orchestrationRole?,
  startedAt, endedAt, endReason: completed | stopped | suspended | exit | quit | recovered-after-crash }`.
  `repoRoot` is resolved at record time; `agentKey` is `agentNameId ?? sessionId`,
  enriched from the workspace projection the way the conversation ledger is.
- **Crash / force quit:** an interval still open at startup is closed at the previous
  run's last heartbeat (run journal, 5 s cadence), so case C contributes seconds, not
  20.7 h.
- **Storage:** append-only monthly JSONL under `STATE_DIR/agent-activity/`, serialized
  writes, flushed on `before-quit`, pruned beyond the retention window. User data —
  not registered with `debugRetention`. No prompt text, ever.

| Field | |
|---|---|
| **Produces** | `workingState` reducer, recorder, interval store. |
| **Verified by** | Event sequences built from the Stage 1 fixtures replayed into the recorder with a fake clock: case A yields working time that excludes 23:43:59 → 08:01:40; case B yields none across its sleep; case C yields an interval closed at the last heartbeat; a reload (new `sessionId`, same `agentNameId`) yields one agent. |
| **Why separate** | The query (Stage 5) must never re-derive working state. The reducer has exactly one consumer per process: the renderer counter and the main recorder. |
| **Reality check** | §2.4 cases; `SessionManager` event map; ledger's workspace projection. |

### Stage 5 — Aggregation query (main, pure)

`summarize(intervals, range, now)` →
`{ range, totals: { agentHours, agents }, projects: [{ repoRoot, label, worktrees, agentHours, agents, … }], days: [...] }`,
exposed as `agent-activity:summary(range)` through IPC and preload. Aggregated in
main so every window gets the same answer.

| Field | |
|---|---|
| **Produces** | Pure summarizer, IPC handler, preload API, shared result type. |
| **Verified by** | Interval fixtures produced by running Stage 4 over the Stage 1 recordings (not hand-written intervals): totals, per-project split with worktrees folded, overlapping agents per §6 Q3, range boundaries cutting an interval. |
| **Why separate** | The modal must not arbitrate sources or overlap rules; one pure function holds them. |
| **Reality check** | Stage 4 output from real recordings. |

### Stage 6 — Agent Analytics modal and command

Command (title per `docs/command-style.md`, e.g. `Open Agent Analytics`, category
`workspace-tools`, surface `app`), uiShell flag, surface registry entry,
`CommandContext` ui/flags, `CommandPalette` context wiring, `surfaceOwnership`,
`featureReference`/`controlReference`, catalog snapshot. The modal: range control
like `performance-monitor/Timeline.tsx`, totals, per-project rows, hand-rolled SVG
bars (no chart library exists and none is needed).

| Field | |
|---|---|
| **Produces** | The visible feature. |
| **Verified by** | Renderer test against a Stage 5 result fixture; catalog/taxonomy/featureReference tests. |
| **Why separate** | Pure presentation of an already-correct object. |
| **Reality check** | Stage 5 output. |

---

## 4. What is isolated

| Module | Owns | Single consumer | Forbidden |
|---|---|---|---|
| `src/main/…/systemSuspension` (Stage 2) | when the machine was not running | the broadcast/journal edge | any other `powerMonitor` subscription for session or activity purposes; clock-drift heuristics elsewhere |
| `src/shared/agentActivity/workingState.ts` (Stage 4, with the moved phase machine) | whether an agent is working, per interval | renderer counter; main recorder | features computing working time from raw `turnStartedAt`/`streamPhase` themselves (WorkIndicator, analytics, future Dispatch durations) |
| `workingSeconds` (Stage 3b) | the displayed number | `WorkIndicator` and the phone client | `useElapsedSeconds` for turn time |
| `src/main/agentActivity/` (Stages 4–5) | durable intervals and summaries | the IPC handler | renderer reading activity files; any second activity store |

Existing divergent derivations noted, not in scope: #915 (two "last active" rules).

---

## 5. Unknowns

1. **Does `powerMonitor` `resume` fire reliably** on this macOS version for clamshell
   sleep, dark wake and battery sleep? No recording of it exists (the monitor's
   `sleepGap` was true in 0 samples, but no sleep occurred in that run). Stage 2's
   tick-gap detector exists because of this.
2. **What Claude Code does after its request is severed by sleep** — retry, surface an
   API error, or hang — and after how long. Decides the 3a grace window.
3. **Whether mitmproxy emits anything** (`response-end`, error) for a connection reset
   after wake. If it does, part of 3a is already handled by `onEnd`.
4. **Dark wake / Power Nap**: whether timers run briefly during sleep and split one
   suspension into several.
5. **OpenCode SSE reconnect**: no status re-sync was found (inferred); a turn could
   miss `session.idle` across a reconnect.
6. **Codex `duration_ms` semantics**: what exactly it excludes.
7. **Permission prompts and questions**: time a turn spends blocked on the user —
   work or not (§6 Q4).
8. **Multiple windows and the phone client**: suspension must reach both; the phone
   has its own clock.
9. **Orchestration children with inherited context** and native provider subagents:
   whether and how they count as agents.
10. **The user's own report**: the power log shows no sleep since the 2026-09-10 boot,
    so the specific 20 h instance may have been a stuck phase rather than a sleep in
    that window. Rows 2 and 5 cover both.

---

## 6. Decisions needed from the user

Recommendations first; each changes tests in Stage 3 or 5.

- **Q1. A stream that died during sleep and is not retried — what does the pane show
  after the grace window?** *Recommended:* return to idle and leave a small
  "interrupted while asleep" marker in the feed. Alternatives: idle silently; keep the
  phase but stop the counter.
- **Q2. A turn that continues after wake — what does the counter show?** *Recommended:*
  working time excluding the sleep (e.g. `Thinking · 3m12s`). Alternative: restart
  the counter at wake.
- **Q3. "N hours" in the analytics.** *Recommended:* agent-hours (three agents working
  for one hour = 3 h), because it answers "how much agent work ran", with wall-clock
  hours per project as a secondary figure. Alternative: wall-clock only.
- **Q4. What counts as working.** *Recommended:* from a turn starting until it ends,
  including tool execution and `awaiting-tool`, excluding suspension and time blocked
  on a permission prompt or question. Alternative: include blocked time.
- **Q5. What counts as an agent.** *Recommended:* distinct agents
  (`agentNameId ?? sessionId`) that did any work in the range; user-created and
  orchestration agents shown separately; terminals and native provider subagents
  excluded.
- **Q6. What is a project.** *Recommended:* the repository, worktrees folded in,
  labelled with the repository name (and the open tab letter when one holds it).
- **Q7. History before the feature ships.** *Recommended:* forward-only — numbers start
  on the day Stage 4 ships. Backfill from transcripts would include CLI use outside
  Agent Code and cannot subtract sleep reliably (§2.2–2.3).
- **Q8. Ranges and retention.** *Recommended:* 24 h / 7 d / 30 d, keep 90 days of
  intervals.
- **Q9. Shipping.** *Recommended:* Stages 1–3 as the #963 PR first (you hit it daily),
  then Stages 4–6 as the analytics PR on top.

---

## 7. Fixture plan

| Stage | Fixture | Source (produced by) |
|---|---|---|
| 1 | Timings in `turnClockAcrossSleep.test.ts` | Case A (§2.4), already in the test |
| 1b → 2, 3 | `testing/fixtures/agent-working-time/case-a-sleep-turn.json`, `case-b-idle-sleep.json`, `case-c-unclean-shutdown.json`, `control-open-turn.json`, `control-opencode-abort.json` | Extracted from the §2.4 recordings: timestamps, entry types, durations, power transitions; no text, anonymized paths |
| 3 | The Stage 1 suite, inverted per §6 | Stage 1 |
| 4 | Event sequences for the recorder | Built from the Stage 1b fixtures (journal event names/order + transcript turn timings + power transitions) |
| 5 | Interval sets | Stage 4 recorder run over the Stage 4 sequences — never hand-written intervals |
| 6 | Summary object | Stage 5 output |

Every fixture names the recording and the time window it came from.
