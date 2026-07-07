# Recording/Journaling/Replay Precedent — Reuse Map for "Session Recording"

Goal: a new continuous append-only JSONL of pipeline INPUTS, debug-gated, replayable in tests.
This catalogs every existing machine so the recorder EXTENDS proven patterns.

---

## 1. feed-debug.jsonl — the per-session decision log

**Type**: `FeedDebugEntry` — `src/renderer/src/workspace/workspaceState.ts:244-252`
```
{ id:number; ts:number; tMs:number; layer:'STATE'|'JSONL'|'SEM'|'RENDER'|'GHOST'; kind:string; summary:string; data?:unknown }
```
`FeedDebugLayer` at :242. Lives on the runtime as `feedDebugLog: FeedDebugEntry[]` (:519), plus
`feedDebugNextId` and `feedDebugEpochMs` (:520-521). `tMs` = offset from the session's first-entry epoch.

**Append path (renderer)**: `appendFeedDebugLog(current, input)` —
`src/renderer/src/workspace/runtime/feedDebug.ts:35-60`. Pure reducer: returns a new runtime ref,
stamps id/ts/tMs, in-memory ring capped at `FEED_DEBUG_LOG_CAP = 500` (:22). Wrapped by the
workspace hook `appendFeedDebug` (`hook/helpers.ts:59`), surfaced to components as
`workspace.appendFeedDebug` / `appendRenderDebug` (`TileLeaf.tsx:270`).

**Callers / what gets logged**:
- STATE layer: `hook/actions/streaming.ts:146,202,254,297` (submit, optimistic user queue,
  session_started, process/status transitions), `hook/actions/initialHistory.ts:220` (bootstrap).
- JSONL layer: jsonl-entries ingest bursts.
- SEM layer: semantic summaries — `workspace/semantic/summarize.ts:69`.
- RENDER layer: `Feed.tsx:891-892` **`kind:'visible_rows'`** — records the ACTUAL painted row
  list `{rows, added, removed}` only when the row set changed (signature-diffed at :882).

**Persistence (renderer→main)**: `useFeedDebugPersist` —
`src/renderer/src/workspace/hook/persistence/useFeedDebugPersist.ts`. Ships id-monotone batches
every runtime tick via `window.api.appendFeedDebugLog`. Two cursors:
`persistedFeedDebugIdRef` (advanced ONLY after IPC resolves) + `inFlightFeedDebugIdRef`
(one unresolved append per session — backpressure). `selectFeedDebugAppendBatch` (:26) picks
`entry.id > lastPersistedId`. Retry-safe by (sessionId, id).

**Main writer**: `queueFeedDebugAppend` — `src/main/storage/feedDebugLog.ts:136`.
Writes `STATE_DIR/feed-debug/<sanitizedSessionId>.jsonl` via `writeFile(..., {flag:'a'})`.
Per-session serialized Promise queue (`feedDebugWriteQueues`) so overlapping batches can't
interleave/tear lines. Process-local id dedupe (`lastWrittenFeedDebugId`) — fresh app run
re-appends a new timeline even though renderer ids restart at 1.

**Rotation/retention**:
- Per-file HARD cap `MAX_FEED_DEBUG_FILE_BYTES = 128 MiB` (:35). NO rotation — deliberate
  (rotation would force the bundle collector to glob shards + hide a flooding session). On cap
  crossing it writes the admitted line-prefix + a **tombstone row** `{__feedDebugCapped:true,
  reason:'per-file-cap', droppedEntriesSoFar, ...}` (:110) in one append, then latches and
  drops. Tombstone is REFRESHED each time drop-count doubles (log-bounded honest count).
- Bucket cap via `scheduleDebugStoragePrune` → `debugRetention.ts` (feed-debug bucket ~3 GiB).
- `forgetFeedDebugSession` (:347) drops in-memory cursors at session end; file left on disk.

**In the bundle**: `saveDebugBundle.ts:330 serializeFeedDebugJsonl` re-serializes the current
in-memory 500-entry slice into `feed-debug.jsonl` with an added `tsIso`.

### INPUT-vs-OUTPUT verdict — feed-debug is DECISION-OUTPUT, not a recorder input
feed-debug records *what the pipeline decided/did* — visible_rows is the painted output, STATE/SEM
lines are post-hoc summaries (`summary` string + a lossy `data`). It is NOT a faithful capture of
the pipeline INPUT (entries + semantic + ghosts + scalars) at each tick. Crucially, the
corpus-extraction script (below) has to RECONSTRUCT the input from *other* sources and only mines
feed-debug for the `RENDER visible_rows` line as the expected OUTPUT ground-truth. So feed-debug is
~80% of a recorder's *output/expected* channel and the plumbing template (cursor persistence, per-
session serialized JSONL, cap+tombstone, retention hook), but ~0% of the *input* channel. The
recorder should reuse feed-debug's transport/retention shape and add a NEW input-plane stream.

