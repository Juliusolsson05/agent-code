# Incident journal accuracy (#1135)

Two defects make the incident journal point investigations at the wrong
thing. This plan fixes both at the point where the journal row is written.

## 1. `electron.child_process_gone` severity

`src/main/incident/installWindowIncidentHooks.ts`

- Today: `severity: clean ? 'warn' : 'error'`, so `reason: 'killed'` (normal
  macOS quit teardown, SIGTERM / exitCode 15) is journaled as `error`.
- The `render-process-gone` handler directly above it already treats `killed`
  as `warn` and explains why.
- Change: `clean-exit` and `killed` -> `warn`; every other reason (`crashed`,
  `oom`, `abnormal-exit`, `launch-failed`, `integrity-failure`, and any reason
  a future Electron adds) -> `error`. Unknown reasons stay `error` on purpose:
  a new failure mode must not be silently downgraded.
- Kept as-is: child `clean-exit` is still RECORDED (as `warn`), unlike the
  renderer handler which skips it. Utility/GPU child clean exits are rarer and
  are not the steady per-window-close noise the renderer skip exists for;
  changing what is recorded is out of scope for a severity fix.
- WHY comment carries the evidence: run 2026-09-20T08-34, seq 1020 (child,
  `error`) and seq 1021/1022 (render, `warn`) share a millisecond, the reason
  and exitCode 15; 11 of 13 "crash" runs in the 2026-08-30..09-22 journal
  triage were this quit-time kill.
- Test: new `installWindowIncidentHooks.test.ts` with a fake `app` emitter;
  `killed` -> `warn`, `crashed` -> `error`.

## 2. `kill.request` caller

- `src/shared/lifecycle/events.ts`: add `KILL_CALLERS` closed union +
  `KillCaller` + `isKillCaller`, mirroring `WAKE_CALLERS`. Include an explicit
  `'unknown'` member. `caller` is already an allowlisted payload key.
- Main (`sessionManager.ts`): `kill(sessionId, caller?)`,
  `killOwned({ ..., caller? })`; `killInternal` / `killOwnedInternal` take a
  required `caller`. Internal sites pass their own tag (shutdown, Codex
  replacement reclaim / handoff, recovery late-materialization cleanup,
  recovery-deadline cancel). Cascades inside kill propagate the parent's
  caller. A missing or non-union caller journals as `'unknown'`.
- Difference from wake, stated: `wake.request` is emitted in the renderer, so
  its caller never crosses IPC. `kill.request` is emitted in MAIN (the only
  place that sees every kill), so the renderer's tag must cross the
  `session:kill-owned` IPC; main re-validates it against the union.
- Renderer: `killSessionBackendIfOwned` and the `killSession` action take a
  required `KillCaller` (compiler finds every site, the same forcing function
  the wake PR used). Close paths carry the caller on `CloseSessionOptions`
  (`killCaller`) into the `CloseOperation`, so linked children closed by an
  operation are journaled with the operation's caller.
- Call sites tagged: app shutdown, Close Tab, Close Old Agents, Close Idle
  Orchestration Agents, orchestration close_agent / close_run, Agent
  Management close_agent, operator `agents.close`, focused close (keyboard /
  Dispatch row), lane close command, Agent Activity modal, extension surface
  close, spawn-unplaced cleanup, undo-close rollback, wake spawn-failed,
  replacement successor / predecessor, agent reload.
- `SessionKillOptions` (ownership tuple + optional caller) is a NEW type, not
  a field on `SessionOwnershipOptions`: that tuple is persisted on Codex
  replacement reservations/redirects, and "who asked" is per-request.
- `closeSession`'s `killCaller` stays optional (defaulting to `'unknown'`)
  rather than required: every production site passes one, but making the
  options object required would churn dozens of test call sites for no
  behavioral gain. The bulk loop and the low-level kill helpers ARE required.
- The legacy id-only `session:kill` IPC has no renderer consumer; it is left
  untagged so any use of it journals as `'unknown'`.
- Existing renderer tests that asserted exact `killOwnedSession` /
  `closeSession` arguments now also assert the caller for that path.
- Test: `sessionManager.lifecycle.test.ts` — caller passed through `kill`,
  `killOwned`, `killAll` (`app.shutdown`), `unknown` when omitted or invalid.

## Review round (PR #1136)

- The Codex same-rollout handoff kills the predecessor in MAIN, and the
  renderer skips its own `replace.predecessor` kill. So a user's Codex
  reload journaled `replacement.handoff`, which the vocabulary called a
  recovery storm. Fix: `SessionSpawnOptions.predecessorKillCaller` rides
  the spawn (replaceSession sends `replace.predecessor`). Main validates it
  and falls back to `replacement.handoff` for spawners that omit it.
  `replacement.reclaim` is the only recovery-side replacement tag.
- Main-internal kills (reclaim, late materialization, deadline) journal
  `app.shutdown` while `shuttingDown`. They only run because killAll
  cancelled their transaction.
- `wake.ready-timeout` was renamed to `wake.spawn-failed`. Since #772 the
  kill fires only for a spawned backend that died or failed before ready,
  never on a timeout.
- Tests now drive real entry points: closeFocused, and Close Old / Close
  Idle end to end through the shared bulk loop to the IPC caller. The Codex
  handoff test covers the sent tag, an omitted tag and an invalid tag.

## Verification

Once at the end: `npx tsc -b` + the two targeted vitest files, Node 24.
Never launch the app.
