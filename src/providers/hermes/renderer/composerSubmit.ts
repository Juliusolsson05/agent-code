// Hermes composer submit (#1482). There is no PTY: the finished prompt goes
// over the deliver-prompt IPC (session:deliver-prompt → SessionManager →
// registry deliverPrompt → HermesSession.deliverPromptText →
// hermes-headless prompt / runSlash).
//
// WHY throw on failure (same as OpenCode): the composer clears the draft only
// when this resolves, so a message Hermes never took stays in the composer,
// and the structured result lets the shared catch tell "safe to retry" from
// "may have run" (a socket that died after sending).

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptAcceptance, PromptDeliveryResult } from '@shared/types/providerConfig'

export async function hermesComposerSubmit(io: ComposerSubmitIo): Promise<PromptAcceptance> {
  const result = await io.deliverPrompt(io.input)
  if (!result.ok) {
    const error = new Error(result.message) as Error & { promptDeliveryResult: PromptDeliveryResult }
    error.promptDeliveryResult = result
    throw error
  }
  return result.acceptance
}
