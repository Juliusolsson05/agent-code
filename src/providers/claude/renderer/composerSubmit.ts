// Claude composer submit protocol (#394 phase 2c-4). Extracted from
// useComposerKeybinds' inline branches so the protocol lives with the
// provider that owns it. Every timing/race decision here is
// battle-scarred — the WHY blocks moved verbatim with the code; do
// not "simplify" the delays or the event-driven wait without reading
// docs/superpowers/plans/2026-05-11-paste-submit-*.md and #279/#90.
//
// Two routes:
//   images     — save drafts to disk, send text (with separator),
//                paste the file paths with the LONG 750 ms fallback
//                timer (image expansion is its own TUI animation and
//                the text-paste placeholder never shows up for it —
//                event-driven detection is disabled on purpose).
//   text       — every text-only prompt delegates to main's serialized,
//                direct-snapshot, JSONL-acknowledged delivery state machine.
//
// The image timer remains provider-specific because Claude converts pasted
// filesystem paths into image pills asynchronously; that is a different
// acknowledgement surface from the text paste accumulator fixed here.

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import {
  buildClaudeImagePastePayload,
  CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS,
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

  window.api.recordPasteDebugEvent(pasteId, {
    layer: 'RENDER',
    event: 'route:claude-main-delivery',
    data: { inputLen: input.length },
  })
  // WHY desktop text takes the same main path as remote/MCP: a renderer can be
  // paused for seconds by Chromium. Any confirmation, timer, or overlapping
  // operation owned here inherits that pause. Main has the live headless
  // snapshot, the PTY write, the per-session reservation, and durable JSONL
  // acceptance, so it is the only process able to enforce the protocol.
  const result = await io.deliverPrompt(input)
  if (!result.ok) throw new Error(result.message)
}
