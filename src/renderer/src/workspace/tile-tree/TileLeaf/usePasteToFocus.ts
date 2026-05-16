import { useEffect, type RefObject } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { ImagePasteResult } from '@renderer/workspace/tile-tree/TileLeaf/useClaudeImagePaste'
import { clipboardHasImageCandidate } from '@renderer/workspace/tile-tree/TileLeaf/claudeImages'

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
// Payload routing — the order here is deliberate:
//
//   1. Snapshot `text/plain` synchronously. A ClipboardEvent's data
//      is only reliably readable during synchronous dispatch; after
//      any `await` it can read back empty.
//
//   2. Decide SYNCHRONOUSLY whether this paste carries an image,
//      via `clipboardHasImageCandidate` (image item OR data-URL in
//      text/html).
//
//   3a. NO image candidate → append the text to the composer NOW,
//       synchronously. This is the common case. The earlier version
//       always routed through the async `handlePaste`, which for a
//       Claude session runs `navigator.clipboard.read()` even for
//       plain text — that (a) delayed every text paste, (b) could
//       resolve out of order so two quick pastes appended reversed,
//       and (c) if the async probe threw, dropped the text entirely.
//       Deciding synchronously and appending immediately removes all
//       three problems for the overwhelmingly common plain-text case.
//
//   3b. Image candidate present → hand off to the SAME `handlePaste`
//       the composer textarea uses, so the format / 5 MB gates and
//       the draft-image strip behave identically. Only an actual
//       image paste pays the async cost. If `handlePaste` reports it
//       did NOT consume an image, the snapshotted text is appended
//       (mixed image+text paste — images win, then text follows).
//
// Tradeoff: an image that surfaces ONLY through the async
// `navigator.clipboard.read()` fallback (no synchronous item /
// html signal) is treated as a non-image paste here and won't be
// captured by paste-to-focus. That fallback exists for the textarea
// path; for paste-to-focus the rare miss is preferable to delaying
// and reordering every ordinary text paste. See
// `clipboardHasImageCandidate`.
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

    // Append `text` to the composer draft, focus the textarea, and
    // park the caret at the end. The composer is not mid-edit if it
    // does not even hold focus, so there is no meaningful selection
    // to insert into — appending is the predictable behaviour and
    // matches useTypeToFocus. The rAF is load-bearing: setting
    // `selectionStart` synchronously targets the textarea's OLD
    // React-bound value (the new value hasn't re-rendered yet) and
    // parks the caret at a stale index.
    const appendText = (text: string) => {
      const live = inputRef.current
      if (!live || !text) return
      onUserEngagement?.()
      setDraftInput(sessionId, live.value + text)
      live.focus()
      requestAnimationFrame(() => {
        const el2 = inputRef.current
        if (!el2) return
        el2.selectionStart = el2.value.length
        el2.selectionEnd = el2.value.length
      })
    }

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

      // Snapshot text synchronously — clipboardData goes stale after
      // any await.
      const text = e.clipboardData?.getData('text/plain') ?? ''

      // No synchronous image evidence → plain-text paste. Append now,
      // synchronously: no await, so no delay, no reorder race, and no
      // chance of an async failure swallowing the text.
      if (!clipboardHasImageCandidate(e.clipboardData)) {
        appendText(text)
        return
      }

      // Image candidate present → route through the shared image
      // handler. `handlePaste` runs synchronously up to its first
      // await (it reads `clipboardData` items/html at the top), so
      // calling it now captures the clipboard before it goes stale.
      // If it reports no image was actually consumed, fall back to
      // appending the snapshotted text (mixed paste, or a candidate
      // that didn't resolve to a usable image).
      void handlePaste(e).then(({ handledImages }) => {
        if (handledImages) return
        appendText(text)
      })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [focused, sessionId, inputRef, setDraftInput, onUserEngagement, handlePaste])
}
