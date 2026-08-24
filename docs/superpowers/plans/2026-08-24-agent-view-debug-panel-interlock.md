# Agent View / Debug Panel Interlock — Implementation Plan

**Status:** Revised implementation complete; awaiting second orchestration gate

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

## Delivery steps

1. Preserve the failing-first session-aware policy tests and shared selector.
2. Add the mount-ownership provider and boundary with a thick WHY comment
   documenting why render configuration is not mount truth.
3. Register `AgentTerminalLeaf` instances at the `renderWorkspaceLeaf` seam and
   move `DebugSurfacesImpl` to the ownership registry.
4. Add the failing takeover transition test from recorded orchestration review
   evidence before changing the implementation.
5. Run the focused unit test, renderer tests, typecheck, and the repository's
   contract/keybinding checks. Run the full test suite and production build if
   the focused verification is clean.
6. Update this plan's status and verification record, commit the complete
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
