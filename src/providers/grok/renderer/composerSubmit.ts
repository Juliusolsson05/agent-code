// Grok composer submit.
//
// Grok delivers prompts over the owned control connection (session:deliver-prompt
// → SessionManager.deliverPromptToAgent → registry deliverPrompt →
// GrokSession.deliverPromptText), never through io.send: acceptance is
// correlated by the client prompt id over control (catalog prompt.acceptance),
// and pasting into the native TUI can attach clipboard images the composer never
// saw.
//
// WHY throw on failure: the composer call site (useComposerKeybinds) only
// clears the draft when composerSubmit resolves; its catch path preserves the
// user's text. Turning a delivery failure into a throw is what keeps a prompt
// native never accepted from vanishing from the composer. usesOptimisticUserEcho
// is true for grok, so the call site also rolls back the optimistic user bubble
// on this throw.

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptAcceptance, PromptDeliveryResult } from '@shared/types/providerConfig'

export async function grokComposerSubmit(io: ComposerSubmitIo): Promise<PromptAcceptance> {
  const result = await io.deliverPrompt(io.input)
  if (!result.ok) {
    // The shared composer catch owns draft/optimistic-row recovery, but it can
    // only distinguish safe retry from duplicate risk if the provider keeps the
    // structured result attached — the same contract OpenCode follows.
    const error = new Error(result.message) as Error & {
      promptDeliveryResult: PromptDeliveryResult
    }
    error.promptDeliveryResult = result
    throw error
  }
  return result.acceptance
}
