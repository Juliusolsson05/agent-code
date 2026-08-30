import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'
import { parseClaudeComposerState } from 'claude-code-headless'
import {
  isPasteLike,
  pollClaudeImagesAbsorbed,
  pollPasteAbsorbed,
} from '@shared/claude/pasteConfirm.js'
import type { PromptAcceptanceOutcome, PromptReadinessOutcome } from '@shared/types/session.js'

// Text absorption budget. Was 2000ms, and every one of the ten recorded
// delivery failures ended at 2002-2034ms — the cap fired every single time,
// never the underlying operation. The one failure with a PTY recording shows
// the prompt actually reaching the composer at 2575ms: Claude was mid-turn, so
// its repaint lagged. A 5s budget would have confirmed it.
//
// WHY raising this is close to free: pollPasteAbsorbed exits on the first
// match, so a healthy send still returns in tens of milliseconds. The cap is
// only paid when we are about to fail, and failing here is expensive — it
// leaves bytes in the composer that the prompt gate then reads as a human
// draft (#679).
//
// Matched to IMAGE_CONFIRM_TIMEOUT_MS rather than invented: image absorption
// already needed five seconds for the same reason, and there is no argument for
// text being quicker to repaint than an image pill.
const CONFIRM_TIMEOUT_MS = 5_000
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
    // out, and automatic retry remains unsafe because it would append to them.
    //
    // But abandoning them in place is what deadlocked sessions (#679): the gate
    // then reads OUR stranded bytes as a human draft, and that state has no
    // timeout by design, so every later delivery is refused. Roll them back
    // while the reservation still guarantees the composer is ours alone.
    const rollback = await rollbackWrittenPrompt(io)
    if (rollback === 'cleared') {
      // Nothing of ours is left in the composer, so retrying cannot duplicate
      // anything — the reason `do-not-retry` existed is gone. The caller's
      // draft is untouched in the app composer; only Claude's copy was removed.
      return failure({
        stage: 'absorption', code: 'absorption-timeout', retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false, enterWritten: false,
        message: `Claude session ${io.sessionId} did not visibly absorb the prompt; it was not sent and the draft was cleared from Claude's composer`,
      })
    }
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true, enterWritten: false,
      message: rollback === 'restored'
        ? `Claude session ${io.sessionId} did not visibly absorb the prompt, and it is still in Claude's composer — clear it there before sending again`
        : `Claude session ${io.sessionId} did not visibly absorb the prompt and its composer could not be recovered`,
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
        // Same stranded-bytes hazard as the text-only path (#679). Only the
        // TEXT has been written at this point — the image paths follow below —
        // so a kill-to-line-start rollback can still fully clear the composer.
        const rollback = await rollbackWrittenPrompt(io)
        if (rollback === 'cleared') {
          return failure({
            stage: 'absorption', code: 'absorption-timeout', retrySafe: true,
            disposition: 'retry-same-session',
            promptWritten: false, enterWritten: false,
            message: `Claude session ${io.sessionId} did not absorb image prompt text; it was not sent and the draft was cleared from Claude's composer`,
          })
        }
        return failure({
          stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
          disposition: 'do-not-retry',
          promptWritten: true, enterWritten: false,
          message: `Claude session ${io.sessionId} did not absorb image prompt text, and it is still in Claude's composer`,
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
    // Deliberately NOT rolled back, and this is the honest limitation.
    //
    // By this point the composer holds prompt text AND however many image pills
    // Claude did manage to render. Ctrl+U kills text to the start of a visual
    // line; whether it removes an image pill is not established, and a rollback
    // that strips the text while leaving orphaned pills is worse than leaving
    // both — it produces a composer whose content matches nothing either side
    // believes it wrote.
    //
    // So this path can still strand bytes and still latch the gate. It is
    // reachable only with attachments, and none of the recorded #679 failures
    // involved images. Closing it needs the pill-clearing behaviour established
    // against a real composer first.
    return failure({
      stage: 'absorption', code: 'absorption-timeout', retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true, enterWritten: false,
      message: `Claude session ${io.sessionId} did not render all image attachments; the prompt is still in Claude's composer`,
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
  record?.('uncertain', { outcome: outcome.kind })
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

// Ctrl+U. Kill-to-line-start in Claude's input, and deliberately NOT Escape.
//
// WHY NOT `\x1b`, which upstream turns into a full composer clear that even
// saves the text to Claude's own history first: `\x1b` is the byte Agent Code's
// Stop button sends (TileLeaf.tsx, onStop). Escape only clears the composer when
// Claude is IDLE; while it is RUNNING the same byte interrupts the turn. Every
// rollback below happens because absorption timed out, and absorption times out
// precisely BECAUSE Claude is mid-turn — the recorded case shows the prompt
// repainting 2.6s after the write while Claude was busy. Sending Escape there
// would abort the agent's work, which is strictly worse than the stranded bytes
// we are trying to clean up. Ctrl+U is correct here for the narrow reason that
// it carries no second meaning.
const KILL_TO_LINE_START = '\x15'
// Ctrl+Y. Consecutive kills accumulate into ONE kill-ring entry, so a single
// yank restores everything the loop removed.
const YANK = '\x19'
// Claude kills to the start of the VISUAL line, so a wrapped prompt needs one
// press per wrapped row and the count depends on terminal width, which we do
// not know here. Bounded rather than computed: we verify after every press
// instead of predicting how many are needed.
const MAX_KILL_PRESSES = 64

/**
 * Remove bytes THIS delivery wrote from Claude's composer after a write that
 * could not be completed with Enter.
 *
 * WHY this is safe to do at all — the ownership proof is structural, not a
 * guess: `SessionManager.write()` refuses raw input for the whole time a
 * delivery holds the session's reservation (`promptDeliveriesInFlight`, taken
 * before `deliverPrompt` and released in a `finally`). So while this runs, no
 * human keystroke can have reached this composer. Anything in it is ours.
 *
 * That is what makes this different from the first design of #679, which tried
 * to prove ownership by comparing the composer's rendered text to the prompt we
 * sent. That comparison cannot work: the screen is viewport-clipped and
 * wrap-lossy, and Claude collapses paste-like input — anything with a newline or
 * over 100 characters, which is most agent traffic — to `[Pasted text #N +M
 * lines]`, so the text on screen is not the text we wrote.
 *
 * Returns what actually happened so the caller can classify honestly rather
 * than assume.
 */
async function rollbackWrittenPrompt(
  io: PromptDeliveryIo,
): Promise<'cleared' | 'restored' | 'unrecoverable'> {
  const readComposer = (): 'empty' | 'drafted' | 'unpainted' =>
    // Classified WITHOUT cell attributes, which is the fail-closed path: with
    // no attributes an unrecognised row is reported as 'drafted'. That error
    // direction is the safe one here — a false 'drafted' ends the loop and
    // restores, whereas a false 'empty' would let us report success over a
    // composer still holding half a prompt.
    parseClaudeComposerState(io.session.snapshotScreen?.() ?? '', null)

  for (let press = 0; press < MAX_KILL_PRESSES; press += 1) {
    if (readComposer() === 'empty') {
      io.record?.('rollback-cleared', { presses: press })
      return 'cleared'
    }
    if (!io.write(KILL_TO_LINE_START)) {
      io.record?.('rollback-write-failed', { presses: press })
      return 'unrecoverable'
    }
    // The composer repaints on Claude's own schedule, which is the same lag
    // that caused the absorption timeout in the first place.
    await new Promise(resolve => setTimeout(resolve, CONFIRM_POLL_INTERVAL_MS))
  }

  // Bounded out with content still present. Put it back rather than leave a
  // partially killed prompt: a later Enter — the user's, or another delivery's
  // — would submit a mangled fragment, which is the exact failure this whole
  // subsystem exists to prevent. One yank is enough because the kills
  // accumulated into a single kill-ring entry.
  const restored = io.write(YANK)
  io.record?.('rollback-exhausted', { presses: MAX_KILL_PRESSES, restored })
  return restored ? 'restored' : 'unrecoverable'
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
