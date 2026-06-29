# Performance and Incident Journal Plan

Status: planning artifact only. No runtime changes are implemented by this file.

Date: 2026-06-25

## Goal

Build an always-on, low-cost performance and incident spine for Agent Code so crashes, freezes, near-OOM events, session deaths, orchestration failures, and startup failures leave durable evidence in normal user runs.

The key shift is to stop treating opt-in performance tracing as crash reporting. `AGENT_CODE_PERF` is useful for deep traces, but the failures we most need to understand often happen when that flag is off, the renderer is gone, or the main process is about to exit. The plan is to add a main-owned app run journal first, then wire existing diagnostics into it over several small PRs.

## Current Diagnosis

Agent Code already has several useful diagnostic systems:

- `PerformanceService` records spans, metrics, errors, slow events, process telemetry, and JSONL runs when `AGENT_CODE_PERF=1`.
- The main-process heap watchdog is always on and can write a near-OOM heap snapshot.
- Debug bundles, feed-debug files, proxy logs, performance runs, heap snapshots, and ghost logs already have local storage roots and retention policies.
- SessionManager, orchestration bridge, MCP host, git queues, worktree indexes, and debug storage contain hard-won backpressure rules.

The missing primitive is not another log file in isolation. The missing primitive is an always-on `AppRunJournal` that creates one durable run id and records the lifecycle events that explain how the app got into a bad state.

Right now, evidence is scattered by subsystem. A crash investigation often requires manually matching timestamps between performance runs, heap snapshots, proxy directories, debug bundles, transcripts, MCP requests, workspace state, and process exits. That is slow and lossy, especially after a restart.

## Non-Goals

Do not start with a full diagnostics UI. The first milestone should prove that the files are useful from disk.

Do not make debug bundles the incident database. Bundles are snapshots assembled after the fact; incidents need a durable main-owned journal that keeps working when the renderer is unavailable.

Do not record raw PTY streams, full IPC payloads, full proxy bodies, transcript contents, or workspace snapshots into an always-on log. The journal should record lifecycle transitions, bounded metadata, counters, paths, ids, and short redacted error details.

Do not depend on renderer cooperation for crash classification. Renderer hooks are useful later, but main must be able to report a renderer crash, unresponsive window, failed preload, failed page load, prior unclean shutdown, and child process death on its own.

Do not add remote telemetry in this plan. Keep the system local, inspectable, and privacy-preserving.

## Architecture

Add a main-owned diagnostics service:

```text
src/main/incident/
  AppRunJournal.ts
  appRunIds.ts
  installCrashHooks.ts
  installWindowIncidentHooks.ts
  previousRunClassifier.ts
  incidentArtifacts.ts
  journalTypes.ts
```

The service owns a single `appRunId` generated early in main startup. Every local diagnostic artifact created during that process lifetime should be able to reference that id.

Recommended storage layout:

```text
~/.config/agent-code/incidents/
  runs/
    <appRunId>/
      manifest.json
      heartbeat.json
      events.jsonl
      incidents.jsonl
      clean-shutdown
      artifacts.json
```

Recommended run id shape:

```text
<startedAtIsoSafe>-main-<pid>-<shortRandom>
```

Example:

```text
2026-06-25T14-03-22-481Z-main-51234-a83f19
```

## Core Invariants

The journal is always on. It must not depend on `AGENT_CODE_PERF`.

The hot path is bounded. Queues have fixed limits, drop-oldest behavior, and dropped counters.

The heartbeat is overwrite-only. It should not grow with time.

The event log is append-only JSONL but bounded by retention and modest per-record payloads.

Fatal handlers use synchronous writes. An `uncaughtException` path or crash-adjacent path cannot rely on async work draining before process death.

Large artifacts are referenced, not copied. Heap snapshots, minidumps, proxy logs, debug bundles, and transcripts should be linked by path/id.

The renderer is never the source of truth for main/process health. Renderer reports enrich the journal; they do not gate it.

## Data Model

### Manifest

`manifest.json` is written once near startup and amended only for small fields that become available later.

Suggested fields:

