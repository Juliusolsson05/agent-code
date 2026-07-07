# Session Recording — plan (2026-07-07)

Continuous, debug-gated capture of a session's rendering-pipeline **input
stream**, replayable deterministically through the real pipeline in the
test suite. GitHub issue: #467.

This plan is the synthesis of four research sweeps (full reports in
`research-2026-07/rec-research-{seam,precedent,tap,priorart}.md`): the
replay seam, the existing corpus/journal machinery to reuse, the IPC tap
point, and prior art + the OOM constraints a continuous recorder must
respect.

---

## 0. Why this exists — and why NOW

The rendering rewrite is validated three ways today: unit tests, hand-built
e2e fixtures, and the **bundle corpus** (46 real debug bundles replayed
against recorded legacy output). The corpus has been the single most
valuable safety net — it caught 4 real pipeline bugs. But the live soak
(2026-07-07) exposed its two structural blind spots, and both were predicted
in the rewrite plan:

1. **A bundle is one frozen tick.** It captures runtime state at the moment
   of the "save debug logs" click, not the *sequence* of events that
   produced the bug. The soak's queue-desync bug (#469) only exists across
   several ticks — a prompt enqueues, a notification parks, a dequeue drops
   the wrong item — and could only be *reconstructed and guessed at* from a
   single snapshot, never replayed.

2. **The corpus is old-renderer-only.** Every bundle was captured under the
   legacy renderer, so it validates "new engine agrees with old engine on
   states the old engine produced." It structurally cannot catch a bug that
   only appears in states the **new pipeline itself drives live** — exactly
   the class the soak is turning up (the collapsed-running regression #465,
   the queue reconstruction #469).

The rewrite plan's Stage 2 (§5) already promised the fix and it was never
built. Verbatim:

> - every divergence auto-captures a minimized fixture draft (inputs + both
>   outputs) into the debug bundle
> - the ledger's invariant WARNINGS run live (dual-render,
>   vanish-without-replacement, unexplained shrink)

What actually shipped (`shadow/useRenderShadow.ts`) only writes a 50-entry
`globalThis.__agentCodeRenderShadow` console ring, copied out by hand — and
it is DELETE-fated at Stage 3 cutover (there is no second renderer to diff
against once the legacy one is gone). **Session Recording is the fuller,
cutover-surviving realization of that Stage-2 promise:** capture the full
input *stream* (not a diff snapshot), replay every tick through the real
pipeline, assert invariants at each tick — and unlike shadow, it needs no
legacy renderer, so it is the permanent regression net after cutover.

The loop it closes: **new-engine bug on screen → it was already being
recorded → the recording becomes a checked-in fixture → it can never
regress.** No more "save a bundle and hope we can reconstruct the tick."

---

## 0b. As-built reconciliation (2026-07-07, post-audit)

