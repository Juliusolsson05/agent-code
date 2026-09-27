# happy-dom 20.9 → 20.14.5 (#1365)

## Why this exists

Dependabot #1322 moved happy-dom 20.9.0 → 20.14.5 and its quality gate (run
36168289491, head `cfc31862`, 2026-09-25T17:37Z) failed in three renderer
files. #1360 took #1322's other bumps with happy-dom held back. #1365 asks which
happy-dom change broke event dispatch, and forbids weakening the tests to get
the bump through.

## What the evidence says

Reproduced locally with happy-dom 20.14.5 loaded (verified via
`navigator.userAgent` → `HappyDOM/20.14.5`; a symlinked vitest silently loads
the shared tree's 20.9.0, so the version has to be checked, not assumed).

1. **`terminalWheelBoundary.xterm.renderer.test.ts`: real, and it comes from
   happy-dom.** All 5 tests fail in `term.open()` with `value must not be
   falsy` from xterm's `WidthCache` (`RendererUtils.throwIfFalsy`). The cause
   is not event dispatch. happy-dom **20.10.0** added a global
   `OffscreenCanvas` (`lib/canvas/OffscreenCanvas.js`; 20.9.0 has no
   `lib/canvas` at all). xterm's WidthCache prefers
   `new OffscreenCanvas(1, 1)` whenever the global exists, so it bypasses the
   test's shim, which patches only `HTMLCanvasElement.prototype.getContext`.
   happy-dom's `OffscreenCanvas.getContext` returns `null` when no
   `canvasAdapter` is configured, which is exactly the "no 2D context" gap the
   shim already fills for `<canvas>`.
   xterm's CharSizeService also probes `new OffscreenCanvas(100, 100)` for its
   TextMetrics strategy. It wraps that probe in try/catch and falls back to
   the DOM strategy, so it degrades on its own, and shim 2 (the measure-span
   size) still applies.
2. **`CommandKeybindingsRow.capture.renderer.test.tsx` (7 tests) and
   `ConversationsPicker.renderer.test.tsx` (2 tests): not happy-dom.** The
   failures were `Unable to find … role "button" and name "Add"` or
   `"everywhere"`, while the rendered DOM in the same log shows
   `"Add a shortcut to New Tab"`. #1221 (keyboard-first) renamed those
   controls. The tests were updated in `e092232c` at 17:52Z, 15 minutes after
   the #1322 run. On current main both files pass unchanged with 20.14.5
   (34/34 across the three files, with only the xterm file failing).

## Plan

1. Commit this plan.
2. Fail-first: bump `happy-dom` to `^20.14.5` in package.json and the lockfile,
   touching nothing else. The existing xterm wheel test then fails on the real
   path (`open()` → WidthCache). No new test is needed: the existing one is
   the real-data oracle.
3. Fix: shim 1 installs the same fake 2D context on
   `OffscreenCanvas.prototype.getContext` when the global exists, restored in
   `afterEach` like the others. Update the WHY block: it still claims happy-dom
   has no OffscreenCanvas, and that is now false. Keep the DOM char-measure
   strategy: the fake context has no `fontBoundingBox*`, so xterm's
   CharSizeService still falls back to the DOM strategy that shim 2 sizes.
   Say so, so the next bump does not have to re-derive it.
   Rejected alternative: deleting `globalThis.OffscreenCanvas` for the test.
   That would hide the path Electron takes in production (Chromium has
   OffscreenCanvas, so WidthCache uses it there too). Shimming it keeps the
   test on production's branch.
4. Run the three files plus the renderer suite once at the end.

## Non-goals

No assertion changes. No other dependency moves.