```json
{
  "schemaVersion": 1,
  "appRunId": "2026-06-25T14-03-22-481Z-main-51234-a83f19",
  "startedAt": 1782396202481,
  "startedAtIso": "2026-06-25T14:03:22.481Z",
  "pid": 51234,
  "platform": "darwin",
  "arch": "arm64",
  "node": "v...",
  "electron": "...",
  "chrome": "...",
  "appVersion": "...",
  "stateDir": "/Users/.../.config/agent-code",
  "perfEnabled": false,
  "lock": {
    "result": "acquired",
    "token": "..."
  }
}
```

### Heartbeat

`heartbeat.json` is overwritten every few seconds with the most recent cheap system state.

Suggested fields:

```json
{
  "schemaVersion": 1,
  "appRunId": "...",
  "seq": 42,
  "ts": 1782396220000,
  "uptimeMs": 17519,
  "pid": 51234,
  "memory": {
    "rss": 123456789,
    "heapUsed": 45678901,
    "heapTotal": 67890123,
    "heapLimit": 4294967296,
    "external": 12345,
    "arrayBuffers": 6789
  },
  "mainEventLoop": {
    "delayMeanMs": 3.2,
    "delayP99Ms": 18.4
  },
  "window": {
    "created": true,
    "readyToShow": true,
    "focused": true,
    "unresponsive": false
  },
  "sessions": {
    "known": 7,
    "provider": 5,
    "terminal": 2
  },
  "orchestration": {
    "activeRequests": 0,
    "knownChildren": 6
  },
  "lastEventSeq": 128
}
```

### Event

`events.jsonl` records compact lifecycle events.

Suggested fields:

```json
{
  "schemaVersion": 1,
  "seq": 129,
  "ts": 1782396225123,
  "tsIso": "2026-06-25T14:03:45.123Z",
  "appRunId": "...",
  "area": "session",
  "name": "session.spawn.started",
  "severity": "info",
  "ids": {
    "sessionId": "...",
    "providerSessionId": "...",
    "orchestrationRunId": "..."
  },
  "data": {
    "kind": "codex",
    "cwd": "/Users/...",
    "resume": true
  }
}
```

### Incident

`incidents.jsonl` records higher-level failure facts. An incident is an event that is expected to matter after restart.

Suggested kinds:

- `main.uncaught_exception`
- `main.unhandled_rejection`
- `main.warning`
- `app.prior_unclean_shutdown`
- `window.render_process_gone`
- `window.unresponsive`
- `window.responsive`
- `window.preload_error`
- `window.did_fail_load`
- `electron.child_process_gone`
- `heap.pressure`
- `session.process_died`
- `orchestration.request_timeout`
- `orchestration.prompt_delivery_failed`
- `mcp.host_start_failed`
- `workspace.bootstrap_failed`

Suggested fields:

```json
{
  "schemaVersion": 1,
  "incidentId": "2026-06-25T14-04-02-153Z-f4e912",
  "appRunId": "...",
  "ts": 1782396242153,
  "kind": "window.render_process_gone",
  "severity": "fatal",
  "process": "renderer",
  "reason": "oom",
  "exitCode": 9,
  "error": {
    "name": "Error",
    "message": "...",
    "stack": "..."
  },
  "context": {
    "heapUsed": 123,
    "rss": 456,
    "uptimeMs": 789,
    "knownSessions": 3
  },
  "artifacts": [
    {
      "type": "heartbeat",
      "path": ".../heartbeat.json"
    },
    {
      "type": "events",
      "path": ".../events.jsonl"
    }
  ]
}
```

## Phase 1: App Run Journal Backbone

Implement the boring file spine first.

Files to add or change:

- `src/main/incident/AppRunJournal.ts`
- `src/main/incident/journalTypes.ts`
- `src/main/incident/appRunIds.ts`
- `src/main/storage/paths.ts`
- `src/main/storage/debugRetention.ts`
- `src/main/index.ts`

Work:

1. Add an incidents storage root.
2. Generate `appRunId` after state/process lock acquisition and before the brittle startup sequence continues.
3. Write `manifest.json`.
4. Start a low-frequency heartbeat timer.
5. Add an append-only bounded `events.jsonl` writer.
6. Add `markCleanShutdown()` and call it from `before-quit` and `will-quit`.
7. Add retention rules for the incident run directories.

Events to record in the first PR:

- `app.starting`
- `state_lock.acquired`
- `state_lock.refused`
- `toolchain.start`
- `toolchain.end`
- `toolchain.error`
- `tmux.detect.start`
- `tmux.detect.end`
- `tmux.recovery.start`
- `tmux.recovery.end`
- `mcp_host.start`
- `mcp_host.end`
- `mcp_host.error`
- `window.create.start`
- `window.create.end`
- `workspace.bootstrap.status`
- `app.before_quit`
- `app.will_quit`
- `app.shutdown.clean`

