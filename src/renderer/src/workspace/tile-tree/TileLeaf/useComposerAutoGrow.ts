import { useEffect } from 'react'
import type { RefObject } from 'react'

// Auto-grow the composer textarea to fit its content, up to a cap.
// We keep a single line by default; as the user types (or pastes) a
// longer prompt the box extends downward so every character is
// visible without internal scrolling — until it would push the rest
// of the pane off-screen, at which point we cap the height and let
// the textarea scroll internally. The reflow is driven off `value`
// so paste, programmatic setInputText, and typed keystrokes all
// converge on the same measurement pass.
//
// Why manual measurement instead of CSS `field-sizing: content`?
//   - Safari/older Chromium don't support it yet and Electron ships
//     a pinned Chromium we don't want to track.
//   - Setting height to 'auto' first forces layout to forget the
//     previous height, so scrollHeight reflects ONLY the current
//     content — without the reset we'd ratchet taller and never
//     shrink.
//
// Why a cap (this is the #116 fix):
//   - Before: a multi-paragraph paste would set height to
//     scrollHeight unconditionally, eating the entire pane and
//     pushing the feed offscreen. With overflow-hidden on the
//     textarea, the user couldn't even scroll inside their own
//     input to navigate it. Both editing and reading collapsed.
//   - After: once scrollHeight would exceed MAX_HEIGHT_PX the box
//     stops growing and overflow-y flips to auto. The user gets a
//     native scrollbar inside the textarea, the feed stays visible,
//     and the pane chrome above remains intact.
//
// Why 320px:
//   At the composer's font size (~12px) with leading 1.4, this is
//   roughly 13–14 visible rows of content — generous for a typical
//   paste, conservative enough that two stacked panes can both
//   show a maxed-out composer without the feeds disappearing. Flat
//   constant rather than pane-aware (e.g. "40% of pane height")
//   because the simpler shape avoids a resize listener and ties the
//   ergonomic floor to a value that's the same across the app. If
//   a future bug shows panes too short for 320, we can layer
//   pane-aware capping on top without changing this contract.
const MAX_HEIGHT_PX = 320

export function useComposerAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    fitComposerHeight(el)
  }, [ref, value])

  // WHY a second trigger besides `value` (#1165): the right height depends on
  // the textarea's WIDTH as much as its text, because width decides how many
  // lines the draft wraps to. Keying only on `value` left two holes:
  //   - A pane that narrows (layout change, window resize, a sibling lane
  //     opening) re-wraps the draft onto more lines while the inline height
  //     stays at the old line count, so the text is clipped.
  //   - A draft that changes while the workspace is display:none is skipped
  //     by fitComposerHeight (see below). Without a re-measure on reveal the
  //     box would keep whatever height it had before the change.
  // Both show up as a change in the element's width (N → M, or 0 → N on
  // reveal), so one observer covers them.
  //
  // WHY only width changes count: this hook writes the element's height, and
  // every write produces a ResizeObserver notification. Re-measuring on those
  // would at best waste a layout pass per keystroke and at worst trip
  // Chromium's "ResizeObserver loop" error. Width is never written here, so
  // a width change is always caused by something outside the hook.
  useEffect(() => {
    const el = ref.current
    // Same guard as components/charts/useElementWidth: some test DOMs ship
    // without ResizeObserver, and the value-keyed effect above still works
    // there.
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth
      if (width === lastWidth) return
      lastWidth = width
      fitComposerHeight(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
}

function fitComposerHeight(el: HTMLTextAreaElement): void {
  // WHY skip unlaid-out elements (#1165, the main cause of the "collapsed
  // composer" reports): Reader Mode, Spotlight, Settings
  // (RetainedWorkspaceSurface, #752) and Global Editor fullscreen keep the
  // whole workspace MOUNTED under display:none. There scrollHeight is 0, so
  // the old code wrote `height: 0px`. With border-box that renders as just
  // padding and border, a sliver that clips the first line of text, and
  // nothing corrected it until the draft next changed. clientWidth is 0
  // exactly when the element has no layout box, so leaving the last good
  // height alone here and letting the width observer re-measure on reveal
  // is both safe and complete.
  if (el.clientWidth === 0) return
  // Reset height before measuring so scrollHeight reflects the
  // current content, not whatever we sized it to last render.
  el.style.height = 'auto'
  const desired = el.scrollHeight
  // WHY add the borders: Tailwind's preflight makes every element
  // `box-sizing: border-box`, so the inline height includes the border, but
  // scrollHeight (content + padding) does not. Writing scrollHeight alone left
  // the content box 2px short of one line. A single-line draft then
  // overflowed and scrolled a couple of pixels whenever the caret moved.
  // Read from computed style rather than hardcoding 1px, so a border change in
  // ComposerInput's className can't silently bring the bug back.
  const style = getComputedStyle(el)
  const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
  const capped = Math.min(desired, MAX_HEIGHT_PX)
  el.style.height = `${capped + borders}px`
  // The inline overflowY win against the className `overflow-hidden`
  // we used to ship: when content fits, keep the scrollbar gone so
  // the textarea looks clean; when capped, let the native scrollbar
  // appear so the user can scroll inside their own draft.
  el.style.overflowY = desired > MAX_HEIGHT_PX ? 'auto' : 'hidden'
}
