// Opencode prompt delivery (#406 step 5 target; stub at step 2).
//
// The real implementation is the FIRST fully-acknowledged delivery
// protocol in the app: opencode's prompt() is an HTTP call that
// returns the server's response — no readiness gate, no paste
// placeholder, no bracketed-paste races. Until the runtime lands,
// fail loudly so orchestration accounting stays truthful.

import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'

export async function deliverOpencodePrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  return {
    ok: false,
    message: `opencode prompt delivery is not wired yet (#406) — session ${io.sessionId}`,
  }
}
