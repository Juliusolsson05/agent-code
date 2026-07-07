# Prior art: session recording / deterministic replay / event capture

Research for the new Session Recording feature (issue #467). Goal: don't
contradict or duplicate existing thinking; inherit hard-won lessons.

---

## (a) The rewrite plan's Stage 2 auto-capture — EXACT QUOTE + how the recorder relates

From `docs/rendering/rendering-rewrite-plan-2026-07.md` §5 "Stage 2 — shadow:
reality corrects the spec" (lines 371-386), verbatim:

> Wire the model to observe real inputs beside the untouched old renderer:
> - same IPC feeds fold into the new model in parallel (behind
>   `AGENT_CODE_RENDER_SHADOW=1`)
> - per session, diff `newModel.rows` vs the old renderer's `visible_rows`
> - **every divergence auto-captures a minimized fixture draft (inputs + both
>   outputs) into the debug bundle**
> - the ledger's invariant WARNINGS run live (dual-render, vanish-without-
>   replacement, unexplained shrink)
>
> Shadow rides normal daily use — Claude, Codex, OpenCode, MCP orchestration,
> resumes, compaction, subagents. Divergences are triaged into: old-renderer bug
> (fixture proves the new model right — document, keep), new-model bug (fix,
> fixture), or spec gap (extend catalog). Stage 2 exits when a week of real use
> produces no untriaged divergence classes.

Also §9 stop condition (line 465-467):

> Do not enter Stage 3 unless: one week of shadow with no untriaged divergence
> class; the queue-handoff, buried-prompt, and ghost-matrix fixtures pass against
> **SHADOW-captured real traffic, not only synthetic inputs**.

### CRITICAL FINDING — the "auto-captures … into the debug bundle" was never built

The shipped shadow implementation (`src/renderer/src/rendering/shadow/useRenderShadow.ts`)
does NOT write fixture drafts to disk. Its only two divergence sinks are
(lines 36-42):

> Divergence sinks, in order of usefulness:
>   1. module ring buffer on `globalThis.__agentCodeRenderShadow` — full
>      reports, newest last; the triage workflow is "reproduce, then copy
>      JSON from the console" and each report is a fixture seed.
>   2. `console.warn` once per (sessionId, divergence-signature) — the spam
>      guard matters because a stable divergence re-fires on every runtime tick.