---

## 2. Debug-bundle system — the single-snapshot precedent

**Assembler (renderer)**: `src/renderer/src/features/debug/saveDebugBundle.ts`.
`assembleAndSaveDebugBundle` (:457). Runs in renderer because every source is renderer-local
(runtime store, DOM, sanitizeHtml). `BUNDLE_SCHEMA_VERSION = 1` (:42).
File set (`FILE_NAMES` :47-74): manifest.json, state-snapshot.json (heavy planes stripped:
entries/maps/ghosts/feedDebugLog/semantic removed, screen tail-capped to `SCREEN_TAIL_LINES=200`,
`_counts` + `_tailHealth` added), feed-debug.jsonl, work-context.json, render-diagnostics.json
(committed-vs-semantic ownership join table, `snippet()` capped at `DIAGNOSTIC_SNIPPET_CHARS=360`),
proxy-semantic.json (full `SemanticRuntimeState` dump + ISO mirror), html-raw.html, html-clean.html
(sanitized), and CONDITIONAL proxy-events.jsonl + proxy-session-meta.json (manual saves only).
Auto vs manual: `autosaveActiveAgentDebugBundles` (:584) every `AUTO_DEBUG_BUNDLE_INTERVAL_MS=60_000`;
autosave SKIPS the proxy tail (a 108 GB disk-hog multiplier — comment :488).

**Main writer**: `src/main/storage/debugBundle.ts` `saveDebugBundle` (:121). Thin byte-mover.
Path safety `isSafeRelativePath` (:108). Manual saves → timestamped folder
`<ISO-ms>-<sessionShort>` (`buildBundleFolderName` :74) + ledger append
(`appendDebugBundleSaved` → saved-debug-bundles.jsonl) + incident-journal enrichment
(`enrichBundleWithIncidentJournal` :229 stamps appRunId, copies events/incidents/heartbeat tails).
Autosave → STABLE per-session folder (`buildAutosaveFolderName` :99, no timestamp) written to a
`.tmp-<pid>-<time>` dir then rm+rename (avoids the N-panes×60s churn firehose), NO ledger append.

**Retention**: `src/main/storage/debugRetention.ts`. `scheduleDebugStoragePrune(reason)` (:124)
— singleton, 5-min cooldown (`PRUNE_COOLDOWN_MS`), `pruneInFlight` guard. Budget = 3% of disk
clamped to `[10,15] GiB` (`defaultBudgetBytes` :98), TTL default 48h (`DEFAULT_TTL_HOURS`),
`ACTIVE_GRACE_MS=10min`. Buckets enumerated `DebugStorageBucket` (:30): feed-debug,
debug-bundles-{manual,autosave,legacy}, proxy, performance, incidents, heap-snapshots, ghost-logs.
Env overrides `AGENT_CODE_DEBUG_MAX_GB`, `AGENT_CODE_DEBUG_TTL_HOURS`. Mirrors prunes into the
incident journal (`setDebugRetentionJournal`).

This is the **single-tick snapshot** the recording supersedes for the multi-tick case: same file
concepts, but captured once at save-time instead of continuously.

---

## 3. Corpus extraction + replay — the bless/verdict discipline to MIRROR

**Extraction**: `scripts/extract-rendering-fixtures.mjs`. Reads
`~/.config/agent-code/debug-bundles/{manual,}` bundles, reconstructs pipeline INPUT from disk
(NOT from the bundle, which drops heavy planes):
- entries ← provider transcript JSONL (Claude `~/.claude/projects/...`, Codex `~/.codex/sessions/...`
  resolved via saved-debug-bundles.jsonl ledger `cwd`+`providerSessionId`), filtered
  `timestamp <= cutoffMs`, seen-uuid dedupe mirroring runtime ingest (:193), `MAX_ENTRIES=80`,
  tool_result truncated `TOOL_RESULT_CAP=600`, text `TEXT_CAP=8000`.
- semantic ← proxy-semantic.json.
- ghosts ← ghost journal `<sessionId>.ghost.jsonl` folded by uuid, `updatedAt <= cutoffMs`.
- scalars ← state-snapshot.json (streamPhase, pendingTool*, lastJsonlEntryAt, queuedMessages).
- **expected** ← LAST `RENDER/visible_rows` line in feed-debug.jsonl (the legacy renderer's ACTUAL
  painted rows — recorded ground truth). **cutoff = that event's own `ts`** (:175), NOT capturedAt
  — aligning input planes to the expected moment killed whole skew-divergence classes.
