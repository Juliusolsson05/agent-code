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
// and a short-circuit return. The caller owns `appendDraftImages`
// (usually the draft-images hook); we hand the validated payload
// over at the end.
//
// `e.preventDefault()` is called whenever we handle the paste so
// the default "paste as text" behavior doesn't leak data URL blobs
// into the textarea.
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
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (provider !== 'claude') return

      try {
        const itemFiles = Array.from(e.clipboardData.items)
          .map(item => item.type.startsWith('image/') ? item.getAsFile() : null)
          .filter((file): file is File => Boolean(file && file.type.startsWith('image/')))
        const htmlImages = parseImagesFromHtml(e.clipboardData.getData('text/html'))

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
        if (images.length === 0) return
        const unsupported = images.find(
          image => !isSupportedClaudeImageMediaType(image.mediaType),
        )
        if (unsupported) {
          showToast(
            `Unsupported image format: ${unsupported.mediaType}. Claude supports ${SUPPORTED_CLAUDE_IMAGE_FORMATS_TEXT}.`,
          )
          return
        }
        const oversized = images.find(exceedsClaudeImageSizeLimit)
        if (oversized) {
          showToast(
            `Image is too large. Claude supports pasted images up to 5 MB.`,
          )
          return
        }
        appendDraftImages(images)
      } catch (err) {
        console.warn('[TileLeaf] image paste failed', err)
        showToast('Image paste failed.')
      }
    },
    [appendDraftImages, provider, showToast],
  )

  return { handlePaste, removeDraftImage, appendDraftImages }
}
