# Terminal atlas repaint

Status: implementation in progress. Refs #789.

## Evidence and scope

The user reports stale terminal cells after scrolling interactive Claude output.
The screenshot alone cannot distinguish stale GPU pixels from stale buffer data.
An isolated Electron reproduction with our pinned xterm 6.0.0/WebGL 0.19.0 proves
that atlas page merges can leave rendered pixels inconsistent with the unchanged
buffer, including during scrollback navigation. A subsequent refresh repairs them.

## Implementation

1. Keep this hotfix separate from the ongoing workspace/reactivity audit.
2. Subscribe to public atlas layout events in the shared WebGL attachment helper.
   Coalesce a full viewport refresh after the current render call finishes, using
   xterm's existing frame scheduler. Do not clear history, change PTY bytes, disable
   acceleration globally, or reach into private xterm fields.
3. Fence deferred repaint work on teardown/context loss; dispose all listeners.
4. Add lifecycle regression tests and repeat a real Electron pixel comparison with
   colored output, two terminals, scrollback, and stable buffer contents.
5. Run focused host tests/type checks, review, open a resolving/contributing PR as
   supported by the evidence, and wait for explicit merge confirmation.

## Constraints

No live app restarts or process kills. Main's existing package-lock changes and
the broader session-update-isolation worktree remain untouched. Preserve WebGL
performance: no per-byte, periodic, or unconditional per-scroll full repaint.
The exact reported screenshot still needs user confirmation after deployment.
