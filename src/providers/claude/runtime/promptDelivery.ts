import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'
import {
  isPasteLike,
  pollClaudeImagesAbsorbed,
  pollPasteAbsorbed,
} from '@shared/claude/pasteConfirm.js'
import type { PromptAcceptanceOutcome, PromptReadinessOutcome } from '@shared/types/session.js'

const CONFIRM_TIMEOUT_MS = 2000
const CONFIRM_POLL_INTERVAL_MS = 10
const IMAGE_CONFIRM_TIMEOUT_MS = 5_000
// One wall-clock budget covers readiness, absorption, and durable acceptance.
// The previous independent 5s + 2/5s + 20s timers could exceed the caller's
// 30-second transport window while every individual stage still believed it
// had time left. Twenty-eight seconds leaves transport/serialization headroom;
// readiness gets at most twelve, and every later timer is clipped to the same
// absolute deadline. A normal already-painted composer therefore retains the
// full 20-second JSONL watcher-recovery window, while a genuinely slow startup
// cannot turn into an unbounded stack of fresh relative timeouts.
const DELIVERY_TIMEOUT_MS = 28_000
const READY_BUDGET_MS = 12_000
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
  const deliveryDeadlineAt = Date.now() + DELIVERY_TIMEOUT_MS
  if (typeof io.session.armPromptAcceptance !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} cannot observe prompt acceptance`,
    })
  }
  if (typeof io.session.awaitReadyForPrompt === 'function') {
    const ready = await io.session.awaitReadyForPrompt({
      deadlineAt: Math.min(deliveryDeadlineAt, Date.now() + READY_BUDGET_MS),
    })
    if (ready.kind !== 'ready') {
      const disposition = ready.kind === 'timeout'
        ? 'retry-same-session' as const
        : ready.kind === 'blocked' || ready.kind === 'occupied'
          ? 'retry-after-resolve' as const
          : 'session-unusable' as const
      return failure({
        stage: 'before-write', code: 'not-ready', retrySafe: true, disposition,
        promptWritten: false, enterWritten: false,
        message: `Claude session ${io.sessionId} prompt input is ${describeReadiness(ready)}`,
      })
    }
  } else if (io.session.isPromptAcceptanceReady?.() === false) {
    // WHY retain the synchronous fallback for capability-skewed sessions:
    // persisted/dev sessions can outlive a renderer/main update. They must
    // still reject safely before bytes rather than bypassing the historical
    // replay guard merely because they predate the awaited capability.
    return failure({
      stage: 'before-write', code: 'not-ready', retrySafe: true,
      disposition: 'retry-same-session',
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} transcript replay has not quiesced`,
    })
  }

  if (io.imagePaths && io.imagePaths.length > 0) {
    return deliverClaudeImagePrompt(io, deliveryDeadlineAt)
  }

  if (typeof io.session.snapshotScreen !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false, enterWritten: false,
      message: `Claude session ${io.sessionId} has no direct screen snapshot`,
    })
  }
  const baselineScreen = io.session.snapshotScreen()
  // Arm before any prompt bytes. Raw-terminal/manual Enter and legacy writers
  // are not supposed to interleave, but if one does, its durable acceptance
  // must not race past the observer and turn into a second Enter plus timeout.
  const acceptance = io.session.armPromptAcceptance(io.prompt, {
    timeoutMs: remainingBudget(deliveryDeadlineAt, ACCEPTANCE_TIMEOUT_MS),
  })
  io.record?.('acceptance-armed')
  const pasteLike = isPasteLike(io.prompt)
  const promptBytes = pasteLike
    ? `\x1b[200~${io.prompt}\x1b[201~`
    : io.prompt
  // Claude 2.1.209 invalidated the old "short text + Enter in one PTY write"
  // optimization. In affected long-lived sessions the text appeared in the
  // composer but the coalesced CR was swallowed, leaving a perfectly formed
  // prompt visibly stranded while our durable-acceptance waiter timed out.
  // Every prompt now crosses the same observable boundary: write text first,
  // prove its tail (or collapsed paste placeholder) reached the ACTIVE
  // composer, and only then send Enter as a separate write. The normal path is
  // still tens of milliseconds; the invariant is worth more than one syscall.
  if (!io.write(promptBytes)) {
    acceptance.cancel()
    return failure({
      stage: 'before-write', code: 'write-failed', retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false, enterWritten: false,
      message: `Could not write prompt to session ${io.sessionId}`,
    })
  }
  io.record?.(pasteLike ? 'paste-written' : 'prompt-written')

  const absorbed = await pollPasteAbsorbed(
    () => io.session.snapshotScreen?.() ?? '',
    baselineScreen,
    io.prompt,
    {
      timeoutMs: remainingBudget(deliveryDeadlineAt, CONFIRM_TIMEOUT_MS),
      pollIntervalMs: CONFIRM_POLL_INTERVAL_MS,
    },
  )
  if (absorbed.kind !== 'absorbed') {
    acceptance.cancel()
    // Prompt bytes are already editable in Claude even when our detector times
    // out. Automatic retry is unsafe: it would append/duplicate those bytes.
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true, enterWritten: false,
      message: `Claude session ${io.sessionId} did not visibly absorb the prompt`,
    })
  }
  io.record?.(pasteLike ? 'paste-absorbed' : 'prompt-absorbed', {
    via: absorbed.via,
    waitedMs: absorbed.waitedMs,
  })

  // Arm synchronously before Enter. This ordering is the acceptance analogue
  // of installing an event listener before starting the operation it observes.
  if (!io.write('\r')) {
    acceptance.cancel()
    return failure({
      stage: 'after-enter', code: 'write-failed', retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true, enterWritten: false,
      message: `Could not submit prompt to session ${io.sessionId}`,
    })
  }
  io.record?.('enter-written')
  return acceptanceResult(await acceptance.promise, io.sessionId, true, true, io.record)
}

