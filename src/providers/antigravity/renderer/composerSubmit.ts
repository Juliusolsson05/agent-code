// Antigravity composer submit.
//
// Delivery goes through main (session:deliver-prompt → registry deliverPrompt
// → AntigravitySession.deliverPromptText → ACP session/prompt). There is no
// PTY to io.send into.
//
// WHY throw on failure: the composer call site only clears the draft when
// this resolves; a throw keeps the user's text, and the structured result
// lets it tell a safe retry from a possible duplicate (same as Grok/Pi).

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptAcceptance, PromptDeliveryResult } from '@shared/types/providerConfig'

export async function antigravityComposerSubmit(io: ComposerSubmitIo): Promise<PromptAcceptance> {
  const result = io.draftImages.length
    ? await io.deliverPrompt(io.input, undefined, { inlineImages: io.draftImages.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })) })
    : await io.deliverPrompt(io.input)
  if (!result.ok) {
    const error = new Error(result.message) as Error & { promptDeliveryResult: PromptDeliveryResult }
    error.promptDeliveryResult = result
    throw error
  }
  return result.acceptance
}
