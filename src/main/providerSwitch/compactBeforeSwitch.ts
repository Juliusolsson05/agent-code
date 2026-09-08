// See docs/design/provider-switching.md for why Claude can transfer its native
// summary directly while Codex needs a second plaintext handoff turn.
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'

import type { ConversationDocument, ConversationOpaque } from 'agent-transcript-parser'
import type { ConversationContextPlan } from 'agent-transcript-parser'
import {
  conversationAfterLatestPortableCompaction,
  describeLatestCompaction,
  findApiErrorAfterLine,
  isRateLimitText,
  portableCodexHandoffAfterLine,
  portableOpencodeHandoffAfterLine,
} from 'agent-transcript-parser'

import type { SessionManager } from '@main/sessionManager.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import type { SwitchProviderRequest } from '@main/providerSwitch/switchProvider.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

const COMPACTION_TIMEOUT_MS = 300_000
const COMPACTION_POLL_MS = 250
// WHY decodes are rate-limited independently of the poll cadence: one decode of
// a long Codex rollout is a readFile + JSONL parse + conversation decode of
// 60–150 MB on the main thread (hundreds of ms, hundreds of MB allocated). The
// stat() gate below already skips decodes while the file is unchanged, but a
// provider that appends continuously would otherwise be decoded on every
// 250 ms tick. A 1 s floor caps that at one decode per second — at most 1 s of
// added latency on a wait that already spans tens of seconds — so the event
// loop stays responsive for every other pane while the switch waits (#720).
const MIN_DECODE_INTERVAL_MS = 1_000
const PORTABLE_SUMMARY_PROMPT = [
  'Read only. Do not use tools or modify files.',
  'Write a detailed portable handoff summary of the conversation so another coding agent can continue the work.',
  'Include completed work, decisions, files changed, validation, unresolved failures, and exact next steps.',
  'Return only the handoff summary.',
].join(' ')

type SourceAdapter = ReturnType<typeof getHostTranscriptAdapter>

/**
 * The session whose transcript a wait loop watches.
 *
 * WHY this exists instead of threading `SwitchProviderRequest` through the
 * loops, which is what they took before: a request describes a switch, and a
 * switch has a source. The loops only ever needed "which live session, of which
 * provider kind, writing which transcript in which directory" — four scalars
 * that a request happens to contain for the SOURCE side only. Arrival
 * compaction (Stage 5) runs the same wait against the freshly created TARGET
 * session, which no `SwitchProviderRequest` can name: its provider kind is the
 * target's and its session id did not exist when the request was built. Naming
 * the watched session directly is what lets one wait loop serve both.
 */
export type TranscriptWatchTarget = {
  sessionId: string
  kind: AgentProviderKind
  cwd: string
  providerSessionId: string
}

/**
 * What a compaction wait's failures MEAN, supplied by whoever started it.
 *
 * WHY this is a required parameter and not a default: the two callers of
 * `waitForNewCompactionOn` are on opposite sides of the pane replacement, so
 * every sentence this wait can produce is true for exactly one of them. The
 * source path runs before anything is replaced ("the switch was aborted before
 * any pane was replaced"); arrival compaction runs after the pane is already
 * live on the target, where that same sentence is simply false — no switch was
 * aborted, and the session that died was the NEW one. A default would make the
 * lie the silent option, and the message is the only thing the user sees.
 */
export type CompactionWaitPhrasing = {
  /** The watched session died before the compaction landed. */
  exited: string
  /**
   * What the failure leaves the user with, appended after every cause this
   * wait reports ("… reported an API error instead of compacting; <this>.").
   * Written as a clause, without leading capital or trailing period.
   */
  consequence: string
}

// The source path's phrasing: nothing has been replaced yet, so every failure
// here is an abort of the whole switch.
const SOURCE_SWITCH_PHRASING: CompactionWaitPhrasing = {
  exited: 'The source agent exited while native compaction was running.',
  consequence: 'the switch was aborted before any pane was replaced',
}

