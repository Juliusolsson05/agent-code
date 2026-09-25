# Composer collapsed height

Refs #1165.

## Problem

`useComposerAutoGrow` sizes the composer textarea as `height = scrollHeight` only when
the draft text changes. It can write a collapsed height, and it never corrects one:

1. When measured under `display: none` (Reader/Spotlight/Settings retained surface,
   Global Editor fullscreen), `scrollHeight` is 0, so the hook writes `0px` and the box
   stays at padding height until the draft changes.
2. A width change (narrower pane) re-wraps the draft without re-measuring.
3. `border-box` + `scrollHeight` (which excludes borders) makes the height 2 px short.

## Plan

- In the hook, skip measurement while the textarea has no layout (`clientWidth === 0`),
  leaving the last good height in place.
- Observe the textarea with a `ResizeObserver` and re-measure when its **content-box width**
  (`entry.contentRect.width`) changes.
  This covers both the hidden → visible reveal (0 → N) and pane resizes. Ignore
  height-only notifications, because our own height writes trigger them and they would
  loop.
- Add the vertical border widths to the written height.
- Add a renderer test with a stubbed layout (`happy-dom` has none): a hidden measurement
  doesn't write a collapsed height, and a reveal re-measures.

## Review round (PR #1166, one Claude + one Codex reviewer)

- Width changed from `clientWidth` to the content box, because dictation's `pr-2 → pr-16`
  padding swap re-wraps the draft without changing `clientWidth` (reproduced in Chromium).
- The observer's height write is deferred to `requestAnimationFrame`, coalesced, and
  cancelled on unmount. A synchronous write raised Chromium's "ResizeObserver loop" error
  (reproduced).
- The test's fake observer now delivers only to `observe()`d targets, and the test uses a
  stable ref. Both hid real regressions. Added hide → edit → reveal, dictation padding,
  and deferral cases.
- Not fixed: `scrollHeight` is an integer while lines are 16.8px, so the box can be up to
  1px short (sub-pixel jiggle only). Documented at the write site.

## Verification

`npx tsc -b`, the new test, and the renderer project once at the end. The app is not
launched (per repo practice), so the visual confirmation is the user's.
