# Agent Boot & Readiness — Stage Decomposition

> **Status:** Stages 1 and 2 **IMPLEMENTED** on `feat/session-lifecycle-observability`
> (plan: [`../superpowers/plans/2026-07-28-session-lifecycle-observability.md`](../superpowers/plans/2026-07-28-session-lifecycle-observability.md)).
> **Stage 3 is now the blocking step and it is not an engineering task** — it is
> using the app normally until the corpus has repeats. Stages 4–6 cannot be
> scheduled until it does.
>
> **What shipped:** `src/shared/lifecycle/events.ts` (closed vocabulary,
> allowlisted payload), `src/main/lifecycle/SessionLifecycleJournal.ts`,
> `src/main/ipc/lifecycle.ts`, `src/renderer/src/lifecycle/report.ts`,
> ~20 emit points, `npm run lifecycle:summarize`, the readiness reason + elapsed
> on the pane, and the Bug B submit unwind.
>
> **Corrections this work forced on the document below:** §3 said nine wake call
> sites. Making `caller` a required parameter of `ensureSessionLive` turned the
> compiler into the census and found **thirteen**. The grep undercounted, which
> is a small instance of the document's own thesis.
>
> **For agentic workers:** REQUIRED SUB-SKILL: `staged-decomposition`. Stages use
> checkbox (`- [ ]`) syntax. Do not start a stage before its predecessor's
> artifact exists and has been verified independently. If a stage disproves this
> document, revise the document — do not patch forward.
>
> **Trigger (verbatim):** "I cannot submit the prompt at the start. The agent
> takes minutes to start. I get some notification about the agents not starting.
> I'm not sure we ever had a proper logging infrastructure to even follow along
> what's going on here."
>
> **Prior art this supersedes:** #545/#548 (atomic recovery), #596/#597 (remount
> kill), #598 (condition answering), #590, #606, #283/#301, #258. Every one of
> those was a correct local fix. Collectively they did not converge, and §0 says
> why.

---

## 0. Why another attempt, and why this one is shaped differently

Boot has been patched roughly thirty times since 2026-04-11 (see the history in
`git log --grep` over `boot|resume|recover|rehydrat|wake`). The fixes were not
wrong. #548's atomic main-owned `recover()` is genuinely the right ownership
model. The problem is that **every one of those fixes was authored from source
reading and reasoning, against a failure nobody had ever recorded.**

Compare with the rendering pipeline, which had the identical bug class — several
subsystems each believing they owned the same visible thing, focused patches that
each regressed a neighbour. That was not fixed by more patches. It was fixed by
`docs/rendering/rendering-design-principles.md` P1:

> You cannot fix a rendering bug by reading code and editing it. You reproduce it
> as a fixture first, or you will regress something you can't see.

Rendering now has 48 debug bundles, a recording corpus, five machine-checked
replay invariants, and a single decision point that records *why* for every
candidate. **Boot has none of that.** It has ~30 patches and a
`console.warn`.

This decomposition applies the rendering method to boot. Stage 1 is
instrumentation and it produces nothing visible, which is exactly why it has
never been built.

### The evidence that we are flying blind (measured, not asserted)

| Claim | Evidence |
|---|---|
| **No boot event is journaled at all.** | `AppRunIncidentKind` (`src/main/incident/journalTypes.ts:87-111`) has 20 members: crash, heap, window, orchestration, MCP host, remote. The only session member is `session.input_write_failed`. There is no kind for spawn, recover, adopt, readiness, or stall. |
| **The perf tracer is off by default and is the wrong instrument.** | `src/renderer/src/performance/client.ts:27` — `enabled: false`, gated behind `AGENT_CODE_PERF`. It emits durations. It cannot answer "which gate state is this session stuck in." |
| **The session recorder structurally cannot see boot.** | `SessionRecorderManager.ts:99-150` — the recorder starts on the session's **first event**, and auto-record is behind `AGENT_CODE_SESSION_RECORD`. The boot window is over before it arms. |
| **Readiness is edge-triggered into silence.** | `claudeSession.ts:785-798` `publishPromptGate` emits `input-readiness` only on a transition into ready, or out of ready. A session that never becomes ready emits **nothing** after `SessionManager` line 887 sets `{ready:false, reason:'starting'}`. The renderer waits forever with no further fact. |
| **The stall reason exists and is thrown away.** | `derivePromptGateState` (`claudeSession.ts:744-783`) computes a precise reason — `blocked`, `occupied/human-draft`, `warming/replay-pending`, `warming/composer-unpainted`. `SessionInputReadiness.reason` is documented as "diagnostic/advisory; correctness gates only on `ready`." Nothing displays it, nothing logs it. |
| **What the user actually sees is reasonless.** | `TileLeaf/readiness.ts:13` → `'agent failed to start'`. `session.ts:219` → `'Timed out waiting for agent to become ready for input'`. No session id, no phase, no provider, no elapsed. This is the "bullshit notification." |
| **Cold boot fans out unbounded.** | `rehydrate.ts:588` — `Promise.all` over every visible leaf, each with a 30s deadline (`rehydrate.ts:62`). The in-file comment already concedes 9 providers "all started in this Promise.all in the same ~3 seconds." Nobody has measured what that does to TUI paint latency, which is what the composer classifier reads. |

