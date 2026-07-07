# Session Recording — where to tap, lifecycle, mapping, determinism

## 1. The main→renderer data flow (the chokepoint)

Producer runtimes → `SessionManager` (`src/main/sessionManager.ts`) emits typed events
via `this.emit(name, payload)` (see lines 520–580: started/screen/jsonl-entry/
jsonl-error/process-state/conditions/semantic-event/removed/exit).

`wireSessionForwarder(manager, lspManager)` — `src/main/sessions/forwarder.ts` — is the
dumb bridge: one `manager.on(evt, p => sendToMainWindow(channel, p))` per event. Wired
once at `src/main/index.ts:513`.

**Exception — jsonl:** `manager.on('jsonl-entry')` does NOT send directly. It calls
`enqueueJsonl()` (coalescer). The bulk `session:jsonl-entries` payload the renderer
actually folds is sent from `src/main/sessions/jsonlCoalescer.ts:57` (one `setImmediate`
flush per burst). The singular `session:jsonl-entry` channel was DELETED — everything is
bulk now (1-element bursts for live entries).

**THE single narrowest funnel:** `sendToMainWindow(channel, ...args)` —
`src/main/window/mainWindow.ts:73`. This is the one place all of main reaches into
`webContents.send`. It sees BOTH the forwarder's direct sends AND the coalescer's bulk
flush — i.e. the exact post-coalesce payloads the renderer's SessionFeed delivers. Its own
comment calls it "the ONE place the rest of main/ should reach into the BrowserWindow."

Renderer side: `useIpcSubscriptions.ts` subscribes through the injected `SessionFeed`
(`src/shared/sessionFeed/SessionFeed.ts`) — 9 `onSession*` listener methods, one per
channel. The desktop feed is a pass-through to `window.api.onSession*` → `ipcRenderer.on`.
Tests already inject a `FakeSessionFeed` — this is the pre-existing replay seam.

### Rendering-relevant channels (the complete input stream) — 1:1 with SessionFeed
| IPC channel | SessionFeed callback | Payload shape (`src/shared/sessionFeed/types.ts`) |
|---|---|---|
| `session:started` | onSessionStarted | `{sessionId, kind, projectDir?}` |
| `session:screen` | onSessionScreen | `{sessionId, plain, markdown, recent, recentMarkdown, picker}` |
| `session:jsonl-entries` | onSessionJsonlEntries | `{sessionId, entries:[{entry, file}]}` (BULK — only entry channel) |
| `session:jsonl-error` | onSessionJsonlError | `{sessionId, message}` |
| `session:semantic-event` | onSessionSemanticEvent | `{sessionId, event}` (provider SemanticEvent, `unknown`) |
| `session:conditions` | onSessionConditions | `{sessionId, snapshot: ProviderConditionSnapshot}` |
| `session:process-state` | onSessionProcessState | `{sessionId, active, status?}` |
| `session:sub-agents` | onSessionSubAgents | `{sessionId, subAgents: Record<toolUseId, SubAgentState>}` |
| `session:exit` | onSessionExit | `{sessionId, exitCode, signal?}` |

NOT rendering-relevant (exclude): `session:terminal-data`, `session:agent-pty-data` (raw
PTY bytes, not SessionFeed events), `lsp:diagnostics`. So the recorder must use an EXPLICIT
9-channel allowlist, NOT a naive `session:` prefix (the two pty channels share the prefix).

## 2. Main vs renderer recording — record in MAIN

**Recommendation: record in MAIN at `sendToMainWindow`, 9-channel allowlist.**

Justification:
- Sees the EXACT post-coalesce payload set the renderer's SessionFeed delivers (bulk
  jsonl, not singular). channel→callback is a stable 1:1 map → trivial deterministic replay.
- Natural file-write context. Main already owns EVERY disk writer: ghostJournal,
  feedDebugLog, debugBundle. Recording here is zero extra IPC.
- Survives renderer crash/reload — a recording is most valuable exactly when the renderer
  misbehaves.
- Pure observer bolted onto an existing funnel; no new renderer→main channel.

**IPC round-trip cost of renderer-side writes (confirmed):** the renderer NEVER writes disk
directly. Every renderer→disk path is an async `ipcRenderer.invoke` to a main handler that
owns the `fs` call:
- feed-debug: `window.api.appendFeedDebugLog` → `ipcRenderer.invoke('debug:append-feed-log')`
  (`src/preload/api/debug.ts:22`) → `queueFeedDebugAppend` (`src/main/ipc/debug.ts:35`).
- ghosts: `window.api.ghostAppend` → `ipcRenderer.invoke('ghost:append')`
  (`src/preload/api/ghost.ts`) → `ghostJournals.get(id).append` (`src/main/ipc/ghost.ts:20`).
- debug bundle: `ipcRenderer.invoke('debug:save-bundle')` → `saveDebugBundle`.

So a renderer-side recorder would have to invoke main per batch anyway — pushing the SAME
data renderer→main that main already has at the funnel. Recording in the renderer pays an
IPC tax and risks losing the in-flight buffer on crash, for zero completeness gain (renderer
receives the identical 9 events). The replay consumer (collectLedgerInput → SessionRuntime)
lives in the renderer, but its input arrives via SessionFeed, so recording upstream of
SessionFeed in main is strictly closer to source and equally faithful.

## 3. Start/stop mechanics (mirror SubAgentWatcherManager)

Pattern to copy: `SubAgentWatcherManager` (`src/main/subagents/index.ts`) +
`GhostJournalRegistry` (`src/main/ghostJournal.ts`).