Fixture shape written to `testing/fixtures/rendering-bundles/<id>.json`:
`{ meta, input:{provider,streamPhase,...,entries,semanticCurrent,semanticHistory,ghosts},
   expected:{rows,semanticTurnId,...}, triage:[] }`.

**Codex mapping** runs the REAL in-app mapper via `npx tsx scripts/extract-codex-entries.mts`
(:116) — never reimplemented, so uuids match.

**Replay test / BLESS**: `src/renderer/src/rendering/__tests__/bundleCorpus.test.ts`.
For each fixture: build ledger from `input` slices (`createLedgerInputAdapter` + `createSessionLedger`),
compute `ledgerUnits` (next) vs `legacyUnits(expectedToLegacyItems)` (legacy), `diffShadowUnits`.
- **Assertion**: `expect(diff.divergences).toEqual(fixture.triage.map(t=>t.divergence))` (:174) —
  asserts STABILITY not blanket parity. Any new/vanished divergence fails until re-blessed.
- **BLESS**: `AGENT_CODE_CORPUS_BLESS=1` (:75) rewrites each fixture's `triage` to the current diff,
  new entries land `verdict:'untriaged'`, prior verdicts preserved by divergence-JSON key (:166).
- **Sanity floor** (:178): pipeline must never paint zero when legacy painted something.
- Scope filter `scopeUnits` drops work/empty units + ghost/optimistic rows when their source
  couldn't be reconstructed (:119).

**Verdict taxonomy** (`scripts/triage-rendering-fixtures.mjs`, the source of truth for verdicts):
`skew-ingestion-lag`, `equivalent-content`, `extraction-gap[:history-window|:optimistic-rows-
renderer-local]`, `legacy-bug[:scaffolding-echo|:prompt-not-shown]`, `untriaged`. Triage is a
reviewable SCRIPT (mechanical rules) so re-extraction replays the whole triage instead of losing it.

