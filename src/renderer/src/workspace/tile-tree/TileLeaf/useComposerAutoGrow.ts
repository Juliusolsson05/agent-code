import { useEffect, type RefObject } from 'react'

// Auto-grow the composer textarea to fit its content. We keep a
// single line by default, but as the user types (or pastes) a long
// prompt the box extends downward so every character is visible
// without scrolling inside the input itself. The reflow is driven
// off `value` so paste, programmatic setInputText, and typed
// keystrokes all converge on the same measurement pass.
//
// Why manual measurement instead of CSS `field-sizing: content`?
//   - Safari/older Chromium don't support it yet and Electron ships
//     a pinned Chromium we don't want to track.
//   - Setting height to 'auto' first forces layout to forget the
//     previous height, so scrollHeight reflects ONLY the current
//     content — without the reset we'd ratchet taller and never
//     shrink.
export function useComposerAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value])
}
