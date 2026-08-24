# Agent View / Debug Panel Interlock — Implementation Plan

**Status:** Implemented

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

The existing `DebugPanel` guard is conceptually correct. This is a call-site
policy drift introduced when per-session overrides were added after the guard.

## Invariants

1. If the focused pane's effective surface is Terminal, the debug panel must
   remain useful as a read-only diagnostic panel but must not mount its inline
   interactive xterm.
2. The decision must include the global mode, the session override, provider
   capabilities, and Hybrid runtime state—the same inputs that choose the pane
   surface.
3. A per-session Agent override over a global Terminal default must not
   unnecessarily disable the inline debug terminal; the effective surface, not
   either setting in isolation, is authoritative.
4. Plain terminal sessions and OpenCode retain their existing provider-policy
   behavior.
5. PTY attach/refcount semantics in the main process are out of scope. They
   solve byte-stream lifetime, not which viewport owns a singular PTY size.

## Design

Add one shared session-aware selector in `workspace/agentDisplayMode.ts` that
composes `resolveConfiguredAgentViewMode` with `getEffectiveAgentSurface`.

Use that selector in both:

- `TileTree`, which is the source of truth for the mounted pane surface; and
- `DebugSurfacesImpl`, which decides whether the inline debug terminal is safe.

Keeping both consumers on one selector makes the required inputs explicit and
prevents another call site from accidentally dropping the override during a
future display-policy change.

## Regression coverage

Extend `workspace/agentDisplayMode.test.ts` with session-aware cases:

1. Global Agent + session Terminal => Terminal.
2. Global Terminal + session Agent => rendered Agent surface.
3. No override follows the global setting.
4. Hybrid still follows runtime promotion rules after override resolution.

The first case is the reported regression. The inverse case proves the fix is
based on the resolved surface rather than a blanket "global or override says
Terminal" condition.

## Delivery steps

1. Add the failing session-aware policy tests.
2. Add the shared selector with a thick WHY comment documenting the one-PTY,
   one-dimension-owner invariant.
3. Move `TileTree` and `DebugSurfacesImpl` to the shared selector.
4. Run the focused unit test, renderer tests, typecheck, and the repository's
   contract/keybinding checks. Run the full test suite and production build if
   the focused verification is clean.
5. Update this plan's status and verification record, commit the complete
   change, push the branch, and open the pull request.

## Explicit non-goals

- Redesigning debug side-panel widths. Opening a fixed-width rail legitimately
  reduces the pane viewport once; that is separate from competing PTY resizes.
- Adding multi-viewport terminal-size arbitration in `SessionManager`.
- Changing the debug panel's raw text snapshots or other debug surfaces.
- Changing Agent, Terminal, or Hybrid product semantics.

## Verification record

- The session-aware selector test was added first and failed red because the
  selector did not exist yet.
- Focused policy and renderer integration tests: 14/14 pass.
- TypeScript project build: pass.
- Contract check and command-keybinding check: pass.
- Production application build and packaged-output verification: pass. The
  build reports the repository's existing bundle-size/dynamic-import warnings
  and intentionally skips uncached release-only runtime archives.
- `git diff --check`: pass.
- Full Vitest run: one unrelated corpus-provenance test fails because its
  fixture cites a private Claude transcript that is absent from this machine:
  `atp-codex-image-inside-claude-transcript` expects
  `~/.claude/projects/-Users-juliusolsson-Desktop-Development-klay/c0c60d3d-681f-4457-b5c8-bf58745625de.jsonl`.
  Running that test alone on untouched `main` produces the identical failure;
  its other 16 assertions pass. The missing real-data assertion was not weakened
  or replaced for this UI fix.