So today "auto-capture" = a 50-entry in-memory ring + console.warn, manually
copied out. **The recorder (#467) is the fuller, principled realization of what
Stage 2 promised** ("auto-captures a minimized fixture draft … into the debug
bundle"). It should be framed as completing Stage 2's auto-capture, not as a new
idea.

### How the recorder DIFFERS from shadow (and why both matter)

- **Shadow captures a per-tick DIFF snapshot** (inputs + both outputs at ONE
  divergent tick). It is old-renderer-vs-new-renderer parity, and it only exists
  while the legacy renderer is still mounted — the plan explicitly **DELETE-fates
  the whole shadow apparatus at Stage 3 cutover** (useRenderShadow.ts line 33-34:
  "The shadow … is DELETE-fated at Stage 3 cutover along with the legacy
  renderer itself"). After cutover there is no second renderer to diff against.
- **The recorder captures the full event STREAM** (the sequence of inputs), and
  replays it through the real pipeline at *every* tick. #467's own motivation
  names the two gaps shadow/bundles can't cover:
  1. "A bundle is a single frozen tick" — can't reproduce cross-tick bugs
     (queued prompt arrives→reconciled→vanishes).
  2. "The corpus is old-renderer-only" — structurally cannot catch a bug that
     only appears in states the **new** pipeline drives live, which is exactly
     the class the current soak is turning up.
- Net: shadow is the transitional cross-check that dies at cutover; the recorder
  is its permanent successor that survives cutover and covers the timeline
  dimension neither bundles nor shadow can. Design them as continuous — the
  recorder inherits shadow's *invariant checks* (diffShadowUnits) but not its
  legacy-renderer dependency.

---

## (b) Related issues (one-line relevance each)

Recording / replay / corpus:
- **#467** (OPEN, the new one) — Session Recording: continuous debug-gated
  capture replayable as rendering fixtures. Explicitly references
  `testing/fixtures/rendering-bundles/`, `src/main/ipc/devDebug.ts`,
  `feed-debug.jsonl`, `scripts/extract-rendering-fixtures.mjs`,
  `bundleCorpus.test.ts`. Two replay modes: **golden** (bless-gated) +
  **invariant** (assert pipeline invariants at every tick).
- **#172** (OPEN, umbrella) — feed render ownership across all channels; the
  rewrite plan closes it. Its comment-5 criteria = the invariants the recorder's
  invariant-replay mode asserts (no dual-owner, no vanish-without-replacement,
  reference-stability on no-op).
- **#183** (referenced in rewrite plan §8, "the fixture suite IS the regression
  coverage") — the corpus-as-regression philosophy the recorder extends.
- **#182** (CLOSED) — "Add a proper unit and integration testing suite" — the
  original testing-stack issue; recordings are the next fixture class.
- **#171** (CLOSED) — "Add rendering trace debug for transcript and semantic
  channel ownership": asked for ONE ordered timeline (committed + semantic +
  optimistic + visible-row decisions) per debug bundle. This is the conceptual
  ancestor of the recorder's event stream; its desired fields (committed owner
  key, semantic owner turnId/blockIndex, rendered row key, suppress/replace/dup
  verdict) are exactly what a recording should carry per tick.
- **#101** (CLOSED) — Dev Debug Panel: the schema-driven default-off module host
  and `AGENT_CODE_DEV_DEBUG` gate (`src/main/ipc/devDebug.ts`) that #467 reuses
  as its start/stop surface.

Subagent watcher lifecycle (the pattern to copy for the recorder's per-session
watcher):
- **#341** (OPEN) — subagent rows stay running for days; toolUseId reserved as
  first-class key (rewrite invariant #14). Watcher lifecycle relevance.
- **#310** (CLOSED) — SubAgentWatcher read full JSONL and retained parsed
  entries **unbounded**. Direct memory-lesson for any file-tailing recorder:
  don't retain the whole parsed stream in memory.
- **#178** — subagent surface / toolUseId first-class key (reserved, own
  feature, ledger schema carries it day one).
- **#340** — Codex subagents visible in proxy but absent from runtime state.

Debug-bundle storage / autosave separation (retention precedent):
- **#237** (CLOSED) — separate manual Save Debug Logs from autosave captures;
  21,187 index entries of which only 10 were manual — autosave noise buries
  manual signal. Recording must NOT repeat this: give recordings their own
  location/index, don't pollute manual saves.
- **#309** (CLOSED) — autosave bundles churn timestamped folders; fix = stable
  per-session folder for autosave, timestamped only for manual. Recorder should
  use a stable per-session dir (`session-recordings/<sessionId>/<start-ts>.jsonl`
  per #467, which is per-recording-start under a per-session dir).

Memory / OOM / disk (the constraints — see section d):
- **#388** (CLOSED) — the 2026-07-04 mark-compact crash; feed-debug 60-300 MiB
  per file, `debug:append-feed-log` IPC dominated final spans. Source of the
  128 MiB per-file cap + tombstone. **The single most important issue for the
  recorder to read.**
- **#288** (CLOSED) — main-process heap unbounded, 681 MB, 92% strings (full
  transcript + tool-output retained in memory).
- **#390** (CLOSED) — 60 Hz screen-snapshot GC storm allocating ~GB/s.
- **#310** (CLOSED, above) — unbounded retained JSONL.
- **#370** (OPEN) — persist crash breadcrumbs; "Never let the console tail become
  unbounded or block the process."
- **#372** (OPEN) — bound Codex proxy mirroring & debug-log pressure during
  Responses streams.
- **#373** (OPEN) — byte caps on orchestration MCP outputs / tombstones.
- **#375** (OPEN) — window live renderer state by BYTES, not initial history
  count (model-adjacent; the recorder is a byte producer).
- **#365 / #327 / #369** (OPEN) — heap/OOM follow-ups.
- **#368** (CLOSED) — heap watchdog missed V8 old-space OOM below global limit
  (fixed alongside #388: interval 30s→5s, threshold 3GiB→1.5GiB).
- **#115** (OPEN) — sanitize logs before writing debug/proxy output (redaction
  relevance for #467's open redaction question).
- **#103** (OPEN) — general memory optimization sweep.

---

## (c) Reusable record/replay code (what exists, and whether the recorder can share it)

**The replay seam already exists — reuse it directly:**
- `src/renderer/src/rendering/adapter/collectLedgerInput.ts` — self-described as
  "THE shadow seam" (line 27-30). `RuntimeLedgerSlices` → `LedgerInput` via
  `createLedgerInputAdapter()`. #467's own open question ("record at IPC boundary
  vs inside reducer") answers itself here: `collectLedgerInput` sits at the
  main→renderer input boundary and is where `RuntimeLedgerSlices` is assembled.
  Record the `RuntimeLedgerSlices` ticks (or the inputs that produce them) and
  the replay harness feeds them straight through `createLedgerInputAdapter()(...)
  → createSessionLedger()(...)`. This is EXACTLY what `bundleCorpus.test.ts` does
  today with a single frozen slice — the recorder generalizes it to a sequence.

**The golden-replay harness already exists — extend it:**
- `src/renderer/src/rendering/__tests__/bundleCorpus.test.ts` — reads a fixture,
  builds `RuntimeLedgerSlices`, runs `createLedgerInputAdapter` → `createSessionLedger`,
  diffs against recorded ground-truth rows, asserts triage matches exactly.
  Bless via `AGENT_CODE_CORPUS_BLESS=1`. #467's "golden replay" is this test with
  a stream of slices instead of one. Reuse the bless-gate model verbatim.

**The invariant + divergence machinery already exists:**
- `src/renderer/src/rendering/shadow/shadowDiff.ts` — `diffShadowUnits`,
  `ledgerUnits`, `legacyUnits`, `ShadowDivergence`. #467's "invariant replay"
  (no dual-owner, no vanish-without-replacement, ref-stability on no-op) should
  reuse `diffShadowUnits`/the ledger's invariant WARNINGS rather than re-implement.
- `src/renderer/src/rendering/shadow/useRenderShadow.ts` — the per-session
  divergence detector + spam-guard (once per sessionId|signature) + ring buffer.
  Pattern to lift for invariant-replay reporting.

**The append-only JSONL writer with all the hard-won caps — MIRROR THIS EXACTLY:**
- `src/main/storage/feedDebugLog.ts` (358 lines, heavily commented). This is the
  reference implementation for a debug-gated, per-session, append-only JSONL
  writer that survived the #388 OOM post-mortem. It already encodes every lesson
  the recorder needs:
  - **128 MiB per-file cap** (`MAX_FEED_DEBUG_FILE_BYTES`) with a **tombstone
    line**, NOT rotation (rotation hides the cause + forces glob on read).
  - **Per-session serialized write queue** (`feedDebugWriteQueues`) so overlapping
    batches don't interleave/truncate JSONL.
  - **id-dedup idempotence** (`lastWrittenFeedDebugId`) — renderer can legally
    resend the same window.
  - **Fail-CLOSED on unknown stat** (loadInitialFileBytes returns null on
    non-ENOENT → skip batch without advancing cursor). Failing open is how a
    300 MiB file gains another 128 MiB.
  - **Doubling-refresh tombstone** so the on-disk drop count stays within 2x of
    truth (log-bounded extra rows).
  - **`scheduleDebugStoragePrune()`** hook into `debugRetention.ts` on every append.
  - Path sanitization via `sanitizeFilenameToken` to prevent traversal from a
    malformed sessionId.
  The recorder's writer should be a near-clone (or a shared helper factored out).

**`feed-debug.jsonl` itself — the recorder's stated predecessor but DIFFERENT layer:**
- Renderer producers: `src/renderer/src/workspace/runtime/feedDebug.ts`,
  `src/renderer/src/workspace/hook/persistence/useFeedDebugPersist.ts`; main sink
  above. Design doc: `docs/superpowers/plans/2026-04-18-feed-debug-stream.md`
  (the "FAT debug stream" / ring buffer + `RENDER` layer).
  KEY DISTINCTION #467 makes: feed-debug logs **decisions/outcomes** (why a row
  appeared/disappeared/was suppressed), the recorder needs **inputs** (what the
  pipeline consumed). #467 open question: extend feed-debug's format or a separate
  stream. Recommendation implied by collectLedgerInput seam: separate input
  stream, because feed-debug is renderer-derived decisions, not the raw IPC input.

**Extraction / triage scripts — the fixture-authoring pipeline:**
- `scripts/extract-rendering-fixtures.mjs` (320 lines) — bundle → fixture JSON.
- `scripts/triage-rendering-fixtures.mjs` — source of truth for triage verdicts.
- `scripts/extract-codex-entries.mts` — codex rollout → Entry extraction.
  The recorder's "add a recording as a fixture" step should follow this shape.

**Append-only crash-safe journal precedents (design pattern, not shared code):**
- `src/main/ghostJournal.ts` — append-only, crash leaves valid partial. #467
  cites the ghost-journal + proxy-events design as the model for "append-only so
  a crash still leaves a valid partial recording."
- `src/main/incident/AppRunJournal.ts` + `journalTypes.ts` — the always-on
  bounded journal (planned in `docs/plans_and_ideas/2026-06-25-performance-incident-journal-plan.md`).
  Its Retention/Backpressure section (below) is the canonical constraint list.
- `src/main/dictationJournal.ts` — another per-feature append-only journal.
- `src/main/storage/proxyEventsReader.ts` / proxy-events.jsonl — provider wire-shape
  recordings; the MEMORY note flags these dirs as unbounded OOM risks.

**Redaction:**
- `src/renderer/src/rendering/model/unknowns.ts` — `SENSITIVE_KEY` handling
  (cited in #467's redaction open question). Reuse for check-in-safe recordings.

---

## (d) Hard memory/disk constraints the recorder MUST respect, with source incident

**Source: issue #388 (2026-07-04 mark-compact crash) + `feedDebugLog.ts` comments.**
The definitive incident. A 34h main process died from a V8 mark-compact abort at
~2.55 GB heap. Timeline: heapUsed went 39 MB → 637 MB → 1620 MB → 2174 MB in
**15 seconds**, aborting at 2554 MB. The watchdog sampled every 30 s and tripped
at 3 GiB, so it saw nothing. **The last 30 spans before death were dominated by
`ipc.handle.debug:append-feed-log` (55-867 ms/call); individual feed-debug JSONL
files were 60-300 MB with no per-file cap.** Constraints extracted:
- **Per-file byte cap with tombstone, never rotation** (128 MiB is the shipped
  number for feed-debug; recorder should adopt the same shape).
- **The IPC append channel is itself the OOM vector.** #388 explicitly deferred
  "IPC backpressure for `debug:append-feed-log`" as "the root fix … its own PR
  (drop vs. block, per-session vs. global counter)." A NEW continuous recorder
  streaming every event over IPC re-opens this exact wound — it must ship with
  backpressure (drop-oldest + dropped counter) from day one, not add a second
  unbounded append IPC.
- Watchdog now samples every 5 s, trips at 1.5 GiB (so a 15 s burst is caught).
  A recorder that can burst >1.5 GiB/15s will now trip the watchdog — keep
  per-tick payloads small.

**Source: `docs/plans_and_ideas/2026-06-25-performance-incident-journal-plan.md`,
"Core Invariants" + "Retention and Backpressure".** The canonical rulebook for
any always-on/high-volume writer in this project:
- Append-only JSONL, bounded by retention + modest per-record payloads.
- **Runtime bounds: event queue max 2,000 pending; breadcrumb ring max 512;
  single write in flight; one append queue per app run; drop-oldest on overflow
  and record a dropped counter; unref all recurring timers.**
- **Payload bounds: truncate stacks; NEVER store prompt bodies, model responses,
  raw PTY output, or full transcript entries in an always-on log; coalesce
  repeated errors by kind+message+source.**
- **Large artifacts are referenced, not copied** (heap snapshots, transcripts,
  proxy logs linked by path/id).
- **Non-goal (line 32):** "Do not record raw PTY streams, full IPC payloads, full
  proxy bodies, transcript contents, or workspace snapshots into an always-on
  log." → #467 aligns: it records the *semantic input layer*, NOT screen frames
  or proxy HTTP bodies. Keep it that way.
- Fatal-path writes are synchronous (can't rely on async drain before exit).

**Source: issue #288 (CLOSED).** Main-process heap unbounded: 681 MB, 92%
strings, from retaining full transcript + tool-output text in memory. Lesson: the
recorder must not build up the full stream in memory — stream to disk and drop.

**Source: issue #310 (CLOSED).** SubAgentWatcher read full JSONL files and
retained parsed entries unbounded. Lesson for any file-tailing recorder: tail
incrementally, do not retain parsed history in memory.

**Source: issue #390 (CLOSED) + MEMORY note.** 60 Hz screen-snapshot pipeline
allocated ~GB/s. Lesson: do not couple the recorder to a high-frequency tick
(screen snapshots); record on semantic-event arrival, not on a fixed hi-freq
timer.

**Source: MEMORY.md (`project_ccshell_debug_disk_hog`).** `~/.config/agent-code/
{feed-debug,debug-bundles,proxy,performance}` are unbounded, never rotate, and
have caused disk panics / OOMs. Any new `session-recordings/` dir joins this
family and MUST register with `debugRetention.ts` as a first-class bucket with a
disk budget from day one — #467 itself flags it as "debug-gated, unbounded —
document the retention caveat," but the memory history says that caveat is not
enough; it needs an actual retention bucket.

**Source: issues #237 / #309 (CLOSED).** Storage-hygiene lessons: keep the
recording index/location separate from manual Save-Debug-Logs, use stable
per-session dirs (not churned timestamped folders that retention immediately
re-creates), and don't append to a write-only ledger nothing reads.

**Gating (privacy + disk, from #467 + #101):** recorder is available ONLY under
`AGENT_CODE_DEV_DEBUG=1` (same gate as Dev Debug Panel, `src/main/ipc/devDebug.ts`),
never in normal builds — it touches private conversation content.

### Constraint checklist the recorder must satisfy
1. Debug-gated (`AGENT_CODE_DEV_DEBUG=1`) only; never in shipped builds.
2. Append-only JSONL, crash leaves a valid partial (ghost-journal/proxy-events
   pattern); header line with schemaVersion + provider/session metadata.
3. Per-file byte cap + tombstone line, NOT rotation (clone feedDebugLog.ts).
4. Per-session serialized write queue; id-dedup idempotence; fail-CLOSED on
   unknown stat.
5. Backpressure on the IPC append path (drop-oldest + dropped counter) — do not
   re-create the #388 unbounded-append IPC OOM.
6. Bounded in-memory buffers (≤ ~2000 pending / ring), single write in flight,
   unref timers, stream-and-drop (never retain the whole stream — #288/#310).
7. Record on semantic-event arrival, not a high-frequency tick (#390).
8. Record the semantic INPUT layer (RuntimeLedgerSlices / collectLedgerInput
   inputs), NOT screen frames or proxy bodies (journal-plan non-goal + #467).
9. Register `session-recordings/` with `debugRetention.ts` as a budgeted bucket;
   stable per-session dir; separate from manual debug bundles (#237/#309/#370).
10. Redact via `SENSITIVE_KEY` (unknowns.ts) if check-in-safe, else keep full
    recordings local-only and check in a minimized derivative (#115, #467).
11. Journal prune actions (don't only console.warn — #388 lesson #2, #370).

### Testing-convention note (from rewrite plan §4, lines 366-369)
The "no new tests in fix PRs" rule (MEMORY `feedback_no_test_bloat`) is
**formally exempted** for `src/renderer/src/rendering/` and
`testing/{fixtures,support}` — "this project IS its tests." The recorder's
replay tests + checked-in recordings land under those paths, so they are allowed
(and expected), unlike normal feature PRs.
