# Terminal atlas repaint

Status: implemented and locally verified; awaiting PR review/CI. Refs #789.

## Evidence and scope

The user reports stale terminal cells after scrolling interactive Claude output.
The screenshot alone cannot distinguish stale GPU pixels from stale buffer data.
An isolated Electron reproduction with our pinned xterm 6.0.0/WebGL 0.19.0 proves
that atlas page merges can leave rendered pixels inconsistent with the unchanged
buffer, including during scrollback navigation. A subsequent refresh repairs them.

## Implementation

1. Keep this hotfix separate from the ongoing workspace/reactivity audit.
2. Subscribe to public atlas layout events in the shared WebGL attachment helper.
   Coalesce texture-binding invalidation and a full viewport refresh after the
   current render call finishes, using xterm's existing frame scheduler. Do not
   clear history, change PTY bytes, or disable acceleration globally.
   A fresh independently cached pixel oracle disproved the refresh-only approach:
   per-page version collisions can leave stale GPU textures even after cell
   coordinates are repaired. The stable addon has no public binding-invalidation
   API, so use one shape-checked private bridge to setAtlas with the existing atlas,
   isolated in the addon loader. No glyph-cache eviction or theme/OSC palette reset.
   Remove the bridge once a stable addon includes upstream xterm.js #5883.
3. Fence deferred repaint work on teardown/context loss; dispose all listeners.
4. Add lifecycle regression tests and an opt-in real Electron regression script
   with colored output, two terminals, scrollback, stable buffer contents, and a
   fresh independently cached reference. Verify the unwrapped-addon control fails
   the pixel comparison and the actual production loader passes.
5. Run focused host tests/type checks, review, open a resolving/contributing PR as
   supported by the evidence, and wait for explicit merge confirmation.

## Constraints

No live app restarts or process kills. Main's existing package-lock changes and
the broader session-update-isolation worktree remain untouched. Preserve WebGL
performance: no per-byte, periodic, or unconditional per-scroll full repaint.
The exact reported screenshot still needs user confirmation after deployment.

## Verification

- Type-check and 25 focused unit/mounted-terminal tests passed.
- Test-contract check and whitespace validation passed.
- Opt-in real Electron control reproduced 33 output-frame mismatches, one
  scroll-frame mismatch, and 1,264,868 differing pixel channels against a fresh
  independent atlas. Production loader: zero mismatches in the same workload,
  including the independent reference; WebGL remained active.
- The smoke script is repeatable and keeps synthetic screenshots/JSON in its
  printed temporary artifact directory. No live sessions or app profile touched.