Why this phase first:

The app currently has several diagnostics, but no shared timeline. This phase creates the spine that later phases can attach to without blocking on UI, renderer changes, or perf-mode traces.

## Phase 2: Prior-Run Classification

Classify the previous run at startup.

Files to add or change:

- `src/main/incident/previousRunClassifier.ts`
- `src/main/incident/AppRunJournal.ts`
- `src/main/storage/processLock.ts`
- `src/main/index.ts`

Work:

1. On startup, scan the latest previous incident run directory.
2. Read its `manifest.json`, `heartbeat.json`, `events.jsonl` tail, and `clean-shutdown` marker.
3. If `clean-shutdown` is missing, write an `app.prior_unclean_shutdown` incident for the new run.
4. Include stale process-lock evidence when available: owner pid, owner start time, lock token, and liveness adjudication.
5. Attach likely related artifacts by path and mtime: heap snapshots, performance run dir, debug bundle autosave/manual dirs, crash dumps if Crashpad is enabled.

Classification values:

- `clean`
- `unclean_shutdown`
- `stale_heartbeat`
- `main_crash_suspected`
- `renderer_crash_suspected`
- `force_quit_or_power_loss`
- `unknown`

Why this phase matters:

The most valuable moment to classify a crash is the next launch. The previous process is gone, but its heartbeat and missing clean marker are still available. Waiting until the user manually creates a debug bundle loses causality.

## Phase 3: Crash and Freeze Hooks

Add always-on main and window hooks.

Files to add or change:

- `src/main/incident/installCrashHooks.ts`
- `src/main/incident/installWindowIncidentHooks.ts`
- `src/main/window/mainWindow.ts`
- `src/main/index.ts`

Process-level hooks:

- `process.on('uncaughtException')`
- `process.on('unhandledRejection')`
- `process.on('warning')`

Electron app/window hooks:

- `crashReporter.start({ uploadToServer: false })`, if compatible with current app packaging.
- `app.on('render-process-gone')`
- `app.on('child-process-gone')`
- `BrowserWindow.on('unresponsive')`
- `BrowserWindow.on('responsive')`
- `webContents.on('preload-error')`
- `webContents.on('did-fail-load')`

Policy:

- `uncaughtException` writes synchronously, then exits. Do not keep running after an uncaught main exception.
- `unhandledRejection` is non-fatal but rate-limited and coalesced by message.
- `render-process-gone` with `oom`, `crashed`, `killed`, `abnormal-exit`, or `launch-failed` is high or fatal severity.
- `clean-exit` is ignored unless it happens during an unexpected lifecycle phase.
- `unresponsive` writes a start incident; `responsive` writes a recovery incident with duration.

Why this phase is separate:

Crash hooks are easy to add badly. They need synchronous fallback writes, recursion guards, dedupe, and conservative exit policy. Keeping them separate makes review easier.

## Phase 4: Heap Watchdog Integration

Turn the existing heap watchdog from a silent artifact producer into an incident producer.

Files to change:

- `src/main/performance/heapWatchdog.ts`
- `src/main/incident/AppRunJournal.ts`

Work:

1. When the heap watchdog crosses its threshold, record `heap.pressure`.
2. Include heap used, heap limit, rss, pid, uptime, and snapshot path.
3. Stamp snapshot filenames or sidecars with `appRunId`.
4. Keep the existing single-shot behavior.
5. Do not start periodic heap snapshots.

Why this phase matters:

Near-OOM is exactly the kind of performance incident that users need to diagnose later. Today the snapshot may exist, but nothing tells the rest of the app that it happened.

## Phase 5: Session Lifecycle Events

Record process lifecycle transitions for provider and terminal sessions.

Files to change:

- `src/main/sessionManager.ts`
- `src/main/sessions/forwarder.ts`
- `src/main/incident/AppRunJournal.ts`

Events to record:

- `session.spawn.requested`
- `session.spawn.reserved`
- `session.spawn.started`
- `session.spawn.failed`
- `session.pty.first_byte`
- `session.provider.first_semantic_event`
- `session.input.write_requested`
- `session.input.write_failed`
- `session.kill.requested`
- `session.exit`
- `session.removed`

