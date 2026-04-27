import { useEffect, type RefObject } from 'react'

import type { SessionId } from '@renderer/workspace/types'

// Type-to-focus: when the user starts typing anywhere in the
// focused pane — feed area, a stray click on a button, whatever —
// the keystroke routes to the composer without them having to
// click on it first.
//
// Why this is needed even with the focus-on-pane-focus effect (the
// one that runs `inputRef.current?.focus()` when `focused`
// changes): DOM focus wanders. Clicking a feed button, interacting
// with the tab bar, switching apps and coming back, hitting a
// keybind that focuses something else — all of these leave DOM
// focus somewhere other than the composer textarea. The focus-on-
// pane-focus effect only fires when `focused` CHANGES, which
// doesn't happen in any of those cases. So a fresh keystroke can
// land nowhere useful.
//
// The fix: listen at document level (scoped to the currently
// focused pane via the `focused` guard), and when a printable key
// comes in while DOM focus is NOT on an editable target, redirect
// it to the composer.
//
// Filter list (all of these are cases where we must NOT steal the
// key):
//   - `defaultPrevented`: a keybind or earlier handler already
//     handled this. Stay out of their way.
//   - Any modifier (cmd / ctrl / alt / meta): modifier combos are
//     global keybinds, not text input.
//   - Non-printable key (e.key.length !== 1): arrow keys, Escape,
//     Enter, Backspace, Tab, function keys. Those all have multi-
//     char names.
//   - Target is already an input / textarea / contentEditable: the
//     character is already going somewhere legitimate; don't
//     intercept it and double-type.
//   - A modal with role="dialog" is open: PathPickerModal,
//     TrustDialogModal, or any future modal. Those own keyboard
//     focus while visible.
//
// Injection path: we write directly to SessionRuntime.draftInput
// via setDraftInput (same setter the composer's onChange uses),
// then focus() the textarea, then move the cursor to end on the
// next frame after React re-renders with the new value. The rAF is
// load-bearing: setting selectionStart synchronously on a textarea
// whose React-bound `value` hasn't re-rendered yet targets the OLD
// value and puts the cursor at a stale index.
export function useTypeToFocus({
  focused,
  sessionId,
  inputRef,
  setDraftInput,
  onUserEngagement,
}: {
  focused: boolean
  sessionId: SessionId
  inputRef: RefObject<HTMLTextAreaElement | null>
  setDraftInput: (sessionId: SessionId, next: string) => void
  onUserEngagement?: () => void
}): void {
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (target.isContentEditable) return
      }
      if (document.querySelector('[role="dialog"]')) return

      const el = inputRef.current
      if (!el) return
      e.preventDefault()
      const next = el.value + e.key
      onUserEngagement?.()
      setDraftInput(sessionId, next)
      el.focus()
      requestAnimationFrame(() => {
        const el2 = inputRef.current
        if (!el2) return
        el2.selectionStart = el2.value.length
        el2.selectionEnd = el2.value.length
      })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // setDraftInput is a stable useCallback from the workspace hook
    // so re-destructuring it every render is a no-op for this dep
    // array. If workspace ever stops memoing it, this effect would
    // re-subscribe on every render and we'd add/remove a document
    // listener every frame — so keep setDraftInput memoed upstream.
  }, [focused, sessionId, inputRef, setDraftInput, onUserEngagement])
}
