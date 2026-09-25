# Screen IPC by interest (#762)

## Problem
`session:screen` is the largest IPC stream by far:
- **Share of traffic:** 93% of recorded IPC bytes in recording g00000190 (16,728 frames of about 8.8 KB over 123 minutes). The committed fixture `testing/fixtures/worktree-live-attribution/codex-live-channel-gap.json` shows the same shape: 2,358 of about 12,600 recorded events.
- **Rate:** 6–10 frames a second for each busy session. Every frame is structured-cloned, dispatched, and committed into the renderer's runtime map.

## Evidence that nothing live needs it
All consumers were mapped (file:line in PR #1236's description):
- **Main never needs the renderer's copy.** Prompt delivery, paste confirmation and readiness read the screen in main through `session.snapshotScreen()`. The raw snapshot cache (`SessionManager.lastScreenSnapshot`) and the spinner gate are untouched.
- **The composer picker is owned by conditions.** It comes from the `claude.slash-picker` condition via `applyConditionSnapshot`. The screen handler's picker write was a second writer (split authority).
- **Dead code:** `latestScreenRef` (the Enter baseline) and the renderer `claudePaste` helpers have no callers.
- **ReaderView** has no screen fallback since #855.
- **What remains is debug-only:** DebugPanel, three dev modules, debug bundles (including the 60 s autosave), and the screen-tail trace.

## Change
1. **Main, forwarder gate.** `session:screen` is forwarded only for a session that some renderer holds a lease on (`sessions/screenInterest.ts`). Every frame still feeds a bounded screen-tail history in main (`shared/debug/screenTail.ts`), because debug bundles must not depend on a panel having been open.
2. **Lease contract:**
   - `session:screen-lease` acquires a lease and seeds the current screen down the ordinary `session:screen` path, the same seed `session:recover` sends. An idle backend therefore still shows a correct panel.
   - `session:screen-release` releases a lease.
   - Leases are owned by the calling webContents and the document that took them (a per-load id minted in preload). A lease from a new document (a reload), or destruction, drops all of that owner's earlier leases, because a dying renderer never runs its cleanup. Review amendment: this replaced dropping on `did-start-navigation`, which Chromium fires before the throttle where this app blocks every `will-navigate`, so a blocked link click used to drop live leases. A release the owner does not hold is ignored.
3. **Debug bundles** read `session:get-screen-debug`: main's latest raw snapshot plus the tail history.
4. **Renderer:**
   - The screen handler applies only the screen strings.
   - DebugPanel and the dev modules that read the screen hold a lease while open (`useScreenLease`).
   - Dead code is deleted: `latestScreenRef`, `claudePaste.ts`, and `ComposerSubmitIo.getScreen`.

## Unchanged, deliberately
- Main's raw screen processing: the headless snapshot, condition parsers, prompt gate, the `lastScreenSnapshot` cache, and `ScreenFrameGate`.
- The phone feed (it taps main directly).
- Recover and resync seeds.

## Tests (fail-first where the behaviour changes)
- **Forwarder:** the recorded Claude 2.1.278 screen frame is not forwarded without a lease, is forwarded with one, and is recorded in the tail history either way. The first assertion is red on origin/main.
- **Leases:** the IPC seed on acquire; dropping when a new document leases and on destroy, but never on a navigation event; counting across owners.
- **Picker:** a screen frame carrying a picker no longer sets `runtime.picker`.
- **Mutations:** removing the gate, recording only leased frames, dropping on sub-frames, removing the seed, and restoring the picker write each fail a test.

## Risks
- **A missed release** costs bytes until that renderer reloads, never correctness.
- **Debug surfaces** show nothing new until their lease is acquired; the acquire seed covers the first frame.
- **The DevDebug copy payload** reads the renderer copy, which can be stale unless a leasing module is open. This is accepted for a copy-to-clipboard debug aid.
