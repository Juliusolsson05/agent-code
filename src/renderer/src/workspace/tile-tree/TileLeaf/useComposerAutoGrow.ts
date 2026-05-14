import { useEffect, type RefObject } from 'react'

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
    // Reset height before measuring so scrollHeight reflects the
    // current content, not whatever we sized it to last render.
    el.style.height = 'auto'
    const desired = el.scrollHeight
    const capped = Math.min(desired, MAX_HEIGHT_PX)
    el.style.height = `${capped}px`
    // The inline overflowY win against the className `overflow-hidden`
    // we used to ship: when content fits, keep the scrollbar gone so
    // the textarea looks clean; when capped, let the native scrollbar
    // appear so the user can scroll inside their own draft.
    el.style.overflowY = desired > MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [ref, value])
}