The sections below are the ORIGINAL design. Two intentional deviations and
one honest limitation were found by a plan-vs-code audit after the feature
merged (#471, #472) and the on-demand fix (#473). Recorded here so the plan
never silently drifts from the code:

- **Record shape is a FOLDER per recording, not one flat `<sid>/<ts>.jsonl`
  (supersedes §3's file layout).** `session-recordings/<recordingId>/` holds
  `meta.json` + `events.jsonl`. This was a deliberate change at the user's
  request: one `rm -rf` deletes exactly one recording. `meta.json` carries the
  full header (`kind:'session-recording'`, `redaction:'none'`, provider,
  providerSessionId, cwd, appVersion, start/end, counters) — so §3's "header
  line" requirement is met by `meta.json`, not a line 0 in the event stream.
  provider/cwd are filled from `session:started`; providerSessionId stays
  best-effort (it is provisional and upgraded later, §2).

- **Recording is COMMAND-DRIVEN, not auto (this is §7 as written; the first
  build wrongly shipped auto-only).** Nothing records until the **Toggle
  Session Recording** command starts a specific pane. `AGENT_CODE_SESSION_
  RECORD=1` is the OPTIONAL auto-start-everything power flag for unattended
  soak, OFF by default. Fixed in #473.

- **Replay is REDUCER-FAITHFUL, not full-React-fold (a real limitation of
  §1/§6, not yet closed).** `replayRecording` drives the real leaf reducers
  (`foldSemanticEvent`, `reduceStreamPhase`, ghost reducers, provider
  mappers) via `reconstructSlices`, but NOT the React fold hook
  (`useIpcSubscriptions`) — that hook only runs under the happy-dom `renderer`
  vitest project, and the replay/invariant tests run under the node `unit`
  project. So the harness catches leaf-reducer + adapter + ledger bugs, but
  NOT the fold-glue bug class (queue-op reconstruction #469, provider-id
  quarantine, optimistic reconciliation, orphan sweep) that §1 cited as the
  reason to tap the SessionFeed boundary. The RECORDING captures everything
  needed to replay those (the 9 channels are the fold's inputs); only the
  REPLAY is currently blind to them. Closing this needs the fold extracted
  from the React hook into a pure reducer the replay can drive — tracked as a
  follow-up, naturally converging with the #394 fold rewrite. Until then the
  harness is honestly labeled reducer-only in `recordedSession.ts`.

Smaller open follow-ups (non-blocking): a dedicated keybinding for the note
command (§7b); finalize on `SessionManager 'removed'` in addition to the
`session:exit` observer (§2); `shapePathsOf` reuse in redaction envelope
metadata (§5).

---

## 1. The core decision — record at the SessionFeed boundary, replay through the real fold

The single most important design choice, and the one the four sweeps
converged on after initially disagreeing.

### Two candidate tap points

- **Option A — tap the ledger input** (`view/useLedgerFeedItems.ts`, record
  `RuntimeLedgerSlices` per tick). Closest to the pipeline; the corpus
  already proves this shape replays. **Fatal gap: it sits *below* the fold.**
  The queue-reconstruction bug (#469) lived in `useIpcSubscriptions`
  (the fold), *above* the ledger seam — a recorder tapped here would have
  been structurally blind to the exact bug that motivated this feature.

- **Option B — tap the SessionFeed boundary** (main process, the 9 IPC
  channels that carry every rendering event), replay through a
  `RecordedSessionFeed` that drives the **real fold reducers → real
  `SessionRuntime` → real pipeline**. Captures the *full stack*, fold bugs
  included.

### Why B wins, decisively

The objection to B is coupling: the fold (`useIpcSubscriptions`, 1985 lines)
is churning code (the #394 provider refactor is rewriting it). But **B does
not couple to the fold internals — it couples to the `SessionFeed`
interface**, which is the *stable* neutral-hub contract (`shared/sessionFeed/
types.ts`, 9 methods: started, screen, jsonl-entries, jsonl-error,
semantic-event, conditions, process-state, sub-agents, exit). The fold can
be rewritten wholesale and old recordings still replay through the new fold,
because they speak the interface, not the implementation.

And B is strictly more powerful: it catches everything A catches **plus**
fold-layer bugs (queue reconciliation, ghost sweep timing, optimistic
handoff, provider-id quarantine) — the bugs that live between "IPC event
arrived" and "ledger input assembled." The soak proved those are real and
common.

**Decision: record the 9 SessionFeed channels in the main process; replay
through a `RecordedSessionFeed implements SessionFeed` that feeds the real
fold.** This mirrors the existing `FakeSessionFeed` test double — the
interface was *built* to be swappable, so the replay harness is a
natural fit, not a hack.

---

## 2. Where the recorder taps (main process)

### The chokepoint
Every rendering-relevant event converges at **`sendToMainWindow(channel,
...args)` — `src/main/window/mainWindow.ts:73`**, whose own comment calls it
"the ONE place the rest of main/ should reach into the BrowserWindow."

Flow: provider runtimes → `SessionManager.emit` (`sessionManager.ts`) →
`wireSessionForwarder` (`src/main/sessions/forwarder.ts`, wired at
`index.ts:513`) → `sendToMainWindow` → renderer `SessionFeed`.

One wrinkle: `session:jsonl-entries` is a **bulk** payload flushed from the
coalescer (`jsonlCoalescer.ts:57`), not sent by the forwarder directly. The
funnel sees both the forwarder sends and the coalescer flush, so tapping at
the funnel captures exactly what the renderer receives.

### The tap
`SessionRecorderManager`, constructed once in `forwarder.ts` beside
`SubAgentWatcherManager`. It observes the **9-channel allowlist** (explicit
list, NOT the `session:` prefix — that prefix also carries
`session:terminal-data` / `session:agent-pty-data`, raw PTY that is NOT a
feed event and must never be recorded). The cleanest implementation:
intercept inside the forwarder where it already fans events to
`sendToMainWindow` + `subAgents.stop` + `flushAndDropJsonl`
(`forwarder.ts:74-75`), so the recorder sees the identical payloads the
renderer will.

### Main vs renderer — settled: MAIN
The renderer **never writes disk directly** — feed-debug
(`ipcRenderer.invoke('debug:append-feed-log')`), ghosts (`ghost:append`),
and bundles (`debug:save-bundle`) all round-trip to a main handler that owns
the `fs` call. A renderer recorder would push the same 9 events back to main
over IPC for zero completeness gain. Main is the natural file-write context,
sees the exact post-coalesce payloads, and survives a renderer crash.

### Lifecycle — mirror the watcher registries
`SessionRecorderManager` owns `Map<sessionId, SessionRecorder>`; each
recorder is a per-session append-only JSONL. Ensure-on-first-event; `stop`
on `manager.on('removed')` (exactly where the forwarder already stops
subagents + flushes jsonl); `flushAll` on app quit. This is the proven
`SubAgentWatcherManager` / `GhostJournalRegistry` lifecycle shape — do not
invent a new one.

### Keying — sessionId, one file per session
Key files on internal **`sessionId`** (stable for the pane). Do NOT key on
`providerSessionId` — `providerSessionIdentity.ts` shows it is provisional
and gets upgraded/replaced (proxy-header → jsonl-entry → resume). Record
`providerSessionId` (and provider kind) in the file **header** instead.
Every funnel payload carries `sessionId`, so partitioning tiled multi-session
recording is free.

---

## 3. Record format

### File
`<userData>/session-recordings/<sessionId>/<start-ts>.jsonl`, append-only,
one file per session per app-run. `0o600`.

### Line 0 — header (the schema-version line no current JSONL has)
```json
{"v":1,"kind":"session-recording","sessionId":"...","provider":"claude",
 "providerSessionId":"...","cwd":"...","appVersion":"...","startedAtWall":123,
 "redaction":"none|redacted"}
```

### Subsequent lines — one event each
```json
{"t":<monotonic-ms-since-start>,"wall":<Date.now()>,"ch":"session:semantic-event","payload":{...}}
```
- `ch` is one of the 9 allowlisted channels.
- `payload` is the channel's payload **verbatim** (post-coalesce for
  jsonl-entries). Full table of the 9 channel shapes:
  `research-2026-07/rec-research-tap.md`.
- `t` (monotonic) drives replay ordering; `wall` is injected as the fold's
  clock during replay so wall-clock-dependent fold behavior (the orphan
  sweep, `unreadSince`/phase stamps) is deterministic. The ledger itself is
  pure over payload + entry.timestamp and needs no injected time.

### Writer — clone `feedDebugLog.ts` (every #388 lesson already baked in)
`src/main/storage/feedDebugLog.ts` is the near-perfect template: debug-gated,
per-session append-only JSONL, **128 MiB cap + tombstone (not rotation)**,
serialized write queue, id-dedup, fail-CLOSED stat, retention hook. Clone
its structure; `ghostJournal.ts` supplies the 100ms batched-drain +
overlapping-drain guard + `flush()`-on-quit barrier + streaming per-line
read with torn-tail tolerance.

---

## 4. Backpressure & retention — NON-NEGOTIABLE (incident #388)

A continuous recorder streaming every event re-opens the exact wound that
crashed the app on 2026-07-04 (#388: heap 39 MB → 2554 MB in ~15 s;
`ipc.handle.debug:append-feed-log` dominated the crash; uncapped 60-300 MB
feed-debug files). #388 explicitly **deferred IPC backpressure as the unbuilt
root fix.** This feature must ship it from day one, per the canonical rulebook
`docs/plans_and_ideas/2026-06-25-performance-incident-journal-plan.md`
("Retention and Backpressure"):

- **Recording is MAIN-side** (§1), so there is no renderer→main IPC per
  event — this already sidesteps #388's specific IPC-flood vector. But the
  disk write path still needs discipline:
  - Single write in flight; pending queue hard cap (2000); **drop-oldest +
    increment a `dropped` counter** written into the file as a tombstone
    line when the cap is hit (never block the session, never unbounded-buffer).
  - `unref()` all timers.
  - Per-file 128 MiB cap + tombstone (inherited from `feedDebugLog`).
- **Register `session-recordings/` as a budgeted bucket in
  `debugRetention.ts`** (`scheduleDebugStoragePrune`: 3%-of-disk budget,
  48h TTL, per-bucket cap). MEMORY.md is explicit that
  `feed-debug/debug-bundles/proxy/performance` are unbounded OOM/disk-panic
  sources; `session-recordings/` must NOT join that list. The #467 "unbounded,
  document caveat" note is insufficient — it must be a real budgeted bucket.
- **Never store the heavy artifacts inline.** The journal rulebook's non-goal
  (line 32): no raw PTY, no proxy/IPC bodies, no full transcript contents in
  an always-on log. Our 9 channels are the *semantic input layer*, which is
  the right altitude — but `jsonl-entries` payloads DO carry full tool
  args/results/file contents. See §5 (redaction) and §6 (large-artifact
  policy) for how those are bounded.
- **Record on event arrival, never on a hi-frequency tick** (#390): the
  recorder is edge-triggered by the 9 channels, so it is naturally
  event-paced.

---

## 5. Redaction — the biggest new engineering

A recording captures full input text — tool arguments, tool results, file
contents, user prompts — far more sensitive than anything the codebase
records today (the corpus caps snippets at 360 chars; `unknowns.ts` stores
only shape-paths, never values). Two-tier model, mirroring how bundle
fixtures already work:

1. **Full local recordings** (`session-recordings/`): unredacted, `0o600`,
   gitignored, budget-retained, **never checked in** — the diagnostic
   artifact you replay locally to reproduce a bug. Same trust level as the
   raw debug bundles already on disk.

2. **Checked-in fixtures** (`testing/fixtures/rendering-recordings/`): a
   **minimized + redacted derivative**, produced by an extraction script
   (the successor to `extract-rendering-fixtures.mjs`). This is what the CI
   replay suite runs.

The redaction pass (new code, the one genuinely novel piece):
- Reuse `unknowns.ts` `SENSITIVE_KEY = /authorization|api[-_]?key|token|
  secret|cookie|password/i` and `shapePathsOf` for envelope metadata.
- A dedicated payload pass for the input text: truncate tool
  args/results/file bodies to a cap (reuse the corpus's 360/600/8000 tiers),
  and offer a "structure-only" mode that keeps shapes + lengths + the fields
  the pipeline actually keys on (message ids, tool_use ids, timestamps,
  turn ids, block kinds, `status`) while dropping free-text bodies. The
  pipeline's ownership/ordering decisions key on *identity and structure*,
  not on prose content — so a structure-only recording still exercises every
  ownership/ordering rule while carrying almost no sensitive data.
- Minimization: drop channels/fields the pipeline provably ignores
  (`rec-research-seam.md` proved `subAgents`/`queuedMessages` don't feed the
  ledger — but they DO feed the fold, so a full-stack recording keeps them;
  the *structure-only* derivative can drop screen strings and other
  non-rendering fields).

**Redaction is a hard gate on checking in a recording fixture** — the
extraction script refuses to emit a fixture that still contains a
`SENSITIVE_KEY`-matched value, the same way the corpus refuses un-triaged
fixtures.

---

## 6. The replay harness & test modes

### `RecordedSessionFeed implements SessionFeed`
Reads a recording, replays lines in `t` order into the matching
`onSession*` callback — the same interface the live IPC layer drives, and
the same shape as the existing `FakeSessionFeed`. Drives the **real** fold
→ real `SessionRuntime` → real adapter → ledger → view. Inject `wall` as the
fold clock (a `() => number` seam) so the orphan sweep and timestamp stamps
are deterministic.

### Mode 1 — Golden replay (bless-gated, mirrors bundleCorpus)
Replay the recording; assert the final rows (and/or per-tick rows) equal the
checked-in expected output. `AGENT_CODE_RECORDING_BLESS=1` rewrites expected
output; new divergences land as `untriaged` with the verdict discipline of
`triage-rendering-fixtures.mjs`. Reuse `shadowDiff.diffShadowUnits` for the
comparison. Fails loudly (never skips) on divergence.

This is `bundleCorpus.test.ts` with a *stream* of slices instead of one
frozen slice — and better, because capturing input directly eliminates the
transcript-reconstruction + cutoff-skew hacks that generate most of today's
corpus divergence noise.

### Mode 2 — Invariant replay (the Stage-2 "live warnings", now permanent)
Run *any* recording and assert the ledger invariants hold at **every tick**,
with no hand-authored expected output — catches whole bug *classes*:
- **single-owner**: no two selected candidates own the same artifact
  (toolUseId/text/turn) — already an assertable property of the ledger.
- **no vanish-without-replacement**: a row visible at tick N that is gone at
  N+1 must have a rejection decision explaining it (the ledger records one by
  construction — this asserts the decision exists).
- **no unexplained shrink**: row count dropping without a corresponding
  committed/suppression decision.
- **D11 reference stability**: a tick whose 9 input channels produced no
  runtime change must yield the *same* `RenderLedger` object
  (`adapter.test.ts:119-149` is the executable spec; invariant replay runs it
  over real streams).

Invariant replay needs no bless and no expected output, so it can run over
**every** recording in the fixtures dir — the broadest, cheapest net.

### Determinism note
The ledger/render path is pure w.r.t. wall-clock (`committed.ts:60` forbids
`Date.now()`; ownership keys on entry `timestamp`; ghost rule 4 gates on
`lastJsonlEntryAtMs` derived from entry timestamps). The only wall-clock
reads are in the fold (orphan sweep, stamps) — covered by the injected
`wall` clock. So replay is fully deterministic given the recording.

---

## 7. Debug gate & controls

Mirror the exact `renderShadowEnabled` / `renderPipelineEnabled` pattern
already in `DevDebugConfig` (`src/main/ipc/devDebug.ts`):
- Add `sessionRecordingEnabled: envFlag('AGENT_CODE_SESSION_RECORD')` to
  `DevDebugConfig` + preload types. Only ever active when
  `AGENT_CODE_DEV_DEBUG` (issue #101 gate) is also on — recording is a
  diagnostic, never in normal builds.
- `record-session:start` / `record-session:stop` `ipcMain` handlers (guarded
  by `isDevDebugEnabled`), plus a command in
  `features/workspace/commands/sessionCommands.ts` (the Dev Debug surface),
  and optionally a `sessionRecordingModule` in the `devModules` registry
  showing active recordings + sizes.
- Env-flag auto-record (`AGENT_CODE_SESSION_RECORD=1`) records all sessions
  from launch; the command toggles a single session on demand.

---

## 7b. Attach Recording Note — the live marker

A continuous recording is a haystack; the note marker is how you flag the
needle *at the moment you see it*, without stopping the session. This is the
recording-era equivalent of "save debug logs" — but instead of dumping a
frozen snapshot, it drops a **timestamped bookmark into the live stream**.

### Behavior (as specified by the user)
1. **Reserve instantly.** Running `Attach Recording Note` while a recording
   is active writes a marker line to the recording file *immediately* — before
   the user has typed anything. This captures the exact tick the user reacted
   to (the "reserve a note spot, like save debug logs" gesture: the timestamp
   is claimed the instant you notice the bug, not after you finish typing,
   because by then several more ticks have passed). The reserved marker
   carries a stable `noteId`.
2. **Then prompt.** After reserving, show an input where the user types the
   note. On submit, a second line updates that `noteId` with the text.

### Record lines
```json
{"t":<ms>,"wall":<Date.now()>,"ch":"__note","note":{"id":"n1","status":"reserved"}}
{"t":<ms>,"wall":<Date.now()>,"ch":"__note","note":{"id":"n1","status":"filled","text":"reads vanished right here"}}
```
`__note` is a synthetic channel (double-underscore, outside the 9 real
SessionFeed channels) so replay ignores it for pipeline input but the
extraction/triage tooling can read it. Two-line reserve-then-fill keeps a
crash between reserve and submit from losing the marker — the reserved line
alone still pins the tick (append-only crash-safety, same principle as the
ghost journal's two-phase writes). If the user cancels the input, the
reserved marker stays (a timestamp with no text is still a useful "something
was wrong here" flag).

### Why the reserve-first gesture matters
The gap between "user sees the bug" and "user finishes typing a description"
is several hundred ms to seconds — many pipeline ticks. If we timestamped on
*submit*, the marker would point at whatever the feed looked like after the
bug, not at it. Reserving on invoke pins the reaction moment. This is the
same reason "save debug logs" captures on click, not on note-entry.

### How it drives extraction
`extract-rendering-recordings.mjs` (§6) uses `__note` markers as the
**region-of-interest selector**: a recording with notes extracts fixture
windows centered on each reserved tick (± N ticks of context), rather than
the whole session. The note text becomes the fixture's description — exactly
like a debug bundle's `note.json` seeds the corpus verdict today. A recording
with no notes can still be extracted whole or by invariant-violation ticks.

### Wiring
- Command `record-session:attach-note` in `sessionCommands.ts`, enabled only
  when a recording is active for the focused session (gate on
  `sessionRecordingEnabled` + an active recorder for that sessionId).
- Reserve is an `ipcMain` call that writes the `reserved` line and returns
  the `noteId`; the renderer then opens the note input (reuse the existing
  debug-note input UI if `saveDebugBundle`'s note prompt is componentized;
  otherwise a small modal). Submit sends `noteId` + text → main writes the
  `filled` line.
- Keybinding: worth a dedicated shortcut so it is a reflex during a soak
  (the whole point is speed-to-mark).

## 8. Build order (slices)

Each slice is independently landable and testable; the recorder ships before
any replay so we can capture real recordings to build the harness against.

1. **Recorder core (main)** — `SessionRecorder` + `SessionRecorderManager`,
   cloned from `feedDebugLog.ts` + `ghostJournal.ts`: append-only per-session
   JSONL, header line, 9-channel allowlist, batched drain, backpressure
   (drop-oldest + counter), cap + tombstone. Wired in `forwarder.ts`. Gated
   by `AGENT_CODE_SESSION_RECORD`. **No replay yet** — just produces files.
   Unit tests for the writer (backpressure, cap, torn-tail read) in the
   package's own test dir.
2. **Retention** — register `session-recordings/` as a budgeted bucket in
   `debugRetention.ts`. Small, and closes the OOM/disk-panic risk before the
   recorder sees heavy use.
3. **Gate + controls** — `DevDebugConfig` flag, IPC handlers, sessionCommands
   entry, optional dev module. **Includes `Attach Recording Note`** (§7b):
   reserve-instant + fill-on-submit marker, its keybinding, and the `__note`
   line format. Ships with the controls because a recording you can't
   annotate live is much harder to triage.
4. **Replay harness** — `RecordedSessionFeed implements SessionFeed` + the
   `wall`-clock injection seam in the fold. Prove it by replaying a captured
   recording and reaching the same rows the live session showed.
5. **Invariant replay (Mode 2)** — the four invariants over every recording.
   This is the highest-value, lowest-ceremony net; land it before golden.
6. **Redaction + extraction script** — `extract-rendering-recordings.mjs`
   (successor to the bundle extractor): minimize + redact a local recording
   into a check-in-safe fixture; hard-gate on `SENSITIVE_KEY`. Structure-only
   mode.
7. **Golden replay (Mode 1)** — bless-gated corpus over recordings, reusing
   `diffShadowUnits` + the triage verdict taxonomy.
8. **Docs** — format spec, how to capture, how to add a recording as a
   fixture, how to bless. Update `residue-plan` / `rewrite-plan` to point
   Stage-2's unbuilt auto-capture bullet at this.

Slices 1–3 are the shippable MVP (you can record and it is safe). 4–5 make it
a test net. 6–7 make recordings check-in-safe regression fixtures. Testing
exemption applies: rewrite plan §4 exempts `src/renderer/src/rendering/` and
`testing/{fixtures,support}` from "no new tests in fix PRs."

---

## 9. Open questions (carried from #467, now with recommendations)

- **IPC boundary vs reducer tap** → RESOLVED: SessionFeed boundary in main
  (§1), because fold bugs live above the ledger and the interface is the
  stable seam.
- **Extend feed-debug or a separate stream?** → SEPARATE. feed-debug records
  *decisions/output*; the recorder needs *input*. Different layer, different
  file. Reuse feed-debug's *plumbing* (writer shape, retention), not its
  stream.
- **Redaction: full-local + minimized-checked-in, or one tier?** →
  TWO-TIER (§5), matching how bundle fixtures already work. The structure-only
  derivative is the innovation that makes most recordings check-in-safe while
  still exercising every ownership/ordering rule.
- **How much to record?** → all 9 SessionFeed channels for the full-stack
  local recording; the checked-in derivative drops provably-ignored fields.

## 10. What this is NOT

- Not a screen/video recorder, not a proxy/PTY capture — the semantic input
  layer only (matches the journal rulebook's non-goal).
- Not always-on in shipped builds — debug-gated, like every diagnostic here.
- Not a replacement for the shadow (which dies at cutover) — its permanent
  successor: same invariant checks, no legacy-renderer dependency.
- Not coupled to the fold internals — coupled to the stable `SessionFeed`
  interface, so it survives the #394 refactor.

---

## Appendix — reuse map (what to clone, what's new)

| Capability | Reuse | New work |
|---|---|---|
| Append writer + cap + tombstone | clone `storage/feedDebugLog.ts` | 9-channel record type, header line |
| Batched drain, crash-safe, torn-tail read | `main/ghostJournal.ts` | — |
| Renderer→main transport | N/A (record in MAIN) | — |
| Retention | `storage/debugRetention.ts` bucket | add `session-recordings` bucket |
| Backpressure | journal-plan rulebook | drop-oldest + counter on write queue |
| Lifecycle (per-session, start/stop, quit-flush) | `SubAgentWatcherManager` shape | `SessionRecorderManager` |
| Replay seam | `RuntimeLedgerSlices` + `bundleCorpus.test.ts` | `RecordedSessionFeed implements SessionFeed` |
| Replay double precedent | existing `FakeSessionFeed` | — |
| Golden bless + verdicts | `bundleCorpus.test.ts` + `triage-rendering-fixtures.mjs` | recordings corpus |
| Invariant diff | `shadow/shadowDiff.ts` | 4 per-tick invariants |
| Gate + controls | `ipc/devDebug.ts` (`renderShadowEnabled` template), devModules registry | `AGENT_CODE_SESSION_RECORD` flag + command |
| Redaction primitives | `rendering/model/unknowns.ts` (`SENSITIVE_KEY`, `shapePathsOf`) | full-payload redaction pass + structure-only mode |
| Extraction | `scripts/extract-rendering-fixtures.mjs` | `extract-rendering-recordings.mjs` |