async function deliverClaudeImagePrompt(
  io: PromptDeliveryIo,
  deliveryDeadlineAt: number,
): Promise<PromptDeliveryResult> {
  if (typeof io.session.snapshotScreen !== 'function') {
    return failure({
      stage: 'before-write', code: 'missing-capability', retrySafe: true,
      disposition: 'session-unusable',
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
          disposition: 'session-unusable',
          promptWritten: false, enterWritten: false,
          message: `Could not write image prompt text to session ${io.sessionId}`,
        })
      }
      const textAbsorbed = await pollPasteAbsorbed(
        () => io.session.snapshotScreen?.() ?? '', textBaseline, io.prompt,
        {
          timeoutMs: remainingBudget(deliveryDeadlineAt, CONFIRM_TIMEOUT_MS),
          pollIntervalMs: CONFIRM_POLL_INTERVAL_MS,
        },
      )
      if (textAbsorbed.kind !== 'absorbed') {
        return failure({
          stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
          disposition: 'do-not-retry',
          promptWritten: true, enterWritten: false,
          message: `Claude session ${io.sessionId} did not absorb image prompt text`,
        })
      }
    } else if (!io.write(io.prompt)) {
      return failure({
        stage: 'before-write', code: 'write-failed', retrySafe: true,
        disposition: 'session-unusable',
        promptWritten: false, enterWritten: false,
        message: `Could not write image prompt text to session ${io.sessionId}`,
      })
    }
    if (separator && !io.write(separator)) {
      return failure({
        stage: 'absorption', code: 'write-failed', retrySafe: false,
        disposition: 'do-not-retry',
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
      disposition: io.prompt.length === 0 ? 'session-unusable' : 'do-not-retry',
      promptWritten: io.prompt.length > 0, enterWritten: false,
      message: `Could not paste image paths to session ${io.sessionId}`,
    })
  }
  const imagesAbsorbed = await pollClaudeImagesAbsorbed(
    () => io.session.snapshotScreen?.() ?? '', imageBaseline, imagePaths.length,
    {
      timeoutMs: remainingBudget(deliveryDeadlineAt, IMAGE_CONFIRM_TIMEOUT_MS),
      pollIntervalMs: CONFIRM_POLL_INTERVAL_MS,
    },
  )
  if (imagesAbsorbed.kind !== 'absorbed') {
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true, enterWritten: false,
      message: `Claude session ${io.sessionId} did not render all image attachments`,
    })
  }
  io.record?.('images-absorbed', {
    imageCount: imagePaths.length,
    waitedMs: imagesAbsorbed.waitedMs,
  })
  // Image/text absorption can legitimately consume seven seconds. Main's
  // reservation blocks every external writer, so image acceptance can be armed
  // at this exact pre-Enter boundary without a race. The waiter receives the
  // remaining shared budget—not a fresh 20 seconds—so a delayed readiness or
  // absorption phase cannot silently overrun the outer request deadline.
  const acceptance = io.session.armPromptAcceptance!(io.prompt, {
    timeoutMs: remainingBudget(deliveryDeadlineAt, ACCEPTANCE_TIMEOUT_MS),
    aliases: [rawComposer],
    requiresImage: io.prompt.length === 0,
    expectedImageCount: imagePaths.length,
  })
  io.record?.('acceptance-armed', { imageCount: imagePaths.length })
  if (!io.write('\r')) {
    acceptance.cancel()
    return failure({
      stage: 'after-enter', code: 'write-failed', retrySafe: false,
      disposition: 'do-not-retry',
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
  // Redactor trap: journal data keys matching /prompt|content|text|…/i are
  // dropped, so the tallies use miss* names. `missExact` > 0 is the headline
  // number — it means Claude wrote an entry in our window and the text
  // comparison refused it, which is exactly the class that made 21/21
  // recorded timeouts false before the whitespace-collapse fix.
  record?.('uncertain', {
    outcome: outcome.kind,
    ...(outcome.kind === 'timeout' && outcome.nearMisses
      ? {
          missCursor: outcome.nearMisses.cursor,
          missTimestamp: outcome.nearMisses.timestamp,
          missImage: outcome.nearMisses.image,
          missExact: outcome.nearMisses.exact,
        }
      : {}),
  })
  return failure({
    stage: outcome.kind === 'session-exited' ? 'session-exit' : 'after-enter',
    code: outcome.kind === 'session-exited' ? 'session-exited' : 'acceptance-timeout',
    retrySafe: false,
    disposition: 'do-not-retry',
    promptWritten,
    enterWritten,
    message: outcome.kind === 'session-exited'
      ? `Claude session ${sessionId} exited before accepting the prompt`
      : `Claude session ${sessionId} did not record prompt acceptance`,
  })
}

function remainingBudget(deadlineAt: number, stageCapMs: number): number {
  return Math.max(0, Math.min(stageCapMs, deadlineAt - Date.now()))
}

function describeReadiness(
  outcome: Exclude<PromptReadinessOutcome, { kind: 'ready' }>,
): string {
  if (outcome.kind === 'timeout') return `still warming (${outcome.lastState.reason})`
  if (outcome.kind === 'blocked') return `blocked by ${outcome.condition}`
  if (outcome.kind === 'occupied') return 'occupied by a human draft'
  return `unavailable (${outcome.reason})`
}
