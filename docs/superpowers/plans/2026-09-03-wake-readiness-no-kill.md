# Sessions: stop killing slow-booting backends on the readiness timeout

Fixes #772. Refs #774, #775, #596, #548.

## Problem

`ensureSessionLive` treats "the backend did not report input-ready within
30 s" as "the backend failed to start": it kills the process and marks the
pane failed. On a restart with a dozen CLIs starting at once, opencode
TUIs (whose readiness is merely first PTY byte + 250 ms) and Codex resumes
of large rollouts take longer than that — the lifecycle journal shows
`kill.request cause=live-entry` at 35.6–35.8 s ×3 and 69.5 s after boot,
against processes that were alive, and the same sessions re-woken by hand
became ready in 1.7–4.1 s. The pane then sits dead until the user retries
it — observed 94 s, 217 s and 556 s after boot. This is the "3-minute
boot" and the "opencode terminal resume is broken" reports.

Two amplifiers: `AgentTerminalLeaf` wakes on mount while the rehydrate
recovery is already in flight, main JOINS that recovery but still reports
`disposition: 'spawned'`, so the leaf's wake inherits the kill timer; and
the leaf retries its attach only after that wake resolves, so a raw
terminal pane is blank for the whole TUI boot even when it succeeds.

## Design

1. **A readiness timeout never kills a backend that has not exited.** On
   timeout with the runtime neither exited nor failed, the wake resolves
   ok, the pane stays `started` and not-ready (the existing "accepted
   cost" comment already argues this trade), and the journal records
   `wake.result ok:true code:'ready-timeout'`. The kill stays for backends
   that actually exited or failed to spawn (the wait rejects immediately
   for those, unchanged).
2. **Joining an in-flight recovery is not a spawn.** `SessionManager.
   recover` returns `disposition: 'joined'` when it dedupes onto an
   in-flight claim; the renderer treats it like `adopted` (no readiness
   wait). The leaf therefore attaches as soon as the recovery it joined
   resolves, i.e. as soon as the backend is live.
3. **The raw terminal never waits for readiness.** `ensureSessionLive`
   takes `{ awaitInputReady?: boolean }`; `AgentTerminalLeaf` passes
   `false` for both its wake sites. Readiness is a composer concept; a
   terminal pane shows the TUI booting and lets the user type at it.
   `providerRuntime === 'terminal'` sessions skip the wait everywhere.
4. `rehydrate`'s 30 s deadline on the recover RPC is left in place: its
   consequence is a cancelled claim and a retryable pane, not a kill.

Not in scope: bounding the boot spawn herd (#774) and moving boot-time
I/O off the critical path (#775).

## Verification

- `sessionRecovery.renderer.test.tsx`: 6/6 — spawned-alive-not-ready past the
  deadline resolves ok with no kill and pane `started`; exit-before-ready still
  fails, kills (spawned only) and marks `failed`; terminal runtime and
  `awaitInputReady: false` both skip the wait.
- `sessionManager.wake.test.ts`: 6/6 — a second wake joining an in-flight
  recovery gets `disposition: 'joined'`.
- `AgentTerminalLeaf.dimensionOwnership.renderer.test.tsx`: 3/3 — the leaf
  passes `awaitInputReady: false` on its wake sites.
- `npx tsc -b` clean.
- Environment note: a fresh `npm ci` in a new worktree breaks ALL React-hook
  renderer tests with `useRef` dispatcher-null errors (reproduced on a
  main-identical file); cloning the primary checkout's `node_modules` (APFS
  `cp -Rc`) fixes it. Not a product regression — document for future worktrees.
