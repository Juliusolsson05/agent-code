import { setTimeout as delay } from 'node:timers/promises'

import type { PromptDeliveryIo, PromptDeliveryResult } from '@shared/types/providerConfig.js'
import type { AntigravityTerminalSession } from './antigravityTerminalSession.js'

/** SessionManager reserves this process's input for the duration and verifies
 * backend identity on each write. Inspect the actual editor between paste and
 * Enter: a draft or modal that raced the first paint must never get submitted. */
export async function deliverNativeAntigravityPrompt(
  io: PromptDeliveryIo,
  session: AntigravityTerminalSession,
): Promise<PromptDeliveryResult> {
  if (io.inlineImages?.length || io.imagePaths?.length) {
    return {
      ok: false, stage: 'before-write', code: 'missing-capability', retrySafe: true,
      disposition: 'session-unusable', promptWritten: false, enterWritten: false,
      message: 'Antigravity accepts Agent Code image attachments in Agent view.',
    }
  }
  const id = session.confirmedConversation()
  const text = io.prompt.replace(/\r\n/g, '\n')
  // ESC can terminate a bracketed paste early. Reject terminal control bytes
  // even for trusted automation since prompts routinely quote arbitrary data.
  if (!text.trim() || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text)) {
    return {
      ok: false, stage: 'before-write', code: 'missing-capability', retrySafe: true,
      disposition: 'session-unusable', promptWritten: false, enterWritten: false,
      message: 'Antigravity native prompts must contain text and cannot include terminal control characters.',
    }
  }
  if (!id || !session.nativeComposer.ready()) {
    const occupied = session.nativeComposer.occupied()
    return {
      ok: false, stage: 'before-write', code: 'not-ready', retrySafe: true,
      disposition: occupied ? 'retry-after-resolve' : 'retry-same-session', promptWritten: false, enterWritten: false,
      message: occupied ? 'Antigravity has an existing native draft.'
        : 'Antigravity has not confirmed an empty prompt in the selected conversation.',
    }
  }
  if (!io.write('\x1b[200~' + text + '\x1b[201~')) {
    return {
      ok: false, stage: 'before-write', code: 'write-failed', retrySafe: true,
      disposition: 'session-unusable', promptWritten: false, enterWritten: false,
      message: 'The Antigravity terminal closed before the prompt was written.',
    }
  }

  const deadline = Date.now() + 3000
  while (session.confirmedConversation() === id && Date.now() < deadline) {
    if (session.nativeComposer.containsPaste(text)) {
      if (!io.write('\r')) {
        return {
          ok: false, stage: 'session-exit', code: 'session-exited', retrySafe: false,
          disposition: 'do-not-retry', promptWritten: true, enterWritten: false,
          message: 'The target Antigravity process disappeared after the paste. Enter was never written.',
        }
      }
      return { ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } }
    }
    await delay(20)
  }
  // The paste may still be editable. Never clear it or send Enter after the
  // reservation expires; either could change a human's subsequent keystrokes.
  return {
    ok: false, stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
    disposition: 'do-not-retry', promptWritten: true, enterWritten: false,
    message: 'Antigravity could not confirm the pasted text in the same native conversation. Check the terminal draft before submitting.',
  }
}
