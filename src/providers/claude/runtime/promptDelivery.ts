import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'
import {
  isPasteLike,
  pollClaudeImagesAbsorbed,
  pollPasteAbsorbed,
} from '@shared/claude/pasteConfirm.js'
import type { PromptAcceptanceOutcome } from '@shared/types/session.js'

const CONFIRM_TIMEOUT_MS = 2000
const CONFIRM_POLL_INTERVAL_MS = 10
const IMAGE_CONFIRM_TIMEOUT_MS = 5_000
// Longer than JsonlTailer's 15s watchdog so a recoverable watcher stall gets a
// chance to self-heal before we classify an already-written Enter as uncertain.
const ACCEPTANCE_TIMEOUT_MS = 20_000

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
  if (io.session.isPromptAcceptanceReady?.() === false) {
    return failure({
      stage: 'before-write', code: 'not-ready', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} transcript replay has not quiesced`,
    })
  }

  if (io.imagePaths && io.imagePaths.length > 0) {
    return deliverClaudeImagePrompt(io)
  }

  if (!isPasteLike(io.prompt)) {
    const acceptance = io.session.armPromptAcceptance(io.prompt, {
      timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    })
    io.record?.('acceptance-armed')
    if (!io.write(`${io.prompt}\r`)) {
      acceptance.cancel()
      return failure({
        stage: 'before-write', code: 'write-failed', retrySafe: true,
        promptWritten: false, enterWritten: false,
        message: `Could not write prompt to session ${io.sessionId}`,
      })
    }
    io.record?.('prompt-and-enter-written')
    return acceptanceResult(await acceptance.promise, io.sessionId, true, true, io.record)
  }

  if (typeof io.session.snapshotScreen !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} has no direct screen snapshot`,
    })
  }
  const baselineScreen = io.session.snapshotScreen()
  // Arm before any prompt bytes. Raw-terminal/manual Enter and legacy writers
  // are not supposed to interleave, but if one does, its durable acceptance
  // must not race past the observer and turn into a second Enter plus timeout.
  const acceptance = io.session.armPromptAcceptance(io.prompt, {
    timeoutMs: ACCEPTANCE_TIMEOUT_MS,
  })
  io.record?.('acceptance-armed')
  if (!io.write(`\x1b[200~${io.prompt}\x1b[201~`)) {
    acceptance.cancel()
    return failure({
      stage: 'before-write', code: 'write-failed', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Could not write paste to session ${io.sessionId}`,
    })
  }
  io.record?.('paste-written')

  const absorbed = await pollPasteAbsorbed(
    () => io.session.snapshotScreen?.() ?? '',
    baselineScreen,
    io.prompt,
    { timeoutMs: CONFIRM_TIMEOUT_MS, pollIntervalMs: CONFIRM_POLL_INTERVAL_MS },
  )
  if (absorbed.kind !== 'absorbed') {
    acceptance.cancel()
    // Prompt bytes are already editable in Claude even when our detector times
    // out. Automatic retry is unsafe: it would append/duplicate those bytes.
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      promptWritten: true, enterWritten: false,
      message: `Claude session ${io.sessionId} did not visibly absorb the paste`,
    })
  }
  io.record?.('paste-absorbed', { via: absorbed.via, waitedMs: absorbed.waitedMs })

  // Arm synchronously before Enter. This ordering is the acceptance analogue
  // of installing an event listener before starting the operation it observes.
  if (!io.write('\r')) {
    acceptance.cancel()
    return failure({
      stage: 'after-enter', code: 'write-failed', retrySafe: false,
      promptWritten: true, enterWritten: false,
      message: `Could not submit prompt to session ${io.sessionId}`,
    })
  }
  io.record?.('enter-written')
  return acceptanceResult(await acceptance.promise, io.sessionId, true, true, io.record)
}

async function deliverClaudeImagePrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  if (typeof io.session.snapshotScreen !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} has no direct screen snapshot`,
    })
  }
  const imagePaths = io.imagePaths ?? []
  const separator = io.prompt.length > 0 && !/\s$/.test(io.prompt) ? ' ' : ''
  const rawComposer = `${io.prompt}${separator}${imagePaths.join('\n')}`

  if (io.prompt.length > 0) {
    if (isPasteLike(io.prompt)) {
      const textBaseline = io.session.snapshotScreen()
      if (!io.write(`\x1b[200~${io.prompt}\x1b[201~`)) {
        return failure({
          stage: 'before-write', code: 'write-failed', retrySafe: true,
          promptWritten: false, enterWritten: false,
          message: `Could not write image prompt text to session ${io.sessionId}`,
        })
      }
      const textAbsorbed = await pollPasteAbsorbed(
        () => io.session.snapshotScreen?.() ?? '', textBaseline, io.prompt,
        { timeoutMs: CONFIRM_TIMEOUT_MS, pollIntervalMs: CONFIRM_POLL_INTERVAL_MS },
      )
      if (textAbsorbed.kind !== 'absorbed') {
        return failure({
          stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
          promptWritten: true, enterWritten: false,
          message: `Claude session ${io.sessionId} did not absorb image prompt text`,
        })
      }
    } else if (!io.write(io.prompt)) {
      return failure({
        stage: 'before-write', code: 'write-failed', retrySafe: true,
        promptWritten: false, enterWritten: false,
        message: `Could not write image prompt text to session ${io.sessionId}`,
      })
    }
    if (separator && !io.write(separator)) {
      return failure({
        stage: 'absorption', code: 'write-failed', retrySafe: false,
        promptWritten: true, enterWritten: false,
        message: `Could not separate image paths in session ${io.sessionId}`,
      })
    }
  }

  const imageBaseline = io.session.snapshotScreen()
  if (!io.write(`\x1b[200~${imagePaths.join('\n')}\x1b[201~`)) {
    return failure({
      stage: io.prompt.length > 0 ? 'absorption' : 'before-write',
      code: 'write-failed', retrySafe: io.prompt.length === 0,
      promptWritten: io.prompt.length > 0, enterWritten: false,
      message: `Could not paste image paths to session ${io.sessionId}`,
    })
  }
  const imagesAbsorbed = await pollClaudeImagesAbsorbed(
    () => io.session.snapshotScreen?.() ?? '', imageBaseline, imagePaths.length,
    { timeoutMs: IMAGE_CONFIRM_TIMEOUT_MS, pollIntervalMs: CONFIRM_POLL_INTERVAL_MS },
  )
  if (imagesAbsorbed.kind !== 'absorbed') {
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      promptWritten: true, enterWritten: false,
      message: `Claude session ${io.sessionId} did not render all image attachments`,
    })
  }
  io.record?.('images-absorbed', {
    imageCount: imagePaths.length,
    waitedMs: imagesAbsorbed.waitedMs,
  })
  // Image/text absorption can legitimately consume seven seconds. Starting
  // the 20-second waiter before that work left less than JsonlTailer's 15-second
  // watchdog window after Enter. Main's reservation now blocks every external
  // writer, so arming at this exact pre-Enter boundary is race-free and gives
  // durable acceptance the full recovery window without exceeding the remote
  // transport's 30-second request timeout.
  const acceptance = io.session.armPromptAcceptance!(io.prompt, {
    timeoutMs: ACCEPTANCE_TIMEOUT_MS,
    aliases: [rawComposer],
    requiresImage: io.prompt.length === 0,
    expectedImageCount: imagePaths.length,
  })
  io.record?.('acceptance-armed', { imageCount: imagePaths.length })
  if (!io.write('\r')) {
    acceptance.cancel()
    return failure({
      stage: 'after-enter', code: 'write-failed', retrySafe: false,
      promptWritten: true, enterWritten: false,
      message: `Could not submit image prompt to session ${io.sessionId}`,
    })
  }
  io.record?.('enter-written')
  return acceptanceResult(await acceptance.promise, io.sessionId, true, true, io.record)
}

function acceptanceResult(
  outcome: PromptAcceptanceOutcome,
  sessionId: string,
  promptWritten: boolean,
  enterWritten: boolean,
  record?: PromptDeliveryIo['record'],
): PromptDeliveryResult {
  if (outcome.kind === 'user' || outcome.kind === 'queue') {
    record?.(`acceptance-${outcome.kind}`, { acceptedAt: outcome.acceptedAt })
    return { ok: true, acceptance: outcome }
  }
  record?.('uncertain', { outcome: outcome.kind })
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
