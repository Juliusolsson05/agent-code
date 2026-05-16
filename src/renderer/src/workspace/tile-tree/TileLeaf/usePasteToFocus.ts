import { useEffect, type RefObject } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { ImagePasteResult } from '@renderer/workspace/tile-tree/TileLeaf/useClaudeImagePaste'

// Paste-to-focus: when the user pastes anywhere in the focused pane
// — feed area, a stray button, the pane root — the clipboard
// payload routes into the composer without them having to click
// the textarea first.
//
// This is the paste-shaped sibling of `useTypeToFocus`. Same
// motivation: DOM focus wanders (clicking a feed control, returning
// from another app, a keybind that focused something else), and a
// `paste` event only ever fires on whatever currently holds DOM
// focus. The composer's own `onPaste` is bound to the <textarea>
// element, so a paste while focus sits anywhere else is silently
// dropped. Typing already had `useTypeToFocus` to cover this gap;
// paste did not. See issue #135.
//
// The fix mirrors `useTypeToFocus`: a document-level `paste`
// listener, scoped to the currently-focused pane via the `focused`
// guard, that redirects the paste into the composer when DOM focus
// is NOT already on an editable target.
//
// Filter list (cases where we must NOT steal the paste — identical
// in spirit to useTypeToFocus):
//   - `defaultPrevented`: something already handled this paste.
//   - Target is an input / textarea / contentEditable: the paste is
//     already going somewhere legitimate. In particular the
//     composer's own textarea `onPaste` handles that case — if we
//     also handled it here the image path would run twice and text
//     would be appended on top of the browser's native insert.
//   - A `role="dialog"` modal is open: it owns keyboard/clipboard
//     focus while visible.
//
// Payload routing:
//   - Images (Claude only) go through the SAME `handlePaste` the
//     textarea uses, so the format / 5 MB gates and the draft-image
//     strip behave identically. `handlePaste` reports back whether
//     it consumed images.
//   - Text (`text/plain`) is appended to the composer draft only if
//     no image was consumed — this mirrors the textarea's existing
//     "images win over text on a mixed paste" behaviour.
//
// WHY the text is read synchronously, before awaiting handlePaste:
//   A ClipboardEvent's `clipboardData` is only reliably readable
//   during synchronous event dispatch. `handlePaste` is async; once
//   it awaits, a later `clipboardData.getData('text/plain')` can
//   come back empty. So we snapshot the text up front and only then
//   await the image path.
export function usePasteToFocus({
  focused,
  sessionId,
  inputRef,
  setDraftInput,
  onUserEngagement,
  handlePaste,
}: {
  focused: boolean
  sessionId: SessionId
  inputRef: RefObject<HTMLTextAreaElement | null>
  setDraftInput: (sessionId: SessionId, next: string) => void
  onUserEngagement?: () => void
  handlePaste: (e: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
  }) => Promise<ImagePasteResult>
}): void {
  useEffect(() => {
    if (!focused) return
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (target.isContentEditable) return
      }
      if (document.querySelector('[role="dialog"]')) return

      const el = inputRef.current
      if (!el) return

      // Snapshot text synchronously — see WHY note above.
      const text = e.clipboardData?.getData('text/plain') ?? ''

      // Kick off the image path. `handlePaste` runs synchronously up
      // to its first await (where it reads `clipboardData.items` /
      // `getData`), so calling it now captures the clipboard before
      // it goes stale; we await only the async image decoding.
      void handlePaste(e).then(({ handledImages }) => {
        if (handledImages) return
        if (!text) return
        const live = inputRef.current
        if (!live) return
        onUserEngagement?.()
        // Append at end + caret to end. The composer is not mid-edit
        // if it does not even hold focus, so there's no meaningful
        // selection to insert into — appending is the predictable
        // behaviour and matches useTypeToFocus.
        setDraftInput(sessionId, live.value + text)
        live.focus()
        // rAF is load-bearing: setting selectionStart synchronously
        // targets the textarea's OLD React-bound value (the new
        // value hasn't re-rendered yet) and parks the caret at a
        // stale index. Same fix as useTypeToFocus.
        requestAnimationFrame(() => {
          const el2 = inputRef.current
          if (!el2) return
          el2.selectionStart = el2.value.length
          el2.selectionEnd = el2.value.length
        })
      })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [focused, sessionId, inputRef, setDraftInput, onUserEngagement, handlePaste])
}