export async function compactSourceBeforeSwitch(
  manager: SessionManager,
  request: SwitchProviderRequest,
  plan: Extract<ConversationContextPlan, {
    kind: 'requires-compaction' | 'requires-portable-handoff'
  }>,
  onPortableSummary?: () => void,
): Promise<ConversationDocument> {
  const sourceSessionId = request.sourceSessionId
  if (!sourceSessionId) {
    throw new Error('Cannot compact before provider switch without a live source session id.')
  }
  if (manager.getSessionKind(sourceSessionId) !== request.sourceKind) {
    throw new Error('The source agent changed or exited before compaction could start.')
  }
  const liveCwd = manager.getSpawnCwd(sourceSessionId)
  const sourceCwd = request.sourceCwd ?? request.cwd
  if (!liveCwd || resolve(liveCwd) !== resolve(sourceCwd)) {
    throw new Error('The live source agent no longer belongs to this provider-switch request.')
  }

  const source = getHostTranscriptAdapter(request.sourceKind)
  const target: TranscriptWatchTarget = {
    sessionId: sourceSessionId,
    kind: request.sourceKind,
    cwd: sourceCwd,
    providerSessionId: request.sourceProviderSessionId,
  }

  if (request.sourceKind === 'opencode') {
    // OpenCode's supported storage boundary is `opencode export`; it has no
    // stable transcript path for Agent Code to watch and its slash-command
    // parser lives inside the interactive TUI. Asking for one ordinary,
    // read-only handoff turn works for both the terminal and structured
    // runtimes, then the export's completed timestamp proves durability.
    const summaryBaselineLine = await readSourceAs(
      source,
      target.cwd,
      target.providerSessionId,
      latestSourceLine,
    )
    onPortableSummary?.()
    const delivery = await manager.deliverPromptToAgent(sourceSessionId, PORTABLE_SUMMARY_PROMPT)
    if (!delivery.ok) {
      throw new Error(`Could not request OpenCode portable handoff: ${delivery.message}`)
    }
    return await waitForPortableOpencodeSummary(manager, target, source, summaryBaselineLine)
  }

  // WHY no local below holds a ConversationDocument: this function and its
  // wait loops are suspended on timers for up to five minutes, and V8 keeps
  // every register of a suspended async function alive in its generator
  // object. The 2026-09-03 heap snapshot (issue #720) showed three full copies
  // of an 18k-entry rollout — `before`, `compacted`, and the current poll's
  // document — pinned here for the entire wait, 80% of the main heap. Every
  // read now goes through a selector helper that decodes, derives, and lets
  // the document die before the caller awaits anything. The one copy that
  // remains reachable is `plan.conversation`, which switchProvider and the IPC
  // handler hold anyway; dropping it is a caller-side follow-up (see the plan
  // doc), not something this frame can achieve alone.
  if (plan.kind === 'requires-compaction') {
    // Both baselines come out of ONE decode, deliberately: they describe the
    // same instant of the same file, and a second read could straddle a write
    // that lands between them — a compaction fingerprint from before an
    // `api_error` and a line number from after it would make the hazard check
    // below look at the wrong side of its own baseline. Two numbers, no
    // document (#720).
    const before = await readSourceAs(
      source,
      target.cwd,
      target.providerSessionId,
      conversation => ({
        fingerprint: describeLatestCompaction(conversation)?.fingerprint ?? null,
        line: latestSourceLine(conversation),
      }),
    )
    const delivery = await manager.deliverPromptToAgent(sourceSessionId, '/compact')
    if (!delivery.ok) {
      throw new Error(`Could not start native ${request.sourceKind} compaction: ${delivery.message}`)
    }

    if (request.sourceKind === 'claude') {
      return await waitForNewCompactionOn(
        manager,
        target,
        before.fingerprint,
        before.line,
        SOURCE_SWITCH_PHRASING,
        conversationAfterLatestPortableCompaction,
      )
    }
    const summaryBaselineLine = await waitForNewCompactionOn(
      manager,
      target,
      before.fingerprint,
      before.line,
      SOURCE_SWITCH_PHRASING,
      latestSourceLine,
    )
    return await requestPortableCodexHandoff(
      manager,
      target,
      source,
      summaryBaselineLine,
      onPortableSummary,
    )
  }

  // 'requires-portable-handoff': the source already persisted a durable
  // compaction, so no `/compact` is sent; the existing record is the baseline.
  if (request.sourceKind === 'claude') {
    return await readSourceAs(
      source,
      target.cwd,
      target.providerSessionId,
      conversationAfterLatestPortableCompaction,
    )
  }
  const summaryBaselineLine = await readSourceAs(
    source,
    target.cwd,
    target.providerSessionId,
    latestSourceLine,
  )
  return await requestPortableCodexHandoff(
    manager,
    target,
    source,
    summaryBaselineLine,
    onPortableSummary,
  )
}

