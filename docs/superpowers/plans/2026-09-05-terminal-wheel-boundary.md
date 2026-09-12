# Terminal wheel boundary — #791

The real Chromium wheel probe reproduces vertical wheel input escaping a nested
terminal at its scrollback boundary. Keep xterm's normal wheel handling first;
only prevent the browser's ancestor-scroll default when vertical wheel input
reaches the terminal host unconsumed. Preserve modifier and horizontal gestures.

1. Add a disposable, bubble-phase boundary helper to all three xterm hosts.
2. Cover ordinary scrollback ownership, boundary cancellation, modifier/horizontal
   escape, and cleanup without scheduling React, repaint, or PTY work.
3. Verify with real Chromium wheel input, including alternate-screen and mouse
   reporting. Re-run affected host tests and type-checking.
4. Review and open a separate PR; no merge without final user confirmation.

This is separate from #789's atlas repair. It does not claim to reproduce every
reported scrolling problem or change providers' alternate-screen behavior.

## Verification

- Shared bubbling helper attached/disposed by all three terminal hosts.
- After integrating the approved batch, 43 affected renderer/GPU-helper tests
  pass, including all host lifetimes; type-check and the test contract pass.
- Real Electron wheel probe: control moves the outer panel 120px at the boundary;
  patched keeps it at 0px. Normal scrollback, output anchoring, alternate-screen
  arrows, and SGR mouse reporting pass in both modes.
- Probe retained as scripts/smoke-terminal-wheel.mjs, including --control.

## Re-validation on main after #873 (xterm 6.1.0-beta.304)

Main moved to exact-pinned xterm betas with WebGL re-enabled and a locally
patched resize(). Before keeping this PR, the boundary assumptions were
re-derived from the installed beta, checked against its shipped bundle
(lib/xterm.mjs), not only its sources:

- Still leaks. The viewport's scrollable element consumes a wheel only if it
  scrolled, or if `alwaysConsumeMouseWheel` / `consumeMouseWheelIfScrollbarIsNeeded`
  are set. Both default to false and `Viewport.ts` sets neither. MouseService's
  passive wheel handler returns without `preventDefault` while the buffer has
  scrollback. Same shape as 6.0.0.
- Mechanism still correct. All xterm wheel listeners sit at or below `.xterm`,
  which `open()` appends to the host, so the host's bubbling listener runs
  last. Alternate-screen arrows (`!hasScrollback`) and mouse-protocol reports
  both `preventDefault` first, so the helper's `defaultPrevented` bail keeps
  them intact.
- Merge resolutions: the boundary attaches right after `open()`; main's
  `onRendererChange` WebGL attach stays where main put it.
- The real-browser probe spawns Electron, so it was not re-run in this pass.
  Its fixture still type-matches `attachXtermWebglRenderer(term).ready`.
- On the merge (Node 24, against the patched beta install): raw
  `tsc -p tsconfig.node.json` and `tsc -p tsconfig.web.json` are clean. The
  boundary helper tests plus every AgentTerminalLeaf / TerminalLeaf renderer
  test file pass: 9 files, 62 tests.
