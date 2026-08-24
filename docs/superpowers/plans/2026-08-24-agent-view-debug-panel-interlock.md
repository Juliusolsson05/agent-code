# Agent View / Debug Panel Interlock — Implementation Plan

**Status:** Visibility/transition stage implemented; awaiting third orchestration gate

**Date:** 2026-08-24

## Goal

Prevent the full-pane provider terminal and the debug panel's inline provider
terminal from simultaneously resizing the same Claude or Codex PTY when a
session uses a per-session Terminal view override.

The visible failure is unstable wrapping and repainting: the pane-sized xterm
and the much smaller debug-rail xterm both observe their own containers and
send incompatible row/column pairs to one backend. The main process correctly
supports multiple consumers of the PTY byte stream, but terminal dimensions
are singular and therefore cannot be independently owned by both views.

## Confirmed cause

The pane and the debug surface do not currently resolve display mode from the
same inputs:

- `TileTree.renderWorkspaceLeaf` combines the global setting with
  `session.agentViewModeOverride`, then mounts `AgentTerminalLeaf` when the
  effective surface is Terminal.
- `DebugSurfacesImpl` asks whether the effective surface is Terminal using only
  the global setting. It passes that answer to `DebugPanel` as
  `inlineRawTerminalDisabled`.
- With global Agent plus a per-session Terminal override, the pane mounts
  `AgentTerminalLeaf` while the debug panel still offers `AgentInlineTerminal`.
  Both call `window.api.resize(sessionId, cols, rows)`.

The existing `DebugPanel` guard is conceptually correct. This began as a
call-site policy drift introduced when per-session overrides were added after
the guard.

The first implementation made configured display policy the debug guard's
source of truth. A four-agent orchestration review then found a second, distinct
state that policy cannot answer: Settings and Reader replace the workspace
surface, so a Terminal-configured session may have no `AgentTerminalLeaf`
mounted at all. Spotlight can also change which session is actually rendered.
Suppressing the inline terminal from configuration alone therefore removes a
valid recovery tool when there is no competing dimension owner.

## Invariants

1. If an `AgentTerminalLeaf` for the debug target is actually mounted, the
   debug panel must remain useful as a read-only diagnostic panel but must not
   mount its inline interactive xterm.
2. Configured display policy still decides whether a workspace renderer mounts
   `AgentTerminalLeaf`; the debug panel consumes the resulting mount ownership
   instead of independently predicting it.
3. A per-session Agent override over a global Terminal default must not
   unnecessarily disable the inline debug terminal; the effective surface, not
   either setting in isolation, is authoritative.
4. Plain terminal sessions and OpenCode retain their existing provider-policy
   behavior.
5. PTY attach/refcount semantics in the main process are out of scope. They
   solve byte-stream lifetime, not which viewport owns a singular PTY size.

## Design

Keep the shared session-aware selector in `workspace/agentDisplayMode.ts` that
composes `resolveConfiguredAgentViewMode` with `getEffectiveAgentSurface`.

Use that selector in `TileTree`, the renderer that chooses the pane surface.
Wrap each rendered `AgentTerminalLeaf` in a small ownership boundary backed by
a provider at the app root. The boundary registers and unregisters the exact
session during React's layout-effect phase. `DebugSurfacesImpl` asks that
registry whether its target currently owns a mounted pane terminal.

WHY registration is separate from another layout selector: Agent Code has
several workspace renderers (grid, classic and tiled Dispatch, Tile Tabs, and
Spotlight), while Settings and Reader replace them. Re-enumerating those modes
inside the debug panel would create a second renderer that inevitably drifts.
The mount boundary is the inspectable fact we care about, and a refcount keeps
duplicate visible renderers of one session safe.

The second orchestration gate exposed two facts that make "mounted" alone too
weak:

- Global Editor fullscreen deliberately retains the workspace subtree under
  `display:none`. Its pane terminal is mounted but has no positive viewport and
  therefore cannot own useful dimensions. Suppressing the debug terminal in
  that state recreates the Settings/Reader bug through a different takeover.
- A recorded React effect-order experiment showed that a newly mounted pane's
  passive effect can run before the already-open inline terminal's passive
  cleanup, even when ownership is published from a layout effect. The original
  comment promising the reverse ordering was incorrect.

The ownership boundary must therefore mean **visible and resize-capable**, not
merely mounted. Global Editor will publish whether its retained workspace slot
is visible. The boundary keeps the terminal component mounted for state
retention, but hides its DOM until registration has propagated. On takeover
exit this creates a two-phase handoff: register while the pane has zero layout
dimensions, then reveal the pane in the same render that removes the inline
terminal. No effect-order assumption is required for safety.

## Regression coverage

Keep `workspace/agentDisplayMode.test.ts` coverage for session-aware policy:

1. Global Agent + session Terminal => Terminal.
2. Global Terminal + session Agent => rendered Agent surface.
3. No override follows the global setting.
4. Hybrid still follows runtime promotion rules after override resolution.

Add a renderer regression that co-renders `MainSurface` and
`DebugSurfacesImpl` under the real ownership provider:

