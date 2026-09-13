# Terminal wheel boundary — #791

The real Chromium wheel probe reproduces vertical wheel input escaping a nested
terminal at its scrollback boundary. Keep xterm's normal wheel handling first;
only prevent the browser's ancestor-scroll default when vertical wheel input
reaches the terminal host unconsumed. Preserve modifier and horizontal gestures.

1. Add a disposable, bubble-phase boundary helper to all three xterm hosts.
2. Cover ordinary scrollback ownership, boundary cancellation, modifier/horizontal
   escape, and cleanup without scheduling React, repaint, or PTY work. (Review
   round: Alt is not a browser gesture but xterm's fast scroll, so only
   Ctrl/Meta/Shift and horizontal input escape; see "Review round" below.)
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

## Review round (Codex + Claude reviews of 05567575)

- Alt+wheel (Codex major, Claude F5): Alt is xterm's `fastScrollSensitivity`
  gesture, and at a boundary xterm leaves it unconsumed like a plain wheel.
  The helper no longer exempts Alt. Ctrl/Meta (browser zoom/navigation) and
  Shift/horizontal stay exempt. The unit regression covers both boundary
  directions, and a mutation check (re-adding the `altKey` bail) turns it red.
- CSS premise (Claude F1): the rejected-alternative comment was stale. Chrome
  144+ applies `overscroll-behavior` to non-scrollable scroll containers, and
  Electron 43.1.1 ships Chrome 150. The comment now says CSS might work, that
  it was never probed, and what a user-run probe must show before swapping.
  The helper stays in this PR.
- Real-xterm unit coverage (Codex minor, Claude F8): attempted and judged not
  feasible (SUPERSEDED in round 2: narrow shims make it feasible; see below).
  In happy-dom, xterm's `open()` throws in the DOM renderer's
  WidthCache (`getContext('2d')` is null) before the Viewport or MouseService
  exist, and the missing layout leaves cell and scroll geometry at 0. The WHY
  is at the top of terminalWheelBoundary.renderer.test.ts. The over-claiming
  test title is renamed to the bubble-phase contract it actually pins.
- Smoke probe (Claude F2, F4): kept as a manual, user-run probe with a WHY
  header. It gains Alt fast-scroll steps (mid-history and boundary) and is
  referenced from the helper's WHEN BUMPING XTERM note. The fixture is kept
  out of tsconfig.web.json for parity with the sibling
  terminal-renderer/smoke.ts, which needs a TS2683 fix (implicit `this`,
  line 16) before either fixture can be listed. terminal-wheel/smoke.ts
  type-checks on its own. No npm script or CI gate.
- Chromium latching (Claude F6): cited the explainer and marked the
  `!event.cancelable` path as reasoned, not probe-verified. ARCHITECTURE.md
  §6.6.2 names the wheel boundary (F7). F9 (a merge-commit subject) needs no
  change.

Review-round verification (Node 24.14.1, run on the exact tree committed with
this section; after it, only these markdown lines changed):
- Raw `tsc -p tsconfig.node.json` then `tsc -p tsconfig.web.json`: both clean.
- Focused renderer tests (boundary helper plus every AgentTerminalLeaf and
  TerminalLeaf renderer file): 9 files, 63 tests pass (13 in the helper
  file). `vitest related --run` on terminalWheelBoundary.ts: 16 files, 99
  tests pass.
- Alt mutation check: restoring the `altKey` bail fails exactly the two Alt
  boundary cases (11 others still pass). The source was then restored
  byte-identical.
- The Electron probe is still pending a user re-run on the current stack
  (xterm 6.1.0-beta.304, addon-webgl 0.20.0-beta.300, Electron 43.1.1). Its
  Alt steps have never run. The CI result for the final head lives in the PR
  body, because recording it here would change the head.

## Review round 2 (Codex + Claude verification of 84e29c92)

Both reviewers verified the Alt fix and found no production defect.

