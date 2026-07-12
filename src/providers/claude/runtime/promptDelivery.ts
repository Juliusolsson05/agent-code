import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'
import { isPasteLike, pollPasteAbsorbed } from '@shared/claude/pasteConfirm.js'
import type { PromptAcceptanceOutcome } from '@shared/types/session.js'

const CONFIRM_TIMEOUT_MS = 2000
const CONFIRM_POLL_INTERVAL_MS = 10
const ACCEPTANCE_TIMEOUT_MS = 10_000

const failure = (
  fields: Omit<Extract<PromptDeliveryResult, { ok: false }>, 'ok'>,
): PromptDeliveryResult => ({ ok: false, ...fields })

/**
 * Main-owned Claude delivery state machine.
 *
 * WHY success waits for JSONL rather than screen disappearance: the screen is
 * an observation of terminal rendering, while Claude's user/queue JSONL entry
 * is the durable statement that Enter was actually accepted. The July 11 bug
 * passed the old visual paste check yet left the prompt editable; a later key
 * then submitted mutated text and overlapping retries produced duplicate queue
 * entries. Bytes-written and accepted are deliberately separate states here.
 */
export async function deliverClaudePrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  if (typeof io.session.armPromptAcceptance !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} cannot observe prompt acceptance`,
    })
  }

  if (!isPasteLike(io.prompt)) {
    const acceptance = io.session.armPromptAcceptance(io.prompt, {
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    })
    if (!io.write(`${io.prompt}\r`)) {
      acceptance.cancel()
      return failure({
        stage: 'before-write', code: 'write-failed', retrySafe: true,
        promptWritten: false, enterWritten: false,
        message: `Could not write prompt to session ${io.sessionId}`,
      })
    }
    return acceptanceResult(await acceptance.promise, io.sessionId, true, true)
  }

  if (typeof io.session.snapshotScreen !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} has no direct screen snapshot`,
    })
  }
  const baselineScreen = io.session.snapshotScreen()
  if (!io.write(`\x1b[200~${io.prompt}\x1b[201~`)) {
    return failure({
      stage: 'before-write', code: 'write-failed', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Could not write paste to session ${io.sessionId}`,
    })
  }

  const absorbed = await pollPasteAbsorbed(
    () => io.session.snapshotScreen?.() ?? '',
    baselineScreen,
    io.prompt,
    { timeoutMs: CONFIRM_TIMEOUT_MS, pollIntervalMs: CONFIRM_POLL_INTERVAL_MS },
  )
  if (absorbed.kind !== 'absorbed') {
    // Prompt bytes are already editable in Claude even when our detector times
    // out. Automatic retry is unsafe: it would append/duplicate those bytes.
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      promptWritten: true, enterWritten: false,
      message: `Claude session ${io.sessionId} did not visibly absorb the paste`,
    })
  }

  // Arm synchronously before Enter. This ordering is the acceptance analogue
  // of installing an event listener before starting the operation it observes.
  const acceptance = io.session.armPromptAcceptance(io.prompt, {
    timeoutMs: ACCEPTANCE_TIMEOUT_MS,
  })
  if (!io.write('\r')) {
    acceptance.cancel()
    return failure({
      stage: 'after-enter', code: 'write-failed', retrySafe: false,
      promptWritten: true, enterWritten: false,
      message: `Could not submit prompt to session ${io.sessionId}`,
    })
  }
  return acceptanceResult(await acceptance.promise, io.sessionId, true, true)
}

function acceptanceResult(
  outcome: PromptAcceptanceOutcome,
  sessionId: string,
  promptWritten: boolean,
  enterWritten: boolean,
): PromptDeliveryResult {
  if (outcome.kind === 'user' || outcome.kind === 'queue') {
    return { ok: true, acceptance: outcome }
  }
  return failure({
    stage: outcome.kind === 'session-exited' ? 'session-exit' : 'after-enter',
    code: outcome.kind === 'session-exited' ? 'session-exited' : 'acceptance-timeout',
    retrySafe: false,
    promptWritten,
    enterWritten,
    message: outcome.kind === 'session-exited'
      ? `Claude session ${sessionId} exited before accepting the prompt`
      : `Claude session ${sessionId} did not record prompt acceptance`,
  })
}