1. Normal workspace + Terminal override mounts `AgentTerminalLeaf`, suppresses
   the inline control, and exposes only the raw text snapshot.
2. Opening Settings unmounts the pane terminal and enables the inline control.
3. Opening that inline terminal and returning to the workspace unmounts it as
   the pane terminal reclaims dimension ownership.
4. Repeat the ownership assertion for Reader or Spotlight identity where the
   focused takeover changes what is actually mounted.
5. Keep a retained pane terminal mounted but mark its containing workspace
   invisible, matching Global Editor fullscreen. The pane must remain hidden,
   release dimension ownership, and make the inline recovery terminal
   available; restoring visibility must reverse that handoff.
6. Assert the pane boundary is still layout-hidden during the registration
   render. This records the transition protection that replaces the disproven
   passive-effect ordering assumption.

## Delivery steps

1. Preserve the failing-first session-aware policy tests and shared selector.
2. Add the mount-ownership provider and boundary with a thick WHY comment
   documenting why render configuration is not mount truth.
3. Register `AgentTerminalLeaf` instances at the `renderWorkspaceLeaf` seam and
   move `DebugSurfacesImpl` to the ownership registry.
4. Add the failing takeover transition test from recorded orchestration review
   evidence before changing the implementation.
5. Add the failing retained-but-hidden Global Editor and two-phase handoff
   tests from the second orchestration gate before revising ownership.
6. Thread workspace visibility through Global Editor and make the ownership
   boundary retain-but-hide terminals until they are registered and visible.
7. Run the focused unit test, renderer tests, typecheck, and the repository's
   contract/keybinding checks. Run the full test suite and production build if
   the focused verification is clean.
8. Update this plan's status and verification record, commit the complete
   change, push the branch, and open the pull request.

## Explicit non-goals

- Redesigning debug side-panel widths. Opening a fixed-width rail legitimately
  reduces the pane viewport once; that is separate from competing PTY resizes.
- Adding multi-viewport terminal-size arbitration in `SessionManager`.
- Changing the debug panel's raw text snapshots or other debug surfaces.
- Changing Agent, Terminal, or Hybrid product semantics.

## Verification record

- The original session-aware selector test was added first and failed red
  because the selector did not exist yet. The first implementation's focused
  policy and renderer tests passed 14/14 before review.
- Initial orchestration gate `run_9a7cb5a9-7869-40e5-931c-d012a23677f8`
  returned RED. Its surviving full-diff reviewer reproduced the
  Settings/Reader takeover gap and identified that the first renderer test had
  encoded configured policy without mounting the competing terminal. The plan
  was revised before further implementation instead of adding another policy
  conditional.
- The takeover regression was added before the mount registry and failed red
  because the ownership module did not exist. After implementation, the
  session-aware policy suite and both ownership renderer suites pass: 16/16.
- The renderer transition test co-renders `MainSurface` and
  `DebugSurfacesImpl`. It proves normal workspace → Settings → normal workspace
  ownership handoff, including opening the inline terminal during takeover and
  closing it before the pane terminal reattaches. A Spotlight identity case
  proves that a terminal mounted for session B does not suppress the debug
  terminal for session A.
- TypeScript project build, test-contract check, command-keybinding check,
  production application build, packaged-output verification, and
  `git diff --check`: pass.
- Full Vitest run: 1,833/1,834 pass. The sole failure is the same unrelated,
  corpus-provenance failure on untouched `main`: the fixture
  `atp-codex-image-inside-claude-transcript` expects
  `~/.claude/projects/-Users-juliusolsson-Desktop-Development-klay/c0c60d3d-681f-4457-b5c8-bf58745625de.jsonl`.
  Its other 16 assertions pass. The missing real-data assertion was not
  weakened or replaced for this UI fix.
- The production build reports the repository's existing bundle-size and
  dynamic-import warnings and intentionally skips uncached release-only runtime
  archives.
- Second orchestration gate `run_6aa4f919-28fb-42a1-8097-b6585f059489`
  completed both independent reviews without the first gate's workflow timeout
  pathology. One review was GREEN; the other reproduced Global Editor
  fullscreen as a mounted-but-hidden false owner and recorded React's actual
  transition effect order. This plan was revised before another implementation
  change, and the gate remains RED until those recorded cases pass.
- The passive-order and retained-fullscreen regressions were recorded red before
  the ownership revision. The focused policy/ownership suite now passes 19/19,
  including a test of the real `GlobalEditorWorkspaceSlot` rather than the old
  passthrough shell mock. It proves the xterm DOM identity survives fullscreen,
  ownership is released under `display:none`, and registration propagates
  before the terminal becomes layout-visible again.
- TypeScript build, test-contract check, keybinding check, production build,
  and `git diff --check`: pass after the visibility revision. Full Vitest is
  1,837/1,838; its only failure remains the unchanged missing private corpus
  session documented above.
- Local macOS packaging cannot be regenerated in this worktree because the
  repository currently declares Electron as the range `^43.1.0`, which
  electron-builder refuses without an exact configured version. Consequently
  packaged-output verification has no new `release/mac-arm64` artifact to read;
  this is an existing packaging configuration constraint, not a test weakened
  for this change. The production application build itself is green.