// WHY Codex needs a second, ordinary turn after native /compact: modern
// Codex persists its replacement history as provider-authenticated encrypted
// content. That record is useful when Codex resumes itself but deliberately
// cannot be decoded into Claude's plaintext compact-summary carrier. Asking
// the now-compacted source session for a read-only handoff lets Codex decrypt
// and summarize its own memory without Agent Code forging ciphertext.
async function requestPortableCodexHandoff(
  manager: SessionManager,
  target: TranscriptWatchTarget,
  source: SourceAdapter,
  summaryBaselineLine: number,
  onPortableSummary: (() => void) | undefined,
): Promise<ConversationDocument> {
  onPortableSummary?.()
  const summaryDelivery = await manager.deliverPromptToAgent(
    target.sessionId,
    PORTABLE_SUMMARY_PROMPT,
  )
  if (!summaryDelivery.ok) {
    throw new Error(`Codex compacted successfully but could not create a portable handoff: ${summaryDelivery.message}`)
  }
  return await waitForPortableCodexSummary(manager, target, source, summaryBaselineLine)
}

/**
 * Wait for `target` to persist a compaction newer than `beforeFingerprint`.
 *
 * Exported because Stage 5's arrival compaction runs exactly this wait against
 * the session the switch just created — same `/compact`, same "is the new
 * boundary durable yet", same two hazards — and duplicating it there is how the
 * hazard checks below would come to exist in only one of the two copies.
 *
 * `baselineLine` is the last transcript line that existed before `/compact` was
 * sent. Everything the hazard check looks at must be strictly newer than it, or
 * an api_error from an hour ago would abort a healthy compaction.
 */
export async function waitForNewCompactionOn<T>(
  manager: SessionManager,
  target: TranscriptWatchTarget,
  beforeFingerprint: string | null,
  baselineLine: number,
  phrasing: CompactionWaitPhrasing,
  // WHY the caller chooses what survives: Claude needs the post-compaction
  // document itself (its native summary is the portable carrier), Codex only
  // needs the line number its handoff must land after. Selecting inside the
  // probe keeps the full document out of this generator's saved registers.
  select: (conversation: ConversationDocument) => T,
): Promise<T> {
  const source = getHostTranscriptAdapter(target.kind)
  return await pollSourceUntil(manager, target, source, {
    exitedMessage: phrasing.exited,
    timeoutMessage: lastReadError => {
      // WHY transient read errors are retried rather than surfaced: providers
      // append JSONL while compaction runs, and the stable-reader intentionally
      // rejects a snapshot caught between bytes. The timeout remains the
      // authoritative failure; surfacing the first transient would turn normal
      // append timing into a failed provider switch after `/compact` was
      // already accepted.
      const detail = lastReadError instanceof Error ? ` Last read failed: ${lastReadError.message}` : ''
      return `Timed out waiting for ${target.kind} to persist a native compaction record; ${phrasing.consequence}.${detail}`
    },
  }, conversation => {
    // #820, hazard 1: the provider answered `/compact` with an error instead of
    // a summary. It writes that as an ordinary api_error record and then stops,
    // so waiting longer buys nothing — the wait would run its full five minutes
    // and report a timeout, which reads to the user as "Agent Code is slow"
    // rather than "the provider refused and your history was just compacted".
    const apiError = findApiErrorAfterLine(conversation, baselineLine)
    if (apiError) throw new Error(describeApiErrorAbort(target.kind, apiError, 'compacting', phrasing))
    const latest = describeLatestCompaction(conversation)
    if (latest && latest.fingerprint !== beforeFingerprint) {
      // #820, hazard 2, and the worse of the two: Claude's own compaction only
      // rejects summaries that start with "API Error", so a limit hit during
      // `/compact` can be persisted AS the summary. The carrier then looks like
      // a perfectly durable new boundary — right kind, new fingerprint, complete
      // — and accepting it would switch the pane onto a transcript whose entire
      // history has been replaced by "You've hit your monthly spend limit".
      // `compactionAvailability` calls that `rejected`; there is no recovery,
      // only an honest abort.
      if (latest.availability === 'rejected') {
        throw new Error(
          `The ${target.kind} provider wrote a usage-limit message where its compaction summary should be; ${phrasing.consequence}.`,
        )
      }
      if (latest.availability !== 'incomplete') return { value: select(conversation) }
    }
    return null
  })
}