- **`SessionRecorderManager`** constructed once in `forwarder.ts` next to
  `new SubAgentWatcherManager(...)` (or in `index.ts` beside `ghostJournals`). Owns
  `Map<sessionId, SessionRecorder>`.
- **`SessionRecorder`** = append-only JSONL writer, one file per session under
  `<userData>/recordings/<sessionId>-<startedAt>.rec.jsonl`. Copy ghostJournal's per-session
  file + 100ms batched-drain writer verbatim (recording volume ≤ ghost volume).
- **ensure(sessionId)** lazily on first allowed event for that session (mirrors
  `SubAgentWatcher.ensure`). Writes a header line (providerSessionId, kind, cwd, wall-clock
  start) then payload lines.
- **stop(sessionId)** on `manager.on('removed')` — the exact site forwarder already calls
  `subAgents.stop(payload.sessionId)` and `flushAndDropJsonl` (`forwarder.ts:74-75`). Final
  flush + close.
- **stopAll()/flushAll()** on app quit — mirror ghost's `flushAll()` before `app.exit` and
  `compactAllGhostLogs` in `index.ts`.
- **Gate:** add `AGENT_CODE_SESSION_RECORD` to `DevDebugConfig` in
  `src/main/ipc/devDebug.ts` (same channel as renderShadow/renderPipeline). IPC is the trust
  boundary — recordings contain full transcript/user input, so gate reads there like
  `dev-debug:read-paste-events` does. A command-palette "Start/Stop Session Recording" flips
  a boolean the manager consults; because the tap is a passive observer, "start" = set
  `recording=true` and begin appending, "stop" = flush+false. No teardown of the data flow.
- **One session vs all:** record ALL sessions when enabled, ONE FILE PER SESSION keyed by
  sessionId. Rationale: tiled-dispatch bugs are cross-session (#290 misattached transcripts);
  per-session files keep replay isolatable; every payload already carries sessionId so
  partitioning is free at the funnel.

## 4. Timestamp determinism

The ledger/render path is PURE w.r.t. wall-clock — confirmed:
- `committed.ts:60` explicitly forbids it: "Never substitute Date.now(): resume comparisons
  … producer wall-clock." Ownership keys on entry `timestamp` (producer wall-clock, IN the
  payload).
- `ghostPredicate.ts` has NO `Date.now`/`nowMs`/`now` — it gates on `lastJsonlEntryAtMs`,
  which is derived from `entry.timestamp` (`useIpcSubscriptions.ts:1613-1618`,
  `Date.parse(ts)`), not the clock.
- The ONLY `Date.now()` in the adapter (`collectLedgerInput.ts:265,308`) feeds the DEV-ONLY
  unknown-registry `firstSeenAt` telemetry — never render output.

Wall-clock dependencies that DO exist live in the renderer FOLD (not the pure ledger):
- Orphan/superseded ghost sweep timer — `useIpcSubscriptions.ts:349-452`, `Date.now()` every
  1s.
- Handler stamps set via `Date.now()`: `unreadSince`, and stream-phase times
  (`turnStartedAt`/`phaseChangedAt`/`submittedAt` via `reduceStreamPhase`).

**Record line shape:** `{ t: <monotonic ms since recording start>, wall: <Date.now() at
capture>, ch: <channel>, payload }`. `t` is monotonic for ordering/pacing; `wall` captures
the clock the fold's Date.now() sites would have read.

**Replay:** sort by `t`, dispatch each `payload` to the channel's SessionFeed callback (via a
`RecordedSessionFeed` implementing the interface, like `FakeSessionFeed`). Replay does NOT
reproduce wall-clock for the LEDGER — it's pure over payload + entry.timestamp (both in the
recording). For deterministic FOLD, inject `wall` as the clock the orphan-sweep and handler
stamps read instead of `Date.now()` (an injectable `now()`). Every ownership decision is
already pure; the only clock reads left become deterministic once fed `wall`.

## 5. Multi-session & keying

- Per-session file (recommended), keyed by internal **`sessionId`** — the workspace/tile key,
  stable for the pane's lifetime.
- Do NOT key on `providerSessionId`: it is mutable/provisional
  (`src/renderer/src/workspace/providerSessionIdentity.ts` — proxy-header id is provisional
  and gets UPGRADED/REPLACED by the first JSONL-backed id; resume changes it). Record it as
  metadata in the file header when observed (arrives via session_meta / entry sessionId /
  `provider_session_observed` semantic event).
- The funnel payload always carries sessionId → free partitioning across tiled sessions.

## RECOMMENDATION SUMMARY

- **Tap point:** `src/main/window/mainWindow.ts:73` inside `sendToMainWindow` — a guarded
  `sessionRecorder?.observe(channel, args[0])` filtered by the explicit 9-channel allowlist.
  (Alternative two-site tap in `forwarder.ts` + `jsonlCoalescer.ts:57` also works but the
  funnel is one site and already sees both.)
- **Lifecycle:** `SessionRecorderManager` mirroring `SubAgentWatcherManager`; per-session
  append-only JSONL under `<userData>/recordings/` mirroring `GhostJournalRegistry`
  (100ms batch); ensure-on-first-event, stop on `manager.on('removed')`, flushAll on quit;
  gated by `AGENT_CODE_SESSION_RECORD` in `devDebug.ts`.
- **Replay:** `RecordedSessionFeed implements SessionFeed` (like `FakeSessionFeed`) replays
  the 9 channel→callback lines in `t` order; inject `wall` as the fold's clock.
- **Record = the 9 SessionFeed events, verbatim payloads, one file per sessionId.**
