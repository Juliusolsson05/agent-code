// Pi composer submit. A Pi pane is terminal-only (no rendered composer), so
// this runs only when some other surface — Dispatch, the phone, a prompt
// template — submits through the shared composer path. Delivery goes through
// the bridge (session:deliver-prompt → registry deliverPrompt →
// PiSession.deliverPromptText), never io.send: a paste into the TUI is not
// acknowledged by anything (#877).
//
// WHY throw on failure: the composer call site only clears the draft when
// this resolves; a throw keeps the user's text, and the structured result
// lets it tell a safe retry from a possible duplicate (same as Grok/OpenCode).

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptAcceptance, PromptDeliveryResult } from '@shared/types/providerConfig'

export async function piComposerSubmit(io: ComposerSubmitIo): Promise<PromptAcceptance> {
  const result = await io.deliverPrompt(io.input)
  if (!result.ok) {
    const error = new Error(result.message) as Error & { promptDeliveryResult: PromptDeliveryResult }
    error.promptDeliveryResult = result
    throw error
  }
  return result.acceptance
}