**Conclusion:** the reason boot has resisted thirty fixes is not that the fixes
were bad. It is that *we have never once observed a failure*. Every fix was a
hypothesis. This is precisely the 40%-then-whack-a-mole mechanism the
`staged-decomposition` skill describes, and the exit is the same: enumerate from
reality, not from imagination.

### First candidate shape — reported 2026-07-28

Reported verbatim: *"`Cannot deliver prompt: 9dc65b98-… is not a live agent
session`. The agent just states Sending forever and does nothing — `Sending ·
17s` — and I have to reload the agent to send the prompt."*

This is **two independent defects that compound**, and separating them matters
because only one of them needs the corpus.

#### A — The cause: registry split-brain (needs Stage 1)

`sessionManager.ts:1740-1752` — `deliverPromptToAgent` looks up
`this.sessions.get(sessionId)`, finds **no entry**, and returns
`code: 'not-ready'`. So main's live registry has no backend for a session the
renderer believes is started, `inputReady`, and writable.

Why the entry is missing is **unknown and not derivable from source**. Candidates:
a backend exited without the renderer processing `onSessionExit`; a cancelled
recovery that removed the registry entry (`recover()` step 5) while the pane kept
its optimistic runtime; a kill from the #597 residue paths; or a wedged provider
in the accepted-cost class (Unknown 7). **This is exactly the question the boot
journal exists to answer**, and no amount of further source reading will settle
it — which is the thesis of this document, now with a concrete instance.

#### B — The amplifier: the optimistic submit state is never unwound (source-confirmed)

`useComposerKeybinds.ts:223` calls `setStreamingBaseline`, which sets
`streamPhase: 'submitting'`, `submittedAt: now`, `awaitingAssistant: true`
(`streaming.ts:141-176`) — **before** the `try`.

The `catch` (`useComposerKeybinds.ts:279-307`) sets `promptDelivery`, removes the
optimistic Codex echo, and shows a toast. **It never resets `streamPhase`,
`submittedAt`, or `awaitingAssistant`.**

And nothing else can. There are exactly three paths that clear `streamPhase` to
`'idle'`:

1. `onSessionExit` (`useIpcSubscriptions.ts:831`) — requires a real exit event, which never arrives, because the pane's problem is precisely that main has *no entry* to exit.
2. `emptyRuntime()` (`session-runtime/state.ts:729`) — only on a fresh runtime, i.e. **reload**.
3. `reduceStreamPhase` from a real provider semantic event — which cannot arrive, because nothing was ever written. And `streamPhaseMachine.ts:118` **deliberately refuses to stomp `submitting`/`requesting`** from screen-derived signals; that guard is scar tissue with its rationale at `:105`.

**Therefore `Sending` counts up forever and reload is the only exit.** That is
the reported behaviour, exactly, and it is provable without a recording.

**Why B matters more than its size suggests:** the system *correctly detected and
reported* this failure. The toast fired. `promptDelivery` was set to a typed
failure state. And the pane still wedged, because the optimistic state that was
set before the attempt was never unwound after it. Every future fix to A will
keep feeling like it did nothing, as long as B turns any delivery failure into a
permanently stuck pane.

**Fix constraint:** the reset belongs at the submit site that *owns* the
optimistic set. Do **not** weaken the `streamPhaseMachine` guard at `:118` to
achieve it — that guard is a shipped regression's tombstone, and relaxing it
reintroduces the pinned-`submitting` bug it was written to fix.

> **Status: B is FIXED** — shipped as part of Stage 2 rather than as a patch
> ahead of it, because "the pane stops lying about its own state" is precisely
> what Stage 2 is. The unwind fires only when main reports
> `promptWritten === false && enterWritten === false`; the `uncertain` path and
> the `streamPhaseMachine` guard are both untouched. Every firing is recorded as
> `submit.unwound`, so the corpus will measure how often the old build would
> have wedged a pane.
>
> **A is still unfixed, deliberately.** It is now recorded and classified —
> `delivery.reject` carries `never-owned` versus `entry-lost-after-owned`, which
> are two different defects that are byte-identical to the user. Which one
> actually happens is a Stage 3 question, and answering it from source instead
> of from the corpus would be the thirty-first patch.

### On "temporary code"

You offered to write throwaway code to diagnose this. Counter-proposal, and it
matters: **Stage 1 must be permanent.** A temporary probe gets deleted the moment
a fix looks like it worked, and then the next regression is invisible again —
which is the exact history of `8fa0c910` (the #283 instrumentation PR, explicitly
labelled "REMOVE once root cause is fixed", and duly removed). The journal is
small, metadata-only, always-on, and bounded. Throwaway probes are welcome *on
top of* it, not instead of it.

---

## 1. A and D

### A — what exists and is trusted

| Thing | Where | Trust |
|---|---|---|
| `SessionManager.recover()` atomicity | `src/main/sessionManager.ts` | **Trusted.** Synchronous claim, typed conflict, kill-cancels. #548's ownership model is correct and is not being re-litigated. |
| Persisted local `SessionId` as ownership key | `rehydrate.ts:100-120` | **Trusted.** Stable across restart; provider id is a launch hint only. |
| `SessionInputReadiness` level + monotonic revision | `sessionManager.ts:453-468` | **Trusted as a transport.** The revision ordering is sound. |
| `derivePromptGateState` reason vocabulary | `claudeSession.ts:744-783` | **Trusted as a computation.** Its scars are documented and real (the removed 10s staleness bound). It is not trusted as *complete* — see Unknowns. |
| `SessionFeed` nine-channel contract | `src/shared/sessionFeed/` | **Trusted.** The journal will not open its own subscriptions. |
| `AppRunJournal` writer + run manifest | `src/main/incident/` | **Trusted as a substrate.** Bounded, redacting, run-scoped. The boot journal should reuse it, not invent a second one. |
| Redaction discipline | `@shared/performance/serialization`, the rendering redactor | **Trusted.** Hard-gated. Reused verbatim. |
| The three-ledger diagnosis | `docs/superpowers/plans/2026-07-16-session-recovery-reconciliation.md` §"Why this plan exists" | **Trusted.** Still the correct model of the problem. |

### D — the end state

1. When an agent is slow or stuck at boot, **the pane says which phase it is in
   and for how long** — not "agent failed to start."
2. Any boot failure the user hits is **reproducible from a recorded artifact**
   without asking them to reproduce it.
3. Every observed stall shape has **a name, a frequency, and a fixture**.
4. The lifecycle has **one arbiter with a recorded decision per transition**, in
   the shape rendering's ownership ledger has — `debug output is a serialization
   of the same decision the code acted on, never a second derivation`.
5. Cold boot of a realistic workspace has a **measured** time budget, and the
   fan-out is shaped by that measurement rather than by `Promise.all`.
6. `Timed out waiting for agent to become ready for input` is either gone or
   carries the reason it timed out.

**D is not "boot is fast."** D is "boot is *observable*, and every failure is a
named shape with a fixture." Speed follows from knowing where the time goes; it
cannot precede it.

---

## 2. The stages

### Stage 1 — The boot journal ✅ SHIPPED

- [x] **Produces:** `~/.config/agent-code/boot/<runId>.jsonl` — one append-only,
  metadata-only, bounded record per app run, containing every session-lifecycle
  transition from all three processes on one clock:
  `rehydrate.start/complete`, `recover.request/claim/adopt/spawn/conflict/cancel/fail`,
  `provider.start.begin/end`, `proxy.up`, `mcp.register`, `tail.attach`,
  `replay.quiesce`, `gate.<state>/<reason>` **on every evaluation, not only on
  transition**, `history.load.start/end`, `first-paint`, `wake.request` with its
  caller, `kill` with its cause, `timeout.fire`. Each carries `runId`,
  `sessionId`, `kind`, monotonic ms, and phase-relative elapsed.
  Plus a paired reader: `Save Boot Journal` command and a `scripts/` summarizer
  that prints one line per session — the phase ladder and where it stopped.
- [x] **Verified by:** boot the app with a known workspace; the journal must
  account for every visible pane with a monotonically ordered ladder and no
  gaps. Independently checkable: the ladder's terminal event must match what the
  pane visibly did. It needs no later stage to be judged correct — either it
  explains the boot you just watched, or it does not.
- [x] **Why separate:** if this lands with a fix, the fix defines what gets
  recorded, and we will only record the phases the fix's author already believed
  in. Recording must be authored by someone who does not yet know the answer.
  This is also the stage that survives every future regression, which a fix does
  not.
- [x] **Reality check:** built against the *existing* call sites listed in §0 —
  every event name above corresponds to a line that already executes today. No
  new lifecycle is invented here; this stage only makes the existing one legible.

**Always on. No env flag.** Rationale: `AGENT_CODE_PERF` and
`AGENT_CODE_SESSION_RECORD` are both off by default, which is why we have zero
recordings of a failure that happens daily. Bounded by the existing
`AGENT_CODE_DEBUG_MAX_GB` / TTL sweeper.

### Stage 2 — The pane tells the truth ✅ SHIPPED (with one gap, stated)

> **Gap:** the pane shows the COARSE reason. Claude's detailed verdict
> (`replay-pending` / `composer-unpainted` / `human-draft`) is collapsed to
> `provider-not-ready` before it leaves main, and recovering it means widening
> the `SessionInputReadiness` contract — Tier 3 transport this PR does not
> touch (§4). The detail is recorded in `gate.eval` meanwhile. Whether to widen
> that contract is a Stage 4 decision, made from the corpus.

- [x] **Produces:** the composer/pane surfaces the live gate reason and elapsed
  time — `Replaying transcript… 4s`, `Waiting for composer… 38s`,
  `Permission prompt on screen`, `Draft in composer` — sourced from
  `SessionInputReadiness.reason`, which already crosses the wire and is currently
  discarded. Plus: failure toasts carry reason + session id + phase.
- [x] **Verified by:** with Stage 1's journal open beside the app, the on-screen
  reason must match the journal's current gate state at all times. Any divergence
  is a bug in this stage, and the journal is the referee.
- [x] **Why separate:** this is what converts *your* future bug reports from "it
  didn't start" into "it sat at composer-unpainted for 90s" — which is the input
  Stage 3 needs. Merged into a fix, it becomes a cosmetic afterthought and gets
  cut for scope.
- [x] **Reality check:** the reason strings already exist and are already
  computed (`claudeSession.ts:744-783`, `codexSession.ts`, opencode). This stage
  transports and renders; it invents no new state.

**This is a diagnostic, not a fix.** It changes no gate logic.

### Stage 3 — The corpus

- [ ] **Produces:** `testing/fixtures/boot-journals/` — real recorded boots with
  frequencies, deliberately spanning: cold start after quit · renderer reload ·
  cold start after crash · 1 pane · ~5 panes · ~15 panes · Claude-only ·
  Codex-only · mixed · with and without worktrees · a boot that was fast · every
  boot that was slow or stuck. Target: **enough runs that the slow/stuck shapes
  repeat**, not a fixed count.
- [ ] **Verified by:** replayable — a journal in this directory, fed to Stage 1's
  summarizer, reproduces the same phase ladder every time. Redaction hard-gated:
  the extractor refuses to emit a fixture containing a sensitive value, mirroring
  `scripts/extract-rendering-fixtures.mjs`.
- [ ] **Why separate:** this is the stage that requires *you*, and calendar time,
  and normal use. It cannot be compressed or simulated. Any stage that depends on
  it and is attempted early will be built against imagined cases — the 40%
  mechanism.
- [ ] **Reality check:** it is nothing but recordings. That is the whole point.

### Stage 4 — The catalog

- [ ] **Produces:** `docs/decomposition/evidence/boot-shapes/catalog.md` — every
  distinct stall/failure shape observed in Stage 3, each with: a name, its
  frequency, the exact phase it stalls in, which providers exhibit it, and the
  fixture that contains it. Plus a machine-readable classifier that maps a
  journal to a shape.
- [ ] **Verified by:** every run in the corpus classifies into exactly one shape,
  with **zero `unknown`**. An unclassifiable run means the catalog is incomplete
  and Stage 3 needs more recording — not that the run should be discarded.
- [ ] **Why separate:** the catalog is where "the agent takes minutes to start"
  stops being one complaint and becomes N distinct engineering problems with
  known frequencies. Merged into implementation, we would fix the shape that was
  most recently in context and ship 40%.
- [ ] **Reality check:** derived only from Stage 3 recordings. A shape that was
  never observed does not enter the catalog, however plausible.

### Stage 5 — The replay harness and its invariants

- [ ] **Produces:** a pure `bootJournal → SessionLifecycle[]` replay plus
  machine-checked invariants asserted at every event, needing no expected output.
  Candidate invariants, to be confirmed by the catalog: every visible pane reaches
  a terminal outcome · exactly one process per local id · no kill of a backend
  this call adopted · no readiness silence exceeding a corpus-derived bound ·
  every `wake.request` names a caller · no gate evaluation without a reason.
- [ ] **Verified by:** replaying the whole corpus. Known-good boots pass; every
  catalogued bad shape trips a specific named invariant. An invariant no recorded
  run can trip is not evidence — it is decoration, and gets deleted.
- [ ] **Why separate:** this is the permanent regression net. Built after the
  fixes, it would be written to pass them — the 481-of-481 vanity-metric failure.
  Built here, against real recordings, it is written to catch them.
- [ ] **Reality check:** every invariant traces to a shape in the Stage 4 catalog
  or it does not ship.

### Stage 6+ — Fix one catalogued shape at a time

- [ ] **Produces:** one PR per shape, highest-frequency first. Each begins with a
  failing assertion against the fixture that contains it.
- [ ] **Verified by:** the fixture goes green, the rest of the corpus does not
  regress, no invariant weakens.
- [ ] **Why separate:** one shape per PR is what makes a regression attributable.
  #548 fixed several at once and shipped #596, #598, #590, and #606 behind it.
- [ ] **Reality check:** no shape gets a fix before it has a fixture. **A second
  conditional added to an existing gate means the substrate is wrong — stop and
  revise this document.**

Whether the endpoint is "a lifecycle arbiter in the shape of the render ledger"
is **deliberately not decided here.** The catalog decides it. If the shapes are
independent, they get independent fixes. If they are the same ownership
disagreement wearing six hats, that is the evidence that justifies an arbiter —
and only then.

---

## 3. The file census — what actually touches this

Measured, not estimated. Union of the lifecycle symbols
(`recoverSession` · `SessionRecover*` · `inputReady` · `SessionInputReadiness` ·
`input-readiness` · `promptGate` · `PromptGateState` · `isPromptAcceptanceReady` ·
`rehydrateWorkspace` · `commitRehydratedState` · `bootstrapComplete` ·
`WorkspaceRestoreStatus` · `ensureSessionLive` · `waitForSessionInputReady` ·
`spawnSession` · `SessionSpawnOptions` · `preferredSessionId` ·
`spawningSessionIds` · `loadInitialHistoryForSession` · `recoverTmuxName` ·
`seedResumedRuntimeFields` · `killSessionBackendIfOwned`), tests excluded:

> **46 production files · 23,459 LOC.**
> The top six files carry **145 of ~280** total references.
> **`refs`** = symbol occurrences (entanglement density).
> **`X`** = file also owns unrelated concerns (a refactor here is a *split*, not a move).

### Tier 1 — Deciders. **This is the arbiter's future body.**

Files that make ownership / readiness / lifecycle *decisions* today. Isolating
these is the whole point of the exercise.

| refs | LOC | X | File | What it decides |
|---:|---:|:-:|---|---|
| 44 | 1267 | | `renderer/workspace/hook/actions/session.ts` | `ensureSessionLive`, `waitForSessionInputReady` (30s), `killSessionBackendIfOwned`, `replaceSession`, `reloadAgentSessions`. **The single most entangled file in the subsystem.** #596 and #598 both live here. |
| 28 | 806 | | `renderer/workspace/hook/persistence/rehydrate.ts` | Restore orchestration, the 30s per-session deadline, `Promise.all` fan-out (`:588`), unknown-kind policy, MCP domain threading. |
| 24 | 2057 | X | `main/sessionManager.ts` | `recover()`, recovery claims, `spawningSessionIds`, readiness cache + revision, kill/cancel. Also owns PTY attach/detach, tmux, screens, paste — **split candidate**. |
| 17 | 969 | X | `renderer/workspace/hook/index.ts` | Wires wake into MCP/orchestration request handling. Also the workspace god-hook. |
| 6 | 231 | | `renderer/workspace/hook/persistence/useBootstrap.ts` | `WorkspaceRestoreStatus`, when restore is "complete". |
| 5 | 230 | | `renderer/workspace/providerSessionIdentity.ts` | `resumableProviderSessionId`, `seedResumedRuntimeFields`, provisional-id policy. |
| 5 | 147 | | `renderer/workspace/hook/persistence/useAutoSave.ts` | Gates autosave on restore completion. |
| — | — | | `renderer/workspace/hook/persistence/recoveryProjection.ts` | Pure leaf→outcome projection (already extracted by #548 — **the one piece that is already the right shape**). |
| — | — | | `renderer/workspace/sessionOwnership.ts`, `idRemap.ts` | Owned vs live-process id sets (#258's fix), residual remap. |

### Tier 2 — Provider attesters. **Three implementations that must agree.**

| refs | LOC | File | Readiness model |
|---:|---:|---|---|
| 26 | 1108 | `providers/claude/runtime/claudeSession.ts` | `derivePromptGateState` — re-derived continuously; 250ms replay quiet window; `blocked`/`occupied`/`warming`/`ready`. **Emits only on transition (`:785`) — the silence bug.** |
| 6 | 622 | `providers/codex/runtime/codexSession.ts` | Latches ready on first composer sighting; resets only on exit. |
| 3 | 468 | `providers/opencode/runtime/opencodeSession.ts` | Ready when the server is up. |
| 1 | 317 | `providers/claude/runtime/promptDelivery.ts` | Per-delivery acceptance gate (+ Codex's equivalent). |

**The asymmetry is the risk.** Claude can go ready→not-ready→ready; Codex cannot.
Any invariant written against one provider is wrong for the other. The catalog
must record shapes **per provider**.

### Tier 3 — Transport. **Thin, correct, must stay thin.**

Carry the readiness fact; decide nothing. Do not grow these.

`shared/types/session.ts` (12/482) · `preload/api/session.ts` (11/265) ·
`shared/sessionFeed/{SessionFeed,types,SessionFeed.contract}.ts` ·
`main/ipc/session.ts` · `main/sessions/forwarder.ts` ·
`features/sessionFeed/{Ipc,Fake}SessionFeed.ts` ·
`remote-client/{WebSocketSessionFeed,wire}.ts` ·
`main/remote/{RemoteServer,SessionFeedSource,protocol/messages}.ts` ·
`preload/api/{types,index,provider}.ts`

### Tier 4 — Consumers that currently **decide**, and must stop

This tier is the "too intertwined" problem in concrete form. Each of these reads
a readiness fact and then makes its own lifecycle decision — which is exactly the
distributed-ownership pattern the render ledger was built to end.

| refs | LOC | X | File | The decision it should not be making |
|---:|---:|:-:|---|---|
| 10 | 879 | X | `workspace/tile-tree/TileLeaf.tsx` | `send()` wakes on `!inputReady` — **caused #598** (a live condition *is* not-ready, so every modal click took the wake path). |
| 10 | 392 | | `workspace/tile-tree/AgentTerminalLeaf.tsx` | Mount-time unconditional wake — **caused #596**. Now carries an `adopted` vs `spawned` conditional, i.e. the second conditional the skill warns about. |
| 9 | 2186 | X | `workspace/hook/actions/pane.ts` | Three separate wake sites inside a pane-layout file. |
| 6 | 498 | | `workspace/tile-tree/TerminalLeaf.tsx` | Its own wake, near-parallel to `AgentTerminalLeaf` but not identical (documented asymmetry in the #597 plan). |
| 4 | 309 | | `workspace/hook/actions/undoClose.ts` | Revive semantics. |
| 3 | 266 | | `workspace/hook/actions/providerSwitchCore.ts` | Wake-before-switch — **#590**. |
| 3 | 2316 | X | `workspace/hook/ipc/useIpcSubscriptions.ts` | Ingest orchestrator that also applies readiness revisions. |
| 2 | 94 | | `workspace/hook/actions/agentIndexNavigation.ts` | Wakes on navigate. |
| 2 | 742 | X | `session-runtime/state.ts` | Holds `inputReady` on the runtime. |
| 2 | 30 | | `workspace/tile-tree/TileLeaf/readiness.ts` | Produces `'agent failed to start'` — **the reasonless string**. |
| 1 | 762 | X | `workspace/orchestrationMcp.ts` | Waits on readiness before dispatching child prompts — **#567**. |
| 1 | 444 | X | `workspace/agentManagementMcp.ts` | Same, via the management surface. |
| 1 | 623 | X | `tile-tree/TileLeaf/useComposerKeybinds.ts` | Composer-level readiness branch. |
| 1 | 114 | | `tile-tree/TileLeaf/ComposerActions.tsx` | Deliberate failed/exited wake path. |

**Nine distinct wake call sites across seven files.** Every past incident is one
of them behaving differently from the others. **Target: one.**

### Tier 5 — Observers (read-only, correct as-is)

`features/debug/ui/DebugPanel.tsx` · `features/debug/ui/DevDebugPanel.tsx`

### Tier 6 — Word collisions. **Explicitly out of scope — do not chase.**

These match `rehydrate` but have nothing to do with session boot. Listed so the
next agent does not waste a pass on them:

`features/global-editor/{ui/GlobalEditorShell.tsx,store.ts,lib/globalEditorPersistence.ts}`
(the editor's own `rehydratedCwdsRef` / store rehydrate) ·
`features/reply-to-selection/lib/selectionStash.ts` ·
`main/storage/debugRetention.ts` · `workspace/tile-tree/paneLabels.ts` ·
`workspace/dispatch/tiledDispatchSelectors.ts` ·
`workspace/tile-tree/useKeybinds.ts` (comments only).

> **Naming debt worth fixing on the way past:** "rehydrate" means at least three
> unrelated things in this codebase (session restore, editor state, Zustand
> persist). A grep for it returns 63 files; only 46 are real, and the 17 false
> positives are the kind of thing that silently pads an agent's context and
> dilutes its attention. Renaming session restore to something unambiguous is a
> cheap, in-blast-radius cleanup.

### What the census tells us before any recording starts

1. **The problem is not size, it is placement.** 23k LOC is not unreasonable for
   multi-provider process lifecycle. Nine wake sites is.
2. **Six files hold the decisions; forty hold the consequences.** Tier 1 + the
   Claude runtime is ~6,400 LOC. That is a tractable arbiter.
3. **Four Tier-1/4 files exceed 2,000 LOC and own unrelated concerns**
   (`sessionManager.ts`, `pane.ts`, `useIpcSubscriptions.ts`, `hook/index.ts`).
   Any change here is a split, not a move — and splitting them **before** the
   catalog exists would be refactoring blind. **Stage 6+, not now.**
4. **The transport layer (Tier 3) is already right.** #548 built it correctly.
   Nothing in this plan should touch it, and any proposal that does is a signal
   the proposal is wrong.

---

## 4. What is being isolated

**The hard part is not spawning a process. It is arbitrating boot-time truth
between three ledgers plus three providers** — the same shape as rendering's
distributed-ownership problem, and currently distributed across ~8,500 lines of
`rehydrate.ts` + `session.ts` + `useIpcSubscriptions.ts` + `sessionManager.ts` +
three provider runtimes.

- **`src/shared/boot/`** — the event vocabulary and the pure lifecycle model.
  No I/O, no Electron, no React.
- **`src/main/boot/`** — the journal writer. Single consumer. Reuses
  `AppRunJournal`'s file/rotation/redaction substrate rather than inventing a
  second one.
- **Forbidden imports:** `rendering/` must never import `boot/` — it does not
  need to, and the one-way `session-runtime/ → rendering/ → features/feed/`
  layering must not gain a fourth edge. `boot/` must never import
  `features/`. The journal must never be a *decider* — if a fix needs the
  journal's state to make a runtime decision, that is the signal that the
  arbiter belongs in `shared/boot/` as real state, with the journal as its
  serialization. Same rule as rendering's P4: **debug output is a serialization
  of the decision, never a second derivation.**

### The rule that keeps the census from becoming a refactor

**Stages 1–5 add files. They do not move or split any file in §3.**

It is tempting to read the census as a to-do list — nine wake sites, four
oversized files, collapse them. Do not. Every one of those consolidations is a
guess about which behaviours are equivalent, and #596/#598 are what happens when
that guess is wrong. Stage 1 instruments the nine wake sites *as they are*, so
the corpus can tell us which of them actually behave differently. **The census is
the map of what to record, not the list of what to change.**

Concretely, per tier:

| Tier | Stages 1–5 may | Stage 6+ may |
|---|---|---|
| 1 Deciders | add journal emit calls at existing decision points | become the arbiter |
| 2 Providers | emit every gate evaluation, not just transitions | unify the readiness model *if* the catalog proves the asymmetry is a bug and not a requirement |
| 3 Transport | **nothing** | **nothing** |
| 4 Consumers | emit `wake.request` with its caller identity | collapse toward one wake site, one shape at a time, each with a fixture |
| 5 Observers | render the reason (Stage 2) | — |
| 6 Collisions | rename, opportunistically | — |

---

## 5. Unknowns

Not one of these can be answered by reading code. Every previous attempt answered
them by assumption.

1. **Why is the composer `unpainted` or `drafted` at boot?** This is the prime
   suspect for "cannot submit at the start" — `derivePromptGateState` returns
   `warming/composer-unpainted` or `occupied/human-draft` and emits nothing
   further. Is the TUI genuinely not painted, or is the classifier misreading a
   painted screen under load? **Unknown. Nothing has ever recorded it.**
2. **Where do the "minutes" actually go?** Candidates: `Promise.all` fan-out
   contention · provider process startup · proxy/mitmdump spawn · MCP
   registration · transcript history load · TUI paint under CPU pressure. No
   breakdown has ever been measured. Assuming it is concurrency would be exactly
   the mistake this document exists to prevent.
3. **Does the 30s recovery deadline ever fire?** Or does the pane sit
   indefinitely at not-ready with the deadline never reached, which looks
   identical to the user but is a different bug in a different file.
4. **Is this per-provider?** Codex latches ready on first composer sighting;
   Claude re-derives continuously. That asymmetry predicts different shapes.
   Untested.
5. **Does it scale with pane count?** #258's fork bomb says load matters; nothing
   has measured the knee.
6. **Cold start vs renderer reload — same shape or different?** They take
   different paths (`spawned` vs `adopted`) and #596 proved they behave
   differently under the same code.
7. **Is the wedged-provider class from #597's accepted cost now showing up?**
   `lifecycle: 'live'` ≠ healthy: a provider that registers then wedges is now
   adopted-and-skipped with **no in-app retry**. That was accepted in writing on
   2026-07-22 and nothing replaced #548's self-heal. This is a live candidate for
   "I cannot submit and I have to force a restart" — **and it would present
   exactly as described.** Unconfirmed.
8. **How much of the pain is the 120×40 TUI resize** (`detachAgentPty`, deferred
   from #596) rather than boot at all? Different bug, same felt experience.

If any of these are answered before Stage 3 completes, they were guessed.

---

## 6. Fixture plan

| | |
|---|---|
| **Where real data comes from** | Stage 1's boot journal, always on, from your normal daily use. |
| **Which stage produces it** | Stage 1 emits, Stage 3 collects and redacts into `testing/fixtures/boot-journals/`. |
| **Extraction** | `scripts/extract-boot-journals.mts`, modelled on `extract-rendering-recordings.mjs`, with the same **hard-gated** redactor — it refuses to emit a fixture containing a sensitive value rather than best-effort scrubbing. |
| **Never recorded** | prompts, assistant text, tool payloads, file contents, commands, MCP tokens, credentials. Metadata only: ids, kinds, phases, reasons, timestamps, counts. |
| **Test authorship rule** | Assertions are written **before** the fix, against a recorded fixture. A test written after a fix, from imagined input, is a vanity metric — `docs/decomposition/claude-queue-reconciliation.md` and the rendering principles both say this, and the 481-of-481 case is the proof. |
| **Human judgement required** | What *should* own readiness when the composer holds a draft and a prompt is queued? What *should* happen when a provider registers but never paints? These are product semantics, not derivable from the corpus. They will be asked, not invented. |

---

## 7. What this costs, honestly

Stages 1 and 2 are days, not weeks, and they are the ones that immediately change
your daily experience — the pane stops lying to you. Stage 3 is calendar time and
mostly your normal use. Stages 4–6 cannot be scheduled until the catalog exists,
which is the point: **we do not currently know how many problems we have.**

The alternative is a thirty-first patch.
