// Claude composer submit protocol (#394 phase 2c-4). Extracted from
// useComposerKeybinds' inline branches so the protocol lives with the
// provider that owns it. Every timing/race decision here is
// battle-scarred — the WHY blocks moved verbatim with the code; do
// not "simplify" the delays or the event-driven wait without reading
// docs/superpowers/plans/2026-05-11-paste-submit-*.md and #279/#90.
//
// Renderer responsibility now ends after attachment files are prepared. Both
// text and image prompts delegate to main's serialized, direct-snapshot,
// JSONL-acknowledged state machine. Keeping path saving before delegation makes
// filesystem errors retry-safe without letting the renderer own any PTY timer.

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptDeliveryResult } from '@shared/types/providerConfig'

export async function claudeComposerSubmit(io: ComposerSubmitIo): Promise<void> {
  const { input, draftImages, pasteId } = io

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
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'RENDER',
      event: 'route:claude-images',
      data: { imageCount: imagePaths.length, textLen: input.length },
    })
    const result = await io.deliverPrompt(input, imagePaths)
    if (!result.ok) throwDeliveryError(result)
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
  if (!result.ok) throwDeliveryError(result)
}

function throwDeliveryError(result: Extract<PromptDeliveryResult, { ok: false }>): never {
  const error = new Error(result.message) as Error & {
    promptDeliveryResult: PromptDeliveryResult
  }
  error.promptDeliveryResult = result
  throw error
}
