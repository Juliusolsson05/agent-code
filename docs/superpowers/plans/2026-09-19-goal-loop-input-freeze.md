# Goal Loop Command Input Freeze — Plan

**Issue:** #1021 (bug). **Branch:** `fix/goal-loop-input-freeze` from `origin/main` @ `cbaf48a5`.
Parent ledger: `docs/decomposition/release-readiness.md` Stage 3 (on `docs/release-readiness`).

## Problem (reproduced, not assumed)

Running **Goal Loop** (`goal-loop-preview`, palette or Cmd+Shift+Y) freezes all
input when the focused agent has no loop:

1. The command sets the app-wide `useGoalLoopView.latched` flag.
2. The capture-phase gate in `useKeybinds.ts` blocks every key while that flag
   is set.
3. `GoalLoopPane` renders `null` when there is no loop, which is the normal
   case, since only an agent starts a loop through `goal_loop_start`.

The result is an invisible trap. The composer, the terminal and the palette
chord are all swallowed, and window blur does not clear the flag. A
scratch-pad renderer test drives the real `useKeybinds` listener and the real
command, and confirms every step.

The regression came from #1008 (`c1286081`): its gate made a *visible* overlay
dismissable by keyboard, but its tests always stubbed a loop.

## Principle

`src/renderer/src/lib/interaction-ownership.ts` says input ownership follows
the **mounted DOM**, never UI-store state. The gate trusted a store flag, so
the flag and the screen could disagree, and they did.

## Changes

1. **Gate (`useKeybinds.ts`)**: swallow input only while a
   `[data-goal-loop-overlay]` element is mounted. If the latch is set but
   nothing is mounted (a terminal-only tab, an empty tab), the latch is stale:
   dismiss it and let the key route normally.
2. **Dismiss chord**: resolve through `routedCommandForEvent(...,
   GLOBAL_CONTEXT_ONLY) === 'goal-loop-preview'` instead of the hard-coded
   `Meta+Shift+KeyY`. A rebind (#1007 plans one) must not remove the keyboard
   exit.
3. **Blur**: `onBlur` also calls `dismissGoalLoop()`, the same as the TLDR latch.
4. **Pane (`GoalLoopPane.tsx`)**: while latched, the overlay always renders.
   With no loop it shows "No goal loop on this agent" and the Close button,
   the same way TLDR shows "No TLDR yet". Running the command therefore always
   visibly does something. The overlay markup is shared between the with-loop
   and no-loop states, so it keeps one ownership marker.
5. **Command description**: say how to dismiss (Escape, or run the command
   again), matching the TLDR and Goal descriptions.

## Tests (fail first, then pass)

In `goalLoop.router.renderer.test.tsx`, with no loop for the session:

- after the command, with no pane mounted (a terminal-only tab), typing
  reaches the composer and the palette chord still routes;
- with an agent pane and no loop, the overlay is visible with the empty state
  and Escape closes it;
- window blur clears the latch;
- a rebound `goal-loop-preview` chord dismisses the overlay.

The existing tests, which have a loop, must keep passing.

## Out of scope

- #1007 (choosing a new default chord away from macOS's Sticky Note service).
  That is a separate product choice; change 2 makes it safe to do.
- #1015: the one-listener-per-pane count is not a leak, so it is handled
  separately.