async function waitForPortableCodexSummary(
  manager: SessionManager,
  target: TranscriptWatchTarget,
  source: SourceAdapter,
  baselineLine: number,
): Promise<ConversationDocument> {
  return await pollSourceUntil(manager, target, source, {
    exitedMessage: 'The Codex source agent exited while creating its portable handoff.',
    timeoutMessage: () => 'Timed out waiting for compacted Codex to persist a portable handoff summary.',
  }, conversation => {
    // The handoff turn is an ordinary turn against the same quota that
    // `/compact` just spent, so it is at least as likely to hit a limit — and
    // this wait runs AFTER the source's history was already replaced, which
    // makes a five-minute silent timeout the worst possible report. Same
    // fast-fail as the compaction wait above.
    //
    // HONEST LIMIT: only the Claude decoder classifies `opaque`/`api_error`
    // today (parser: claude/conversation/decode.ts), so for a Codex source this
    // probe cannot fire yet. It is here because it is the correct shape and
    // costs one comparison per decode; it starts working the moment Codex error
    // records are classified (codex-headless#46's `usage_limit_reached` is the
    // other half of Stage 4). Until then, a Codex limit during the handoff
    // still ends in the timeout above.
    const apiError = findApiErrorAfterLine(conversation, baselineLine)
    if (apiError) throw new Error(describeApiErrorAbort(target.kind, apiError, 'a portable handoff', SOURCE_SWITCH_PHRASING))
    const handoff = portableCodexHandoffAfterLine(conversation, baselineLine)
    if (!handoff) return null
    // Only the synthetic compaction entry travels on; the source's entries
    // array is dropped here, on purpose (see the retention note above).
    return {
      value: {
        ...conversation,
        entries: [{
          kind: 'compaction',
          summary: handoff.summary,
          summarySource: 'synthetic',
          timestamp: handoff.message.timestamp,
          source: handoff.message.source,
        }],
      },
    }
  })
}

async function waitForPortableOpencodeSummary(
  manager: SessionManager,
  target: TranscriptWatchTarget,
  source: SourceAdapter,
  baselineLine: number,
): Promise<ConversationDocument> {
  return await pollSourceUntil(manager, target, source, {
    exitedMessage: 'The OpenCode source agent exited while creating its portable handoff.',
    timeoutMessage: () => 'Timed out waiting for OpenCode to persist a portable handoff summary.',
  }, conversation => {
    // Same fast-fail, same honest limit as the Codex wait above: OpenCode's
    // decoder does not classify api_error records either, so this cannot fire
    // until it does. It is written once here rather than left as a TODO because
    // the failure it prevents — a five-minute wait on a provider that already
    // answered — is the one this whole module exists to avoid.
    const apiError = findApiErrorAfterLine(conversation, baselineLine)
    if (apiError) throw new Error(describeApiErrorAbort(target.kind, apiError, 'a portable handoff', SOURCE_SWITCH_PHRASING))
    const handoff = portableOpencodeHandoffAfterLine(conversation, baselineLine)
    if (!handoff) return null
    return {
      value: {
        ...conversation,
        entries: [{
          kind: 'compaction',
          summary: handoff.summary,
          summarySource: 'synthetic',
          timestamp: handoff.message.timestamp,
          source: handoff.message.source,
        }],
      },
    }
  })
}