- Control probe pointer drift (Claude R1, Codex minor 1). In `--control` the
  plain and Alt boundary leaks scroll `#outer` to about 240px. The fixed
  (200,100) wheel point then falls below xterm's 20-row screen, so the
  alternate-screen and SGR steps would miss xterm and fail for fixture
  reasons. Fix: after both boundary states are recorded, the probe calls
  `resetOuter()` (sets `#outer.scrollTop = 0`). It asserts the reset took
  effect, and asserts `outer === 0` for both protocol steps in both modes.
  This is reasoned statically. In default mode the reset is a no-op. In
  control mode an upward protocol wheel cannot scroll a parent already at 0,
  even if Chromium still latches the earlier leak's sequence to it. The probe
  has still never run on the current stack.
- Real-xterm coverage (Codex minor 2). The round-1 "infeasible" verdict was
  too strong. `terminalWheelBoundary.xterm.renderer.test.ts` opens the real
  pinned xterm in happy-dom with three environment shims:
  1. a 2D context with `font` and `measureText().width` for WidthCache;
  2. a fixed size for the char-measure span that CharSizeService reads;
  3. explicit 0px padding on `.xterm-screen`.
  Each synthetic event also gets clientX/clientY and the modifier fields,
  because happy-dom's WheelEvent extends UIEvent, not MouseEvent. Both gaps
  produce `ESC[<64;NaN;NaNM`. The first real run had both, and a run with
  only the padding shim still got NaN from the missing clientX. That unset
  padding alone also yields NaN is read from happy-dom's source (no default
  padding, so '' is parseInt()ed) and was not observed separately.
  Assertions are relative or semantic, never derived from the fake sizes:
  - plain and Alt scrollback are consumed by xterm, and Alt moves farther;
  - exhausted plain and Alt wheels at top and bottom are canceled by the
    helper, and are NOT canceled after `dispose()` (the no-helper control
    that pins the leak in the pinned xterm);
  - alternate-screen wheel emits `ESC [ A`;
  - DECSET 1000/1006 wheel emits one SGR report.
  It claims no native scroll chaining, latching or WebGL coverage. The
  Electron probe stays the oracle for those. The unit test header's
  "infeasible" account is replaced with this division of labor.
- Ctrl/Meta WHY (Codex nit): xterm consumes Ctrl/Meta wheels as ordinary
  scrollback while it can move. Leaving only UNCONSUMED ones to the browser
  is helper policy. The comment and the unit test title now say so.
- Shift WHY (Claude R2): on macOS xterm does not `shiftConvert`, so a Shift
  wheel that still arrives vertical can chain at a boundary. The comment now
  calls the exemption policy and names that unverified gap. The code is
  unchanged without probe evidence.
- tsconfig decline reasoning (Claude R3): reworded above to parity with the
  sibling fixture.
- origin/main had moved 59 commits (touching AgentTerminalLeaf.tsx and
  ARCHITECTURE.md). It was merged cleanly first (78a3e85d), and all three
  hosts still attach the helper right after `open()` and dispose it.

Round-2 verification (Node 24.14.1, run on the exact tree committed with this
section; after it, only these markdown lines changed):
- Raw `tsc -p tsconfig.node.json` then `tsc -p tsconfig.web.json`: both clean.
- Focused renderer tests (helper unit file, the new real-xterm file, every
  AgentTerminalLeaf and TerminalLeaf renderer file): 10 files, 71 tests pass
  (13 helper-unit, 5 real-xterm). `vitest related --run` on
  terminalWheelBoundary.ts: 17 files, 107 tests pass.
- Mutation check on the real-xterm test: restoring the `altKey` bail fails
  exactly the two real-xterm boundary cases (top and bottom; 2 failed, 3
  passed) with `[true, false]` instead of `[true, true]`. The source was then
  restored byte-identical.
- The Electron probe is still pending a user re-run on the current stack. Its
  Alt steps and the round-2 parent reset have never run.
