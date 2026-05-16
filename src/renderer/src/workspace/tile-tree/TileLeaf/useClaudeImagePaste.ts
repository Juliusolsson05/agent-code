import { useCallback } from 'react'

import type { SessionId } from '@renderer/workspace/types'
import type { ClaudeDraftImage } from '@renderer/workspace/workspaceState'
import {
  SUPPORTED_CLAUDE_IMAGE_FORMATS_TEXT,
  exceedsClaudeImageSizeLimit,
  filesToDraftImages,
  isSupportedClaudeImageMediaType,
  parseImagesFromHtml,
  readImagesFromClipboard,
} from '@renderer/workspace/tile-tree/TileLeaf/claudeImages'

// Image-paste handler for the composer. Claude-only: Codex doesn't
// accept inline image content, so we fall through to the browser's
// default paste handling for that provider.
//
// Three clipboard ingress paths live here (pluralised from what a
// naive `clipboardData.items` check would give us):
//
//   1. `e.clipboardData.items` File objects (the typical copy-image-
//      from-app flow on macOS / Windows).
//   2. `<img src="data:image/...">` embedded in `text/html` (some
//      browsers copy web images as HTML fragments rather than real
//      Files).
//   3. `navigator.clipboard.read()` fallback (covers the case where
//      Electron picks a clipboard representation that doesn't
//      surface through synchronous `clipboardData`).
//
// We also gate on media type (Claude supports PNG/JPEG/GIF/WebP)
// and a 5 MB size cap — both enforced with a toast on violation
// and a short-circuit return. Validated images are appended into
// the draft-images store via setDraftImages; the hook does the
// append internally so callers only need to consume handlePaste
// and removeDraftImage (paste-only ingress).
//
// `e.preventDefault()` is called whenever we handle the paste so
// the default "paste as text" behavior doesn't leak data URL blobs
// into the textarea.
//
// WHY the event param is a structural `ClipboardLike` and not
// `React.ClipboardEvent`:
//   `handlePaste` has two callers now. The composer textarea passes
//   a React synthetic `ClipboardEvent`; `usePasteToFocus` passes a
//   *native* DOM `ClipboardEvent` (from a document-level listener,
//   so the paste can be routed into the composer even when DOM
//   focus drifted off the textarea — see issue #135). Both expose
//   `clipboardData` and `preventDefault`, so the handler depends on
//   that shape only. Native `ClipboardEvent.clipboardData` is
//   nullable (`DataTransfer | null`); React's is not — the wider
//   nullable type is the safe common denominator and the handler
//   guards for null.
type ClipboardLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
}

// Result of a paste attempt. `handledImages` lets a caller decide
// whether to ALSO route the clipboard's text payload somewhere:
// `usePasteToFocus` skips its text-append step when images were
// detected, mirroring the textarea's existing "images win over
// text on a mixed paste" behaviour.
export type ImagePasteResult = { handledImages: boolean }

export function useClaudeImagePaste({
  provider,
  sessionId,
  setDraftImages,
  showToast,
}: {
  provider: 'claude' | 'codex'
  sessionId: SessionId
  setDraftImages: (
    sessionId: SessionId,
    next: (prev: ClaudeDraftImage[]) => ClaudeDraftImage[],
  ) => void
  showToast: (message: string) => void
}) {
  const appendDraftImages = useCallback(
    (images: ClaudeDraftImage[]) => {
      if (images.length === 0) return
      setDraftImages(sessionId, prev => [...prev, ...images])
    },
    [sessionId, setDraftImages],
  )

  const removeDraftImage = useCallback(
    (imageId: string) => {
      setDraftImages(sessionId, prev => prev.filter(image => image.id !== imageId))
    },
    [sessionId, setDraftImages],
  )

  const handlePaste = useCallback(
    async (e: ClipboardLike): Promise<ImagePasteResult> => {
      // Codex has no inline-image content — fall through so the
      // caller routes the clipboard's text instead.
      if (provider !== 'claude') return { handledImages: false }
      const clipboardData = e.clipboardData
      if (!clipboardData) return { handledImages: false }

      try {
        // Read everything off `clipboardData` SYNCHRONOUSLY before
        // the first `await`. A ClipboardEvent's data is only
        // reliably readable during synchronous dispatch — once we
        // await, `items` / `getData` may come back empty. The
        // `File` objects from `getAsFile()` stay valid after the
        // await; the live `clipboardData` accessor does not.
        const itemFiles = Array.from(clipboardData.items)
          .map(item => item.type.startsWith('image/') ? item.getAsFile() : null)
          .filter((file): file is File => Boolean(file && file.type.startsWith('image/')))
        const htmlImages = parseImagesFromHtml(clipboardData.getData('text/html'))

        let images: ClaudeDraftImage[] = htmlImages
        if (itemFiles.length > 0) {
          e.preventDefault()
          const fileImages = await filesToDraftImages(itemFiles)
          const existing = new Set(images.map(image => image.previewUrl))
          images = [
            ...images,
            ...fileImages.filter(image => !existing.has(image.previewUrl)),
          ]
        } else if (images.length === 0) {
          images = await readImagesFromClipboard()
          if (images.length > 0) {
            e.preventDefault()
          }
        } else {
          e.preventDefault()
        }
        if (images.length === 0) return { handledImages: false }
        // From here on at least one image was detected — even the
        // rejection paths below count as "handled images" so the
        // caller does NOT additionally paste text: the user's
        // intent was an image, and a toast already explained why it
        // didn't land.
        const unsupported = images.find(
          image => !isSupportedClaudeImageMediaType(image.mediaType),
        )
        if (unsupported) {
          showToast(
            `Unsupported image format: ${unsupported.mediaType}. Claude supports ${SUPPORTED_CLAUDE_IMAGE_FORMATS_TEXT}.`,
          )
          return { handledImages: true }
        }
        const oversized = images.find(exceedsClaudeImageSizeLimit)
        if (oversized) {
          showToast(
            `Image is too large. Claude supports pasted images up to 5 MB.`,
          )
          return { handledImages: true }
        }
        appendDraftImages(images)
        return { handledImages: true }
      } catch (err) {
        console.warn('[TileLeaf] image paste failed', err)
        showToast('Image paste failed.')
        // Treat a thrown image path as handled — we don't want to
        // silently dump a data-URL blob into the composer as text.
        return { handledImages: true }
      }
    },
    [appendDraftImages, provider, showToast],
  )

  return { handlePaste, removeDraftImage }
}
