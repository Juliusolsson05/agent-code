# Agent Working Time — Stage Decomposition

> **Status:** Stages 1–3 (the #963 fix) are built and in review:
> [agent-code#967](https://github.com/Juliusolsson05/agent-code/pull/967), which depends on
> [claude-code-headless#59](https://github.com/Juliusolsson05/claude-code-headless/pull/59) and
> [codex-headless#51](https://github.com/Juliusolsson05/codex-headless/pull/51) (merge those first,
> then re-point the gitlinks at their merged commits). Stages 4–6 (analytics, #964) are next,
> after §6 Q10 (grouping project rows by tab title) is confirmed. Merge requires explicit approval.
>
> **Branch:** `feat/agent-working-time`. **Worktree:** `.worktrees/agent-working-time`.
> **Base:** `origin/main` at `d12cd347` (2026-09-12).
> **Bug:** [#963](https://github.com/Juliusolsson05/agent-code/issues/963).
> **Feature:** [#964](https://github.com/Juliusolsson05/agent-code/issues/964).
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
> 5. Decisions: "the tab is the project, but it will actually show both, but just with
>    the tab as the root level … 7a 8b forever, this should take almost no data if we
>    do it correctly. 1a 2a 3a (so both is kind of the point) 4a" and "sure a for 5".

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
2. A turn whose stream died during sleep and is not retried leaves the working state
   after a bounded grace period following wake, and the feed shows a small
   **"Interrupted while asleep"** marker where it stopped (§6 Q1).
3. A turn that genuinely continues after wake shows working time **excluding** the
   sleep (§6 Q2).
4. A prompt sent after wake starts its own clock.
5. Dispatch "working" rows, Close Old Agents and Close Idle Orchestration Agents stop
   treating such a pane as working, because they read the same phase.

**Analytics (#964).**

Purpose, in the user's words: "the main point for the analytics is me as a founder to
see what I have spent time on, so that I can go about and make sure I do not waste any
of my time." The window therefore has to answer *what the time went to*, not only how
much there was — which is why every project lists its agents with what they were doing.

6. A palette command opens an Agent Analytics window. For a selected range
   (24 hours, 7 days, 30 days, all time) it shows, in total and per project:
   **agent-hours** (three agents working for an hour = 3 h), **wall-clock hours**
   (the same hour = 1 h), and the **number of agents** — agents the user started and
   orchestration workers shown separately.
7. **Projects are tabs at the root level**, with the repository and its worktree
   directories listed underneath each tab (§6 Q6).
8. Working time runs from a turn starting until it ends, including tool execution,
   and excludes sleep and time blocked on a permission prompt or question (§6 Q4).
   Unclean shutdowns and stuck phases never count.
9. The numbers are identical in every window, survive restarts, start on the day the
   recorder ships (§6 Q7), and are **kept forever** in a compact form (§6 Q8).

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

Conclusion: the analytics needs a new, small, durable record. Backfill was rejected
(§6 Q7): it would include CLI use outside Agent Code and cannot subtract sleep.

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
- **Volume** (for storage sizing): Claude wrote 2,083 `turn_duration` records in the
  last 14 days; this week had 176 Claude, 166 Codex and 36 OpenCode sessions, and
  22–107 active app sessions per day.

### 2.5 Identity facts (for the analytics)

- **Tab (the project, §6 Q6):** `Tab = { id, title, root, focusedSessionId }`; ids are
  UUIDs, per window, removed on close and on merge; the title is the folder basename
  chosen at creation. Main has no notion of a tab, but reads it through the workspace
  projection (`workspaceFileStore.observe`, already parsed by the conversation
  ledger): grid leaves belong to their tab, Dispatch rows carry `projectTabId`.
  Membership must therefore be captured **while the agent works**, not reconstructed
  later.
- **Repository and worktree (shown under each tab):** the repository family root
  (`src/main/conversations/family.ts:71-134`, first `git worktree list` entry,
  normalized) plus the spawn `cwd`. Resolved at record time; a deleted worktree
  cannot be resolved later.
- **Agent:** `sessionId` is replaced by reload/switch/rewind/resume (over-counts);
  `provider:nativeId` changes on switch/rewind and is missing for terminals;
  `agentNameId` is carried across replacement and new only for duplicates, but is
  renderer-owned and can be absent when names are off. Counting key:
  `agentNameId ?? sessionId`. Orchestration role from `orchestrationParentId`.

---

## 3. Stages

### Stage 1 — Reproduction

- [x] **Integration reproduction** — `turnClockAcrossSleep.test.ts` (§2.1).

| Field | |
|---|---|
| **Produces** | The reproduction test (done). Evidence fixtures for the recorder are extracted at the start of Stage 4, where they are first needed. |
| **Verified by** | Runs the real adapters and reducers and passes against today's code. |
| **Why separate** | Stage 3 flips these tests from "today" to "correct". If the fix and its tests were written together, the tests would bless the fix's own assumptions — the 481/481 failure. |
| **Reality check** | Case A timings (§2.4); the adapters' own code paths. |

### Stage 2 — One main-owned suspension signal

- [x] **Implemented.** `src/main/systemSuspension/SystemSuspensionTracker.ts` (the only
  `powerMonitor` subscriber; MainProbe now reads its power-monitor events),
  `darwinWakeTime.ts` (`kern.waketime`), contract `src/shared/types/systemSuspension.ts`,
  IPC `src/main/ipc/systemSuspension.ts` + preload `listSystemSuspensions` /
  `onSystemSuspension`, journal event `system.power / system.suspension`, and
  `SessionManager.noteSystemSuspension` fanning out to the optional
  `AgentSession.noteSystemSuspension`.
- **Revision forced by the evidence:** a tick gap alone is not published. MainProbe
  already warns that an awake main-thread stall produces the same gap, and provider
  CLIs keep working during a main stall, so a gap counts only when the OS reports a
  wake inside it (`kern.waketime`). Off macOS, tick gaps are never published.

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
| **Verified by** | Unit tests with a fake power-monitor emitter and a fake clock: suspend/resume pair → one interval; missing `resume` but a tick gap → one interval from the gap; both sources for the same sleep → one interval. Journal record written. No later stage needed. |
| **Why separate** | The turn clock (Stage 3) and the recorder (Stage 4) both need sleep intervals. Two consumers deriving sleep independently is two truths — the reconciliation rule. |
| **Reality check** | Cases A and B timings; `MainProbe`'s existing suspend handling; the observation that `monotonicMs` does not pause. |

### Stage 3 — Fix the turn clock (#963)

- [x] **Implemented.** The Stage 1 suite was inverted first (4 tests red on
  `sealFlowsSilentSince is not a function` and the missing Codex deferral), then made
  green. What shipped, and where it departs from the plan below:
  - **Adapter API** is synchronous `sealFlowsSilentSince(silentSince, 'system-suspended')`
    in both packages; `turn_stopped` gains an optional `interruption` field, kept out of
    `stopReason` (upstream's vocabulary). The host owns timing.
  - **Claude** (`claudeSession.noteSystemSuspension`): seal after a 60 s grace so a Claude
    Code retry can reap the flow normally. The "periodic reap" in 3a was **dropped**: the
    bug is sleep-specific and a timer reap would change behaviour for every silent stream.
  - **Codex** (`codexSession.noteSystemSuspension`): seal immediately — a retry cannot
    claim the active slot while the dead flow holds it. **New:** a watchdog tick that
    arrives more than `WATCHDOG_STALE_MS` late defers one tick, so the anonymous timeout
    cannot pre-empt the sleep seal; without a notice the next tick still releases.
  - **Counter** (3b): `workingSeconds`/`suspendedMsWithin` in `src/shared/agentActivity/`;
    `WorkIndicator` subtracts suspensions from `useSystemSuspensions()` (a module store fed
    by the preload bridge). The phone client does not render `WorkIndicator`, so it is
    unaffected.
  - **Marker** (Q1a): a process-plane lifecycle candidate (owner `work`, content kind
    `sleep-interruption`) minted by `collectLifecycleCandidates` when the pane is idle and
    the newest turn carries `interruption`; the view bridge emits a `sleep-interruption`
    item painted in the work slot. No new RenderOwner. It gives way to the work chip as
    soon as the next prompt makes the pane work.
  - **3c** fell out of 3a: after a seal `submitJoinsLiveWork` is false (asserted);
    `submitJoinsLiveWork` is unchanged.
  - Verified: reproduction suite 12/12 through the real adapters, fold, ledger and view
    bridge; every sealing/deferral/marker rule mutation-checked; both package proxy and
    channel suites green.

Each change is driven by flipping a Stage 1 row to its decided expectation **before**
the change is made:

- **3a. Seal streams that died during sleep.** On resume, a proxy flow that has had no
  transport activity since before the suspension gets a grace window (default 60 s)
  to show life — a chunk, `response-end`, or a new flow (which already reaps it). If
  none arrives it is sealed like today's reap: `turn_stopped` with a stop reason that
  says the machine slept, plus `idle`. The feed renders that stop as a small
  **"Interrupted while asleep"** marker (§6 Q1a) — through the existing turn-stopped
  rendering path, not a new ad-hoc row. Claude gains the resume hook and a periodic
  reap; Codex runs its watchdog on resume and publishes `idle` when it seals.
  `awaiting-tool` is **not** cleared on wake: the tool's process was suspended too and
  usually completes (row 6). These are package changes (`claude-code-headless`,
  `codex-headless`) → package PRs, gitlink bumps and a lockfile resync.
- **3b. Working time excludes suspension (§6 Q2a).** One pure function owns the
  displayed number: `workingSeconds(turnStartedAt, suspensions, now)`. `WorkIndicator`
  calls it instead of raw `useElapsedSeconds`; the phone client gets the same function.
- **3c. A prompt after wake starts its own clock.** Verify it falls out of 3a (the
  stale phase is gone, so `submitJoinsLiveWork` is false). Only if a flipped Stage 1
  test still fails does `submitJoinsLiveWork` itself change — its #889 queue contract
  must be preserved.

| Field | |
|---|---|
| **Produces** | Adapter resume/seal behaviour, the sleep stop reason and its feed marker, `workingSeconds`, the flipped Stage 1 suite. |
| **Verified by** | Stage 1 rows 2, 5 and 6 inverted to the decided behaviour and passing; rows 1, 3 and 4 unchanged; existing #889 queue tests (`streamingQueuedSubmit.renderer.test.tsx`, `useComposerKeybinds.queueAcceptance.renderer.test.tsx`) unchanged; rendering shape coverage for the marker. |
| **Why separate** | Stage 4 records working intervals from the same semantics. Recording before the substrate is right records the bug. |
| **Reality check** | Stage 1 tests; the adapters' code paths in §1 A. |

**Ships on its own** as the #963 PR (§6 Q9).

### Stages 4–6 build notes (2026-09-12, branch `feat/agent-analytics`)

The user asked to build without further questions ("go about and build the goal
here… do not waste our time"), so the two open questions take their recommended
defaults, recorded here and in #964:

- **§6 Q10 — grouping:** project rows group by **tab title**. A tab closed and
  reopened for the same folder, or merged into another, stays one project.
- **Scope of "time":** **agent working time only.** The user's own activity (prompts
  sent, focus per tab) is not recorded; it can be added later as a separate figure.

Design as built, where it refines the stage text below:

- **Contract first:** `src/shared/agentActivity/summaryTypes.ts` fixes the summary
  tree (projects → repositories → worktrees, plus each project's agents with labels,
  agent-hours and wall-clock hours, days) so the window and the recorder are built
  in parallel against one shape.
- **Working state in main:** a pure reducer over the manager's `semantic-event`
  (`stream_phase`, `turn_started`, `turn_completed`), `conditions` (blocked on the
  user ⇒ not working), `removed` and `exit`. It follows the renderer's stream-phase
  rules, and an equivalence test feeds the same real adapter event sequences to both
  so they cannot drift. It does not import renderer code: the layering forbids it
  and the renderer reducer needs the full semantic fold.
- **Suspensions are stored, not baked in:** intervals are recorded as observed and
  the summary subtracts stored suspensions with `suspendedMsWithin`, the same rule
  as the counter. Recording stays simple and a later fix to suspension detection
  corrects history.
- **Crash safety without growth:** open intervals live in one small `open.json`
  rewritten on change and touched every 30 s; at startup any interval left open is
  closed at that last touch, so an unclean shutdown contributes seconds, not hours.
- **Storage:** closed intervals append to monthly JSONL under
  `STATE_DIR/agent-activity/`; suspensions append to their own file. Older months
  compact into per-day rollups (see Stage 4 storage) so all-time ranges stay cheap.

### Stage 4 — Working-interval recorder (main, durable)

- **Fixtures first:** extract cases A, B, C and the controls into
  `testing/fixtures/agent-working-time/` as JSON holding only timestamps, journal
  event names and order, transcript turn timings, provider, anonymized cwd keys and
  the power-log transitions. One small extractor script beside the existing
  `scripts/extract-*.mts`; no verify gate (avoid enforcement bloat).
- **The hard part, isolated:** `src/shared/agentActivity/workingState.ts`, a pure
  reducer over `semantic-event`, `process-state`, `conditions` (blocked on the user →
  not working, §6 Q4), `removed`/`exit` and Stage 2 suspensions → closed
  `WorkingInterval`s. It reuses the stream-phase machine, moved from
  `src/renderer/src/session-runtime/semantic/` to `src/shared/` so main and renderer
  run literally the same reducer (it is already pure and already shared with the
  phone client).
- **Recorder:** `src/main/agentActivity/` subscribes to `SessionManager` like the
  forwarder, seeding from `manager.list()`. Each interval row carries:
  `{ agentKey, sessionId, sessionRunId, provider, role: user | orchestration,
  tab: { id, title }, repoRoot, cwd, startedAt, endedAt, endReason }`.
  Tab membership comes from the workspace projection at the time of work
  (§2.5); `repoRoot` is resolved at record time; `agentKey` is `agentNameId ?? sessionId`.
- **Crash / force quit:** an interval still open at startup is closed at the previous
  run's last heartbeat (run journal, 5 s cadence), so case C contributes seconds, not
  20.7 h.
- **Storage, kept forever (§6 Q8) and small by construction:**
  - Raw intervals append to monthly JSONL under `STATE_DIR/agent-activity/intervals/`
    (roughly 150 bytes per turn; at the observed few hundred turns a day that is well
    under 100 KB/day).
  - Days older than a raw window (default 35 days, so the 30-day range always has
    exact wall-clock unions) are compacted into `rollups/YYYY.jsonl`: one row per
    day × tab × repository/worktree × agent with `agentMs`, plus one row per day ×
    tab (and per day overall) with the precomputed wall-clock union `wallMs`. All-time
    ranges read rollups; a year of heavy use is expected to stay in the low megabytes.
  - Serialized writes, flushed on `before-quit`. User data — not registered with
    `debugRetention`. No prompt text, ever.

| Field | |
|---|---|
| **Produces** | Evidence fixtures, `workingState` reducer, recorder, interval store, compactor. |
| **Verified by** | Event sequences built from the fixtures replayed into the recorder with a fake clock: case A yields working time that excludes 23:43:59 → 08:01:40; case B yields none across its sleep; case C yields an interval closed at the last heartbeat; a reload (new `sessionId`, same `agentNameId`) yields one agent; a permission-prompt wait splits the interval. Compaction of a recorded month preserves every day's `agentMs` and `wallMs` exactly. |
| **Why separate** | The query (Stage 5) must never re-derive working state. The reducer has exactly one consumer per process: the renderer counter and the main recorder. |
| **Reality check** | §2.4 cases; `SessionManager` event map; the ledger's workspace projection. |

### Stage 5 — Aggregation query (main, pure)

`summarize(store, range, now)` →

```
{ range,
  totals:   { agentHours, wallHours, agents: { user, orchestration } },
  projects: [ { tabKey, title, open: boolean,
                agentHours, wallHours, agents: { user, orchestration },
                repositories: [ { repoRoot, label, agentHours, wallHours, agents,
                                  worktrees: [ { cwd, label, agentHours, agents } ] } ] } ],
  days:     [ { date, agentHours, wallHours } ] }
```

- Agent-hours sum intervals; wall-clock hours are the union of intervals within the
  row (tab, repository, or the whole range). Both are always returned (§6 Q3).
- Root rows are tabs, grouped by tab title (§6 Q10) so a tab closed and reopened for
  the same folder, or merged into another, stays one project; `open` marks whether a
  tab with that title is open now.
- Exposed as `agent-activity:summary(range)` through IPC and preload; aggregated in
  main so every window gets the same answer.

| Field | |
|---|---|
| **Produces** | Pure summarizer, IPC handler, preload API, shared result type. |
| **Verified by** | Stores produced by running Stage 4 over the fixture sequences (never hand-written intervals): totals, agent-hours vs wall-clock for overlapping agents, tab root rows with repositories and worktrees beneath, a range boundary cutting an interval, all-time reading rollups and raw days together without double counting. |
| **Why separate** | The window must not arbitrate sources, overlap or grouping; one pure function holds them. |
| **Reality check** | Stage 4 output from real recordings. |

### Stage 6 — Agent Analytics window and command

Command (title per `docs/command-style.md`, e.g. `Open Agent Analytics`, category
`workspace-tools`, surface `app`), uiShell flag, surface registry entry,
`CommandContext` ui/flags, `CommandPalette` context wiring, `surfaceOwnership`,
`featureReference`/`controlReference`, catalog snapshot. The window: range control
(24 h / 7 d / 30 d / all time) like `performance-monitor/Timeline.tsx`, totals, tab rows
that expand to repositories and worktrees, both hour figures side by side, agents
split user/orchestration, hand-rolled SVG bars (no chart library exists or is needed).

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
| `src/main/agentActivity/` (Stages 4–5) | durable intervals, rollups and summaries | the IPC handler | renderer reading activity files; any second activity store |

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
7. **Tab titles**: whether a tab can be renamed, and how a rename should affect
   grouping by title (§6 Q10).
8. **Multiple windows and the phone client**: suspension must reach both; the phone
   has its own clock.
9. **Native provider subagents**: excluded from agent counts (§6 Q5), but their work
   happens inside the parent's turn and is already counted there.
10. **The user's own report**: the power log shows no sleep since the 2026-09-10 boot,
    so the specific 20 h instance may have been a stuck phase rather than a sleep in
    that window. Rows 2 and 5 cover both.

---

## 6. Decisions

Recorded 2026-09-12.

| # | Question | Decision |
|---|---|---|
| Q1 | A stream that died during sleep and is not retried | **Return to idle and leave a small "Interrupted while asleep" marker in the feed.** |
| Q2 | A turn that continues after wake | **The counter excludes the sleep.** |
| Q3 | "N hours" in the analytics | **Both: agent-hours and wall-clock hours** ("both is kind of the point"). |
| Q4 | What counts as working | **Turn start to turn end, including tool execution; excluding sleep and time blocked on a permission prompt or question.** |
| Q5 | What counts as an agent | **Distinct agents (`agentNameId ?? sessionId`) that did work in the range; user-started and orchestration agents shown separately; terminals and native provider subagents excluded.** |
| Q6 | What is a project | **The tab, at the root level; the repository and its worktrees shown underneath** ("it will actually show both, but just with the tab as the root level"). |
| Q7 | History before the feature ships | **Forward-only.** |
| Q8 | Retention | **Forever**, stored compactly ("this should take almost no data if we do it correctly"). Ranges: 24 h / 7 d / 30 d / all time. |
| Q9 | Shipping | Not answered; proceeding with the recommendation: **Stages 1–3 as the #963 PR first, Stages 4–6 as the analytics PR.** |
| Q10 | A tab closed and reopened for the same folder, or merged | Open. **Working default: group root rows by tab title**, so both stay one project. Confirm before Stage 5. |

---

## 7. Fixture plan

| Stage | Fixture | Source (produced by) |
|---|---|---|
| 1 | Timings in `turnClockAcrossSleep.test.ts` | Case A (§2.4), already in the test |
| 3 | The Stage 1 suite, inverted per §6 | Stage 1 |
| 4 | `testing/fixtures/agent-working-time/case-a-sleep-turn.json`, `case-b-idle-sleep.json`, `case-c-unclean-shutdown.json`, `control-open-turn.json`, `control-opencode-abort.json` | Extracted from the §2.4 recordings at the start of Stage 4: timestamps, event names/order, turn timings, power transitions; no text, anonymized paths |
| 4 | Event sequences for the recorder | Built from those fixtures |
| 5 | Stores (raw intervals + rollups) | Stage 4 recorder and compactor run over the Stage 4 sequences — never hand-written intervals |
| 6 | Summary object | Stage 5 output |

Every fixture names the recording and the time window it came from.