The recorder's golden-replay mode should copy this exactly: recorded input tick → pipeline →
diff against recorded output, triage array per case, `AGENT_CODE_*_BLESS=1` env, verdict discipline,
sanity floor. The recorder makes this STRICTLY BETTER because it captures input directly (no
transcript-reconstruction / cutoff-skew guessing — the #1 source of divergence noise today).

---

## 4. Append-only journals — format precedent

**GhostJournal** — `src/main/ghostJournal.ts`. THE canonical append-only design:
- One file per session `<userData>/ghost-logs/<sessionId>.ghost.jsonl`, NEVER co-writing the CLI's
  JSONL (two-writer torn-line disaster, comment :17).
- `append()` (:103) `JSON.stringify(ghost)+'\n'` into an in-memory queue; `scheduleDrain()` batches
  at `FLUSH_INTERVAL_MS=100` (mirrors upstream Claude's `sessionStorage` FLUSH_INTERVAL). `draining`
  bool guards overlapping drains (:94). `flush()` durability barrier for shutdown/tests.
- `GhostJournalRegistry` (:171): lazy per-session writers, `flushAll()` on before-quit, `dispose()`
  flush→compact on session kill. mode `0o600` files, `0o700` dirs.
- **Partial-write tolerance**: reader `readCompactGhostState` (:327) streams line-by-line
  (`createReadStream`+`readline`), `try{JSON.parse}catch{continue}` — malformed tail = crash
  mid-append, earlier lines still valid. Missing file = no error.
- **Compaction** (:302 `compactGhostLogFile`): last-write-wins by `(uuid,_atp.updatedAt)`, rewrite
  to tmp then rename, gated `AGENT_CODE_GHOST_COMPACT_MIN_MB` (default 5 MiB), only when session not
  live (rename races active appends). Streaming reader was the fix for a 2.1 GB / 169 MB-file OOM
  (comment :234) — full-file readFile→split→parse→IPC blew main's heap.

**proxy-events.jsonl reader** — `src/main/storage/proxyEventsReader.ts`. Read side only (writers
live in claude-code-headless mitm + Codex ResponsesProxy). Path
`proxy/<project-seg>/<session-seg>/<run-ts>/proxy-events.jsonl`. `readProxyEventsForBundle` (:100)
NEVER throws (empty section = "no record"). **Truncation marker**: files > `PROXY_EVENTS_BUNDLE_
MAX_BYTES=5 MiB` are tailed via open+read at `size-max`, first partial line dropped for a clean
JSONL boundary, and a synthetic `{kind:'truncated', dropped_bytes, reason}` header line is prepended
(:242). Segment sanitiser MUST match the writers or the bundle silently misses.

**Other JSONL writers** (same family, from grep): `src/main/pasteDebugJournal.ts` (paste-debug,
write-only at runtime, read via `dev-debug:read-paste-events`), `src/main/dictationJournal.ts`,
`src/main/subagents/SubAgentWatcher.ts` + `codexSubagentState.ts` (watch `<sessionDir>/subagents/
*.jsonl`), `src/main/storage/performanceLog.ts`, `src/main/storage/debugBundleLog.ts`
(saved-debug-bundles.jsonl ledger), `src/main/incident/AppRunJournal.ts` (events/incidents.jsonl
crash spine — enrichBundleWithIncidentJournal tails it). `readJsonlTailBytes` in debugBundle.ts:269
is a reusable tail-reader.

**Shared design the recorder should adopt** (synthesized from all of the above):
- One file per session, `JSON.stringify(rec)+'\n'`, `writeFile {flag:'a'}` or `appendFile`.
- Batched drain (~100ms) with an overlapping-drain guard + `flush()` barrier on quit.
- Per-session serialized write queue (feedDebugLog pattern) so overlapping batches don't tear.
- Partial-write tolerance on read: stream + per-line try/catch, torn tail = skip.
- Per-file hard byte cap + tombstone/truncated-header marker (feed-debug tombstone OR proxy-events
  synthetic header) — NOT rotation.
- Compaction as a separate maintenance op, gated by min-size, tmp+rename, only when session dead.
- NO explicit schema-version *header line* exists in any current JSONL (bundle uses a manifest
  `schemaVersion` field instead). The recorder should add a first-line `{__recordingHeader:true,
  schemaVersion, sessionId, provider, appRunId}` — this is a genuine GAP worth filling.
- Retention: route through `scheduleDebugStoragePrune` + add a `DebugStorageBucket` entry.

---

## 5. The debug gate

`src/main/ipc/devDebug.ts`. `isDevDebugEnabled()` = `envFlag('AGENT_CODE_DEV_DEBUG')` (:26).
`registerDevDebugIpc` exposes `dev-debug:get-config` (:31) returning `DevDebugConfig`
(`src/preload/api/types.ts:48`):
```
{ enabled:boolean; renderShadowEnabled:boolean; renderPipelineEnabled:boolean }
```
`renderShadowEnabled`=`AGENT_CODE_RENDER_SHADOW`, `renderPipelineEnabled`=`AGENT_CODE_RENDER_PIPELINE`
(:40-41). Flags are read from process.env in MAIN (works in Electron dev without a Vite-prefixed
renderer var / rebuild). IPC is the trust boundary: read handlers re-check `isDevDebugEnabled()`
before returning private data (`dev-debug:read-paste-events` :51-58).

**Reaching the renderer**: preload `getDevDebugConfig` (`src/preload/api/devDebug.ts:6`) →
`ipcRenderer.invoke('dev-debug:get-config')`. Consumed in `App.tsx:196` (sets global
`devDebugEnabled` in uiShell slice), and independently by `useRenderShadow.ts:65` /
`useLedgerFeedItems.ts:39` which each fetch config and gate themselves on their flag.

**Dev Debug Panel + module registry**: `DevDebugPanel.tsx` renders modules from
`devDebugModules` (`src/renderer/src/features/debug/devModules/registry.ts`) — a flat exported
array `[conditionsDebugModule, headlessSnapshotProbeModule, claudePasteDetectionModule,
transcriptSyncModule]`, each a `DevDebugModule` with id + component + optional `buildCopyText`.
Enabled modules persisted in localStorage `agent-code:dev-debug:enabled-modules`.

**How a "recording enabled" flag + start/stop plugs in**:
1. Add `recordingEnabled: envFlag('AGENT_CODE_RECORD_SESSION')` to `DevDebugConfig` in devDebug.ts
   + preload types.ts (exact `renderShadowEnabled` template — that flag was added the same way).
2. Add `record-session:start`/`stop` ipcMain handlers (guarded by `isDevDebugEnabled()`), or a
   renderer command in `features/workspace/commands/sessionCommands.ts` alongside the existing
   Save Debug Bundle command.
3. Optionally register a `sessionRecordingModule` in the devModules registry array for in-panel
   start/stop + status.

---

## 6. Redaction

`src/renderer/src/rendering/model/unknowns.ts`. Redaction is STRUCTURAL not best-effort
(comment :16). `SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|cookie|password/i` (:24).
`shapePathsOf` (:45): walks keys to depth 3, any SENSITIVE_KEY match emits
`${key}=<redacted-key>` and does NOT recurse into the value — even the KEY NAME of a secret is
stripped. `hashPayload` (:28) FNV-1a identity hash for dedupe (stores a hash, never the payload).
`redactedPreview` hard-capped `PREVIEW_MAX=80` (:100) regardless of caller.
Corpus snippet caps: `snippet()` `DIAGNOSTIC_SNIPPET_CHARS=360` (saveDebugBundle.ts:84);
extraction `TOOL_RESULT_CAP=600`, `TEXT_CAP=8000`.
Bundle-side: `sanitizeHtml` on captured DOM, proxy-events header allowlist (writer side).

**What the recorder needs to be check-in-safe as a fixture**: the recorder captures FULL pipeline
input (entries text, tool args/results, semantic block text) — far more sensitive than unknowns.
Reuse `SENSITIVE_KEY` + `shapePathsOf`/`hashPayload` for any envelope metadata, but the input
payloads themselves need a dedicated redaction pass (auth headers, API keys in tool inputs,
file contents) before a recording can ship in `testing/fixtures/`. This is the biggest GAP.

---

## REUSE MAP (capability → module to extend → gap to fill)

| Capability | Reuse / extend | Gap to fill |
|---|---|---|
| Append writer (JSONL, batched, per-session, torn-tail-safe) | `GhostJournal`/`GhostJournalRegistry` (`ghostJournal.ts`) — closest fit; OR `queueFeedDebugAppend` (`feedDebugLog.ts`) serialized-queue pattern | Add a per-tick input-plane record type; add a schema-version HEADER line (none today) |
| Renderer→main transport w/ cursors + backpressure | `useFeedDebugPersist.ts` (persisted+inFlight id cursors, one-append-per-session, retry-safe) | New IPC channel `appendSessionRecording`; new preload method |
| Retention | `scheduleDebugStoragePrune` + `DebugStorageBucket` (`debugRetention.ts`) | Add a `session-recording` bucket + budget slice |
| Per-file cap / truncation marker | feed-debug tombstone (`feedDebugLog.ts:110`) OR proxy-events `{kind:'truncated'}` header (`proxyEventsReader.ts:242`) | Pick one; recorder should tombstone |
| Compaction (bound resume/replay cost) | `compactGhostLogFile` (tmp+rename, min-size gate, session-dead guard) | Recorder may not need it if capped; reuse if it grows |
| Snapshot assembler (what to capture per tick) | `saveDebugBundle.ts` input planes (entries/semantic/ghosts/scalars) + `extract-rendering-fixtures.mjs` input reconstruction | Recorder captures input DIRECTLY per tick — eliminates transcript-reconstruction + cutoff-skew |
| Expected/output channel | feed-debug `RENDER/visible_rows` (`Feed.tsx:891`) | Recorder pairs each input tick with the resulting visible_rows |
| Replay + bless + verdicts | `bundleCorpus.test.ts` (BLESS env, triage-stability assert, sanity floor) + `triage-rendering-fixtures.mjs` (verdict taxonomy) | New corpus test over recordings; reuse `diffShadowUnits`/`ledgerUnits`/`legacyUnits` |
| Debug gate + start/stop | `devDebug.ts` `DevDebugConfig`/`renderShadowEnabled` template; devModules registry | Add `AGENT_CODE_RECORD_SESSION` flag + start/stop IPC/command |
| Redaction | `unknowns.ts` `SENSITIVE_KEY`/`shapePathsOf`/`hashPayload`; `snippet` caps; `sanitizeHtml` | Dedicated payload-redaction pass for full input text before fixture check-in (biggest gap) |

**Headline finding**: feed-debug.jsonl is the closest existing thing and supplies ~80% of the
recorder's *plumbing* (per-session JSONL, cursor persistence, cap+tombstone, retention, bundle
inclusion) and its *expected-output* channel (RENDER/visible_rows), but 0% of the *input* channel —
it stores lossy decision summaries, not faithful pipeline input. The corpus extract+replay already
DOES golden replay, but pays a heavy cost reconstructing input from transcripts with a cutoff-skew
hack that generates most of its divergence noise. The recorder's whole value is capturing the input
plane directly and continuously, then plugging into the *already-built* bless/verdict/diff machinery.
GhostJournal is the append-writer to clone; devDebug + devModules is the gate/command to extend;
unknowns.ts redaction must be strengthened for full-payload safety.