/**
 * The message a wait aborts with when an `api_error` record lands after its
 * baseline.
 *
 * WHY the wording is generic unless the record proves otherwise: an earlier cut
 * of this said "reported a usage limit instead of compacting" for EVERY
 * api_error, but `findApiErrorAfterLine` has no text predicate — it matches any
 * `opaque` entry the decoder classified as `api_error`, which includes
 * connection failures, timeouts, and "overloaded". Telling a user their account
 * is out of quota when the network dropped sends them to a billing page to fix
 * a wifi problem, and the message is the ONLY thing they see, because the abort
 * is deliberately terminal.
 *
 * The limit case is still named when the record itself carries the evidence.
 * Two independent signals, either is enough:
 *
 * - `error: 'rate_limit'` — Claude Code's own classification on the raw record.
 * - the assistant text matching the parser's `isRateLimitText`, which is the
 *   same prefix list Claude Code writes those messages from
 *   (services/rateLimitMessages.ts).
 *
 * Neither survives fixture redaction (`error` becomes "fixture text" and so
 * does the message body), which is exactly why the fixture-driven test in this
 * module's suite asserts the GENERIC wording — see the comment there.
 */
function describeApiErrorAbort(
  kind: AgentProviderKind,
  entry: ConversationOpaque,
  insteadOf: string,
  phrasing: CompactionWaitPhrasing,
): string {
  const cause = isUsageLimitRecord(entry) ? 'a usage limit' : 'an API error'
  return `The ${kind} provider reported ${cause} instead of ${insteadOf}; ${phrasing.consequence}.`
}

function isUsageLimitRecord(entry: ConversationOpaque): boolean {
  const raw = entry.source.raw
  if (raw.error === 'rate_limit') return true
  return isRateLimitText(apiErrorMessageText(raw))
}

// The raw record's own assistant text, if it has any. Claude writes the limit
// message as an ordinary assistant record
// (`message.content: [{ type: 'text', text }]`), so that is the only shape read
// here; anything else yields '' and the caller falls back to the generic
// wording rather than guessing.
function apiErrorMessageText(raw: Record<string, unknown>): string {
  const message = raw.message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
    ))
    .join('\n')
}

type PollOptions = {
  exitedMessage: string
  timeoutMessage: (lastReadError: unknown) => string
}

/**
 * A probe either produced a value, produced nothing yet, or decided the wait
 * must stop. The third case exists because the probe runs inside the decode's
 * try/catch — see `pollSourceUntil` — and that catch means "the file was caught
 * mid-write, try again", which is the exact opposite of what a probe throw
 * means.
 */
type ProbeStep<T> = { value: T } | null