Incident cases:

- Spawn failure.
- Provider process exits unexpectedly while active.
- `SIGKILL`, `SIGTERM` without a user action, exit code greater than 128, or platform crash code.
- Input write fails because main has no backend session for a renderer-owned session id.

Important restart bug tie-in:

The recent "all restored agents are null until reload" issue should become visible here. When a restored renderer pane sends input to a session id that main does not own, the journal should record a `session.input.write_failed` event and a higher-level incident if the session was presented as started/ready.

Why this phase matters:

Agent Code is process orchestration software. If a child process dies, fails to spawn, or exists only as renderer metadata after restart, that must be durable evidence.

## Phase 6: Orchestration and MCP Bridge Events

Add durable events around orchestration request delivery and MCP tool calls.

Files to change:

- `src/main/orchestration/OrchestrationBridge.ts`
- `src/mcp/runtime/createBuiltInMcpServer.ts`
- `src/mcp/runtime/BuiltInMcpHttpHost.ts`
- `src/main/incident/AppRunJournal.ts`

Events to record:

- `orchestration.request.queued`
- `orchestration.request.dispatched`
- `orchestration.request.renderer_timeout`
- `orchestration.request.completed`
- `orchestration.agent.created`
- `orchestration.agent.closed`
- `orchestration.prompt.submit_requested`
- `orchestration.prompt.readiness_checked`
- `orchestration.prompt.write_succeeded`
- `orchestration.prompt.write_failed`
- `mcp.host.started`
- `mcp.request.received`
- `mcp.tool.started`
- `mcp.tool.failed`
- `mcp.tool.completed`

Incident cases:

- Renderer bridge timeout.
- `orchestration_send_prompt` fails because `SessionManager.getSessionKind(sessionId)` returns null.
- Prompt readiness check never resolves.
- Built-in MCP host cannot start.
- MCP request queue depth or latency crosses a threshold.

Why this phase matters:

The orchestration bridge crosses main, renderer, MCP, workspace placement, and provider process state. A durable timeline is necessary because any one of those surfaces can be the failing source of truth.

## Phase 7: Debug Bundle and Artifact Correlation

Stamp existing artifacts with `appRunId` and related ids.

Files to change:

- `src/main/storage/debugBundle.ts`
- `src/main/performance/PerformanceService.ts`
- `src/main/performance/storage/performanceLog.ts`
- `src/main/storage/feedDebugLog.ts`
- Proxy metadata writers in provider packages, where practical.

Work:

1. Include `appRunId` in new debug bundle manifests.
2. Include a bounded tail of `events.jsonl` and the latest `heartbeat.json` in debug bundles.
3. Include `appRunId` in performance run manifests.
4. Include `appRunId`, `sessionId`, and `providerSessionId` in proxy/feed-debug metadata when metadata files already exist.
5. Link heap snapshots to the current `appRunId`.

Why this phase matters:

The journal becomes much more valuable when every other artifact can be correlated without timestamp guessing.

## Phase 8: Optional Renderer Enrichment

Add renderer-side reporting after main-owned crash coverage is in place.

Files to add or change:

- `src/preload/*`
- `src/main/ipc/*`
- `src/renderer/src/*`

Hooks:

- `window.addEventListener('error')`
- `window.addEventListener('unhandledrejection')`
- React error boundary around the app shell.
- Renderer bootstrap milestone reports.
- Workspace persistence save/restore milestone reports.

Policy:

- Renderer reports are breadcrumbs and non-fatal incidents.
- Rate-limit and coalesce by error message and source.
- Never send large state snapshots through the incident IPC.
- Keep text payloads short and redacted.

Why this phase comes later:

Renderer errors are useful, but they cannot explain renderer crashes if the renderer is already gone. Main-owned hooks must land first.

## Retention and Backpressure

Add incident runs to debug retention:

- Keep the most recent 50 incident run directories regardless of TTL.
- Apply the normal disk budget to older run directories.
- Keep `manifest.json`, `heartbeat.json`, `incidents.jsonl`, and small event tails as long as practical.
- Do not copy heap snapshots, minidumps, proxy logs, or transcripts into incident directories by default.
- Store paths and ids for large artifacts.

Runtime bounds:

