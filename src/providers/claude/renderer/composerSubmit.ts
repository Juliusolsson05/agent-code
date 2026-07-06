// Claude composer submit protocol (#394 phase 2c-4). Extracted from
// useComposerKeybinds' inline branches so the protocol lives with the
// provider that owns it. Every timing/race decision here is
// battle-scarred — the WHY blocks moved verbatim with the code; do
// not "simplify" the delays or the event-driven wait without reading
// docs/superpowers/plans/2026-05-11-paste-submit-*.md and #279/#90.
//
// Three routes:
//   images     — save drafts to disk, send text (with separator),
//                paste the file paths with the LONG 750 ms fallback
//                timer (image expansion is its own TUI animation and
//                the text-paste placeholder never shows up for it —
//                event-driven detection is disabled on purpose).
//   paste-like — multiline or >threshold text goes bracketed-paste
//                first, then Enter only after the TUI visibly
//                committed the paste (placeholder OR inlined text),
//                via the live screen snapshot. Sending \r in the same
//                PTY chunk races Claude's paste accumulator and
//                leaves the prompt sitting in the composer (#90).
//   plain      — raw text + \r in one write; the overwhelmingly
//                common fast path.

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import {
  buildClaudeImagePastePayload,
  CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS,
  CLAUDE_PASTE_SUBMIT_DELAY_MS,
  CLAUDE_PASTE_THRESHOLD,
  sendBracketedPasteThenSubmit,
  sendClaudeDraftText,
} from '@renderer/workspace/tile-tree/TileLeaf/claudePaste'

export async function claudeComposerSubmit(io: ComposerSubmitIo): Promise<void> {
  const { input, draftImages, send, pasteId } = io

  if (draftImages.length > 0) {
    const savedImages = await Promise.all(
      draftImages.map(image =>
        window.api.saveClaudeImage({
          base64Data: image.base64Data,
          mediaType: image.mediaType,
          filename: image.filename,
        }),
      ),
    )
    const imagePaths = savedImages.map(image => image.path)
    if (input.length > 0) {
      await sendClaudeDraftText(send, input)
      // Claude collapses the following path paste into image pills.
      // If the user's prompt ends in a non-whitespace character,
      // inject one separator so the final prompt text does not run
      // directly into the first `[Image #N]` placeholder.
      if (!/\s$/.test(input)) await send(' ')
    }
    const payload = buildClaudeImagePastePayload('', imagePaths)
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'RENDER',
      event: 'route:claude-images',
      data: { imageCount: imagePaths.length, textLen: input.length },
    })
    await sendBracketedPasteThenSubmit(
      send,
      payload,
      CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS,
      { pasteId },
    )
    return
  }

  const isPasteLike =
    input.includes('\n') || input.length > CLAUDE_PASTE_THRESHOLD
  if (isPasteLike) {
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'RENDER',
      event: 'route:claude-paste-like',
      data: {
        inputLen: input.length,
        hasNewline: input.includes('\n'),
        eventDriven: true,
      },
    })
    await sendBracketedPasteThenSubmit(send, input, CLAUDE_PASTE_SUBMIT_DELAY_MS, {
      pasteId,
      // Content-match submit: confirm Claude's composer actually
      // shows the paste before sending Enter, via the live screen
      // snapshot. No clock as the primary path. See #279 / #90.
      eventDriven: {
        enabled: true,
        getScreen: io.getScreen,
      },
    })
    return
  }

  window.api.recordPasteDebugEvent(pasteId, {
    layer: 'RENDER',
    event: 'route:claude-plain-text',
    data: { inputLen: input.length },
  })
  await send(input + '\r', pasteId)
}