// Poll the live source transcript until `probe` accepts a decoded snapshot.
//
// WHY stat() gates the decode: the previous implementation called
// `source.read()` on every 250 ms tick. For Codex that is a walk of the whole
// date-bucketed sessions tree to find the rollout, then a full decode of a
// file that can exceed 100 MB — four times a second, for up to five minutes,
// on the main thread. The transcript only matters when it has grown, and
// `size:mtimeMs` is enough to tell. Both providers append (or atomically
// replace, which moves mtime), so a same-size in-place rewrite is not a shape
// this has to detect.
//
// WHY the path is resolved lazily and re-resolved after a stat failure: a
// resumed Codex session can start writing a different rollout than the one
// carrying its id (CodexHeadless #159), and `read()` always followed the
// newest file. Pinning one path for the whole wait would turn that into a
// silent 300 s timeout, so a failed stat drops the pinned path and the next
// decode locates again. Locate failures are retried to the deadline like
// read failures — a rollout that a `read()` just found should not fail the
// switch because one poll could not see it.
//
// The change token is sampled right BEFORE each decode so an append that
// lands during the decode moves the token relative to `lastToken` and forces
// a re-check on the next tick; sampling afterwards could swallow that write.
async function pollSourceUntil<T>(
  manager: SessionManager,
  target: TranscriptWatchTarget,
  source: SourceAdapter,
  options: PollOptions,
  probe: (conversation: ConversationDocument) => ProbeStep<T>,
): Promise<T> {
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS
  let transcriptPath: string | null = null
  let lastToken: string | null = null
  let decodePending = true
  // Measured from the END of the previous decode, not its start: a decode
  // that itself takes most of a second must not be immediately followed by
  // another, or the floor would bound nothing on a continuously appending
  // source.
  let lastDecodeEndedAt = Number.NEGATIVE_INFINITY
  let lastReadError: unknown = null
  const fileBacked = typeof source.locate === 'function' && typeof source.readAt === 'function'

  // WHY the probe's decision is carried out of the try/catch in a box rather
  // than simply thrown from inside the selector: the selector necessarily runs
  // INSIDE the decode (that is the whole #720 retention trick — the document
  // must die in the frame that read it), and the decode's catch means "this
  // snapshot was caught mid-append, try again in a second". A probe throw means
  // the opposite: the provider gave a definitive, terminal answer, most
  // urgently a usage limit after `/compact` has already run. Letting the catch
  // swallow it would turn a two-decode abort into a five-minute timeout with a
  // misleading message. The box is checked after the catch, so the throw
  // happens outside it.
  const abort: { failed: boolean; error: unknown } = { failed: false, error: null }
  const guardedProbe = (conversation: ConversationDocument): ProbeStep<T> => {
    try {
      return probe(conversation)
    } catch (error) {
      abort.failed = true
      abort.error = error
      return null
    }
  }

  const decodeOnce = async (): Promise<ProbeStep<T>> => {
    let outcome: ProbeStep<T> = null
    try {
      if (!fileBacked) {
        outcome = await readSourceAs(
          source,
          target.cwd,
          target.providerSessionId,
          guardedProbe,
        )
        lastReadError = null
        // A CLI export has no cheap stat token. Keep it pending so the next
        // cooled tick exports again; MIN_DECODE_INTERVAL_MS still prevents a
        // long session from monopolizing the main process.
        decodePending = true
      } else {
        if (transcriptPath === null) {
          transcriptPath = await source.locate!(target.cwd, target.providerSessionId)
        }
        lastToken = await transcriptChangeToken(transcriptPath)
        outcome = await readSourceAtAs(source, transcriptPath, guardedProbe)
        lastReadError = null
        decodePending = false
      }
    } catch (error) {
      // A failed locate/read says nothing about whether the file settled, so
      // the next cooled tick decodes again even if the token did not move.
      lastReadError = error
      decodePending = true
      outcome = null
    } finally {
      lastDecodeEndedAt = Date.now()
    }
    if (abort.failed) throw abort.error
    return outcome
  }

  while (Date.now() < deadline) {
    if (manager.getSessionKind(target.sessionId) !== target.kind) {
      throw new Error(options.exitedMessage)
    }
    if (fileBacked && transcriptPath !== null && !decodePending) {
      const token = await transcriptChangeToken(transcriptPath)
      if (token === null) {
        transcriptPath = null
        decodePending = true
      } else if (token !== lastToken) {
        decodePending = true
      }
    }
    if (decodePending && Date.now() - lastDecodeEndedAt >= MIN_DECODE_INTERVAL_MS) {
      const outcome = await decodeOnce()
      if (outcome) return outcome.value
    }
    await delay(COMPACTION_POLL_MS)
  }
  // A change observed inside the last cooldown window still gets its decode.
  // Without this, a provider that finished writing in the final second would
  // fail the switch AFTER its history was irreversibly compacted — the one
  // outcome the whole wait exists to avoid.
  if (decodePending) {
    const outcome = await decodeOnce()
    if (outcome) return outcome.value
  }
  throw new Error(options.timeoutMessage(lastReadError))
}

async function transcriptChangeToken(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return null
  }
}

// Decode the source and hand back only what `select` derives from it. The
// document is reachable solely from this frame, which has returned by the
// time any caller suspends on a timer — that is the whole point (see #720).
async function readSourceAs<T>(
  source: SourceAdapter,
  sourceCwd: string,
  providerSessionId: string,
  select: (conversation: ConversationDocument) => T,
): Promise<T> {
  return select(await source.read(sourceCwd, providerSessionId))
}

// Same contract as readSourceAs for a path the poll already located, so the
// repeated decodes skip the provider's file lookup entirely.
async function readSourceAtAs<T>(
  source: SourceAdapter,
  path: string,
  select: (conversation: ConversationDocument) => T,
): Promise<T> {
  if (!source.readAt) {
    throw new Error(`Provider ${source.provider} does not expose path-based transcript reads.`)
  }
  return select(await source.readAt(path))
}

// The highest transcript line any decoded entry came from, or -1 for an empty
// conversation. Exported because it is the baseline every "did something land
// AFTER we asked for it" check compares against — the portable handoff waits
// and, since #820, the api_error hazard check — and those callers must all
// derive it the same way or they will disagree about what "after" means.
export function latestSourceLine(conversation: ConversationDocument): number {
  return conversation.entries.reduce(
    (latest, entry) => Math.max(latest, entry.source.line),
    -1,
  )
}
