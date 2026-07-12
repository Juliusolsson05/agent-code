// OpenCode composer submit (#406 step 5).
//
// Opencode has no PTY, so — unlike Claude/Codex which write bracketed-
// paste bytes through io.send — this submits the finished prompt over
// the HTTP deliver-prompt IPC (session:deliver-prompt →
// SessionManager.deliverPromptToAgent → registry deliverPrompt →
// opencode prompt()). io.send is deliberately unused; there is no
// terminal to receive keystrokes.
//
// WHY throw on failure: the composer call site (useComposerKeybinds)
// only clears the draft when composerSubmit resolves; its catch path
// preserves the user's text. Turning a delivery failure into a throw is
// what keeps a prompt the server never accepted from vanishing from the
// composer. usesOptimisticUserEcho is true for opencode, so the call
// site also rolls back the optimistic user bubble on this throw.

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import type { PromptDeliveryResult } from '@shared/types/providerConfig'

export async function opencodeComposerSubmit(io: ComposerSubmitIo): Promise<void> {
  const result = await io.deliverPrompt(io.input)
  if (!result.ok) {
    // The shared composer catch owns draft/optimistic-row recovery, but it can
    // only distinguish safe retry from duplicate risk if the provider keeps
    // the structured result attached. OpenCode HTTP failures after request
    // dispatch are just as ambiguous as Claude failures after Enter.
    const error = new Error(result.message) as Error & {
      promptDeliveryResult: PromptDeliveryResult
    }
    error.promptDeliveryResult = result
    throw error
  }
}