- Event queue max: 2,000 pending records.
- Breadcrumb ring max: 512 records.
- Single heartbeat write in flight.
- One journal append queue per app run.
- Drop oldest on queue overflow and record a dropped counter.
- Unref all recurring timers.

Payload bounds:

- Truncate error stacks.
- Truncate paths only if necessary for privacy; preserve enough to find local files.
- Never store prompt bodies, model responses, raw PTY output, or full transcript entries in the always-on journal.
- For repeated errors, coalesce by `kind + message + source` over a time window and record occurrences.

## Implementation Order

Recommended PR sequence:

1. `AppRunJournal` backbone, incidents storage root, heartbeat, clean shutdown marker, retention.
2. Previous-run classifier.
3. Main/window crash and freeze hooks.
4. Heap watchdog incident integration.
5. Session lifecycle event instrumentation.
6. Orchestration/MCP bridge event instrumentation.
7. Debug bundle and artifact correlation.
8. Renderer-side enrichment.
9. Minimal local viewer or "reveal incident folder" command, only after the file model proves useful.

## Acceptance Criteria

After Phase 1:

- A normal app launch creates exactly one incident run directory.
- The run directory has `manifest.json`, `heartbeat.json`, and `events.jsonl`.
- Clean app quit writes `clean-shutdown`.
- The heartbeat updates while the app is alive and does not grow unbounded.
- Retention sees incident runs as a known bucket.

After Phase 2:

- Killing the app without clean shutdown produces an `app.prior_unclean_shutdown` incident on next launch.
- The incident points to the previous run directory.
- The classifier does not overwrite or delete previous-run evidence.

After Phase 3:

- A simulated renderer crash records a `window.render_process_gone` incident.
- A simulated unresponsive window records `window.unresponsive` and later `window.responsive`.
- A thrown main-process exception writes a synchronous fatal incident before exit.

After Phase 4:

- A forced low heap threshold records `heap.pressure`.
- The incident links to the written heap snapshot.

After Phase 5:

- Provider spawn failures and unexpected provider exits appear in `events.jsonl` or `incidents.jsonl`.
- A missing backend session write is durable evidence, not only a renderer toast or thrown promise.

After Phase 6:

- Orchestration request timeouts and prompt write failures can be reconstructed from `events.jsonl` without asking the renderer for live state.

After Phase 7:

- A debug bundle includes the current `appRunId`, latest heartbeat, and bounded journal tail.
- Performance run manifests include `appRunId` when performance mode is enabled.

## Manual Verification Scenarios

Use manual smoke checks before building a larger test harness:

1. Launch app, wait 10 seconds, quit cleanly.
2. Launch app, kill main process, relaunch.
3. Force a renderer crash or simulate `render-process-gone`.
4. Temporarily lower heap watchdog threshold and verify `heap.pressure`.
5. Start a provider session, kill the child process, verify `session.exit`.
6. Trigger an orchestration prompt to a missing restored session id, verify `orchestration.prompt.write_failed`.
7. Save a debug bundle and verify it contains `appRunId` plus journal/heartbeat references.

## Open Questions

Should `crashReporter.start()` be enabled immediately, or should the first PR only build the journal and add Crashpad in the crash-hook PR after packaging behavior is checked?

Should incident files live under `incidents/runs/<appRunId>/` or under a more general `app-runs/<appRunId>/` root? `incidents` is clearer for users; `app-runs` is more accurate for normal runs that have no incidents.

How aggressive should the protected retention count be? The plan suggests 50 recent run directories, but the right number depends on observed file sizes.

Should `AppRunJournal` be exported as a singleton, passed through constructors, or exposed through a small `getAppRunJournal()` accessor? Constructor injection is cleaner, but the current main-process startup shape may make a singleton more pragmatic.

Should renderer-side errors be shown to the user immediately, or only written into diagnostics? The first implementation should write only; user-facing UI can follow once false-positive volume is understood.

## First PR Recommendation

Start with the `AppRunJournal` backbone and nothing more dramatic:

- Create the incident run directory.
- Write `manifest.json`.
- Overwrite `heartbeat.json`.
- Append compact `events.jsonl` records.
- Mark clean shutdown.
- Classify obvious unclean previous run on next launch.
- Register retention for the new storage root.

That creates the durable performance/incident foundation every later fix can attach to. It also keeps the first diff reviewable: no renderer IPC, no dashboard, no policy-heavy restart behavior, and no provider lifecycle rewrites in the first step.
