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
import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import type { PromptAcceptance, PromptDeliveryResult } from '@shared/types/providerConfig'

export async function hermesComposerSubmit(io: ComposerSubmitIo, confirm: typeof requestConfirm = requestConfirm): Promise<PromptAcceptance> {
  // /restart takes the owner's Telegram bot offline for about a minute and
  // drains running work (#1497, plan Decision 6, UNCONFIRMED: confirm every
  // time). Asked here, in the renderer, because main has no UI to ask with;
  // a cancelled restart sends nothing.
  if (/^\/restart(\s|$)/i.test(io.input.trim())) {
    const confirmed = await confirm({
      title: 'Restart the Hermes gateway?',
      description: 'Telegram goes offline for about a minute while Hermes restarts its messaging gateway. This conversation stays open.',
      confirmLabel: 'Restart Gateway',
    })
    // Cancelled: nothing was sent and no turn starts. `queue` is the
    // composer's "no turn for this" acceptance, which settles its optimistic
    // "submitting" phase (review #1503: `transport` left the pane busy).
    if (!confirmed) return { kind: 'queue', acceptedAt: Date.now() }
  }
  const result = await io.deliverPrompt(io.input)
  if (!result.ok) {
    const error = new Error(result.message) as Error & { promptDeliveryResult: PromptDeliveryResult }
    error.promptDeliveryResult = result
    throw error
  }
  return result.acceptance
}
