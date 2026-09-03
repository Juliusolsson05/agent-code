// See docs/design/provider-switching.md for why Claude can transfer its native
// summary directly while Codex needs a second plaintext handoff turn.
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'

import type { ConversationDocument } from 'agent-transcript-parser'
import type { ConversationContextPlan } from 'agent-transcript-parser'
import {
  conversationAfterLatestPortableCompaction,
  describeLatestCompaction,
  portableCodexHandoffAfterLine,
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

  // WHY nothing below keeps a ConversationDocument in a local: this function
  // and its wait loops are suspended on timers for up to five minutes, and V8
  // keeps every live local of a suspended async function alive in its
  // generator object. The 2026-09-03 heap snapshot (issue #720) showed three
  // full copies of an 18k-entry rollout — `before`, `compacted`, and the
  // current poll's document — pinned here for the entire wait, 80% of the main
  // heap. Every read now goes through `readSourceAs`, which decodes, applies a
  // selector, and lets the document die before the caller awaits anything.
  if (plan.kind === 'requires-compaction') {
    const beforeFingerprint = await readSourceAs(
      source,
      sourceCwd,
      request.sourceProviderSessionId,
      conversation => describeLatestCompaction(conversation)?.fingerprint ?? null,
    )
    const delivery = await manager.deliverPromptToAgent(sourceSessionId, '/compact')
    if (!delivery.ok) {
      throw new Error(`Could not start native ${request.sourceKind} compaction: ${delivery.message}`)
    }

    if (request.sourceKind === 'claude') {
      return await waitForNewCompaction(
        manager,
        request,
        source,
        sourceCwd,
        beforeFingerprint,
        conversationAfterLatestPortableCompaction,
      )
    }
    const summaryBaselineLine = await waitForNewCompaction(
      manager,
      request,
      source,
      sourceCwd,
      beforeFingerprint,
      latestSourceLine,
    )
    return await requestPortableCodexHandoff(
      manager,
      request,
      source,
      sourceCwd,
      summaryBaselineLine,
      onPortableSummary,
    )
  }

  // 'requires-portable-handoff': the source already persisted a durable
  // compaction, so no `/compact` is sent; the existing record is the baseline.
  if (request.sourceKind === 'claude') {
    return await readSourceAs(
      source,
      sourceCwd,
      request.sourceProviderSessionId,
      conversationAfterLatestPortableCompaction,
    )
  }
  const summaryBaselineLine = await readSourceAs(
    source,
    sourceCwd,
    request.sourceProviderSessionId,
    latestSourceLine,
  )
  return await requestPortableCodexHandoff(
    manager,
    request,
    source,
    sourceCwd,
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
  request: SwitchProviderRequest,
  source: SourceAdapter,
  sourceCwd: string,
  summaryBaselineLine: number,
  onPortableSummary: (() => void) | undefined,
): Promise<ConversationDocument> {
  onPortableSummary?.()
  const summaryDelivery = await manager.deliverPromptToAgent(
    request.sourceSessionId!,
    PORTABLE_SUMMARY_PROMPT,
  )
  if (!summaryDelivery.ok) {
    throw new Error(`Codex compacted successfully but could not create a portable handoff: ${summaryDelivery.message}`)
  }
  return await waitForPortableCodexSummary(
    manager,
    request,
    source,
    sourceCwd,
    summaryBaselineLine,
  )
}

async function waitForNewCompaction<T>(
  manager: SessionManager,
  request: SwitchProviderRequest,
  source: SourceAdapter,
  sourceCwd: string,
  beforeFingerprint: string | null,
  // WHY the caller chooses what survives: Claude needs the post-compaction
  // document itself (its native summary is the portable carrier), Codex only
  // needs the line number its handoff must land after. Selecting inside the
  // probe keeps the full document out of this generator's saved registers.
  select: (conversation: ConversationDocument) => T,
): Promise<T> {
  return await pollSourceUntil(manager, request, source, sourceCwd, {
    expectedKind: request.sourceKind,
    exitedMessage: 'The source agent exited while native compaction was running.',
    timeoutMessage: lastReadError => {
      // WHY transient read errors are retried rather than surfaced: providers
      // append JSONL while compaction runs, and the stable-reader intentionally
      // rejects a snapshot caught between bytes. The timeout remains the
      // authoritative failure; surfacing the first transient would turn normal
      // append timing into a failed provider switch after `/compact` was
      // already accepted.
      const detail = lastReadError instanceof Error ? ` Last read failed: ${lastReadError.message}` : ''
      return `Timed out waiting for ${request.sourceKind} to persist a native compaction record.${detail}`
    },
  }, conversation => {
    const latest = describeLatestCompaction(conversation)
    if (
      latest &&
      latest.fingerprint !== beforeFingerprint &&
      latest.availability !== 'incomplete'
    ) {
      return { value: select(conversation) }
    }
    return null
  })
}

async function waitForPortableCodexSummary(
  manager: SessionManager,
  request: SwitchProviderRequest,
  source: SourceAdapter,
  sourceCwd: string,
  baselineLine: number,
): Promise<ConversationDocument> {
  return await pollSourceUntil(manager, request, source, sourceCwd, {
    expectedKind: 'codex',
    exitedMessage: 'The Codex source agent exited while creating its portable handoff.',
    timeoutMessage: () => 'Timed out waiting for compacted Codex to persist a portable handoff summary.',
  }, conversation => {
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

type PollOptions = {
  expectedKind: AgentProviderKind
  exitedMessage: string
  timeoutMessage: (lastReadError: unknown) => string
}

// Poll the live source transcript until `probe` accepts a decoded snapshot.
//
// WHY stat() gates the decode: the previous implementation called
// `source.read()` on every 250 ms tick. For Codex that is a walk of the whole
// date-bucketed sessions tree to find the rollout, then a full decode of a
// file that can exceed 100 MB — four times a second, for up to five minutes,
// on the main thread. The transcript only matters when it has grown, and
// `size:mtimeMs` is enough to tell. A stat failure yields a null token, which
// is treated as "unknown, decode again" so a transient fs hiccup degrades to
// the rate-limited path rather than stalling the switch.
//
// The token is sampled BEFORE the decode so an append that lands during the
// decode changes the token relative to `lastToken` and forces a re-check on
// the next tick; sampling afterwards could swallow that write.
async function pollSourceUntil<T>(
  manager: SessionManager,
  request: SwitchProviderRequest,
  source: SourceAdapter,
  sourceCwd: string,
  options: PollOptions,
  probe: (conversation: ConversationDocument) => { value: T } | null,
): Promise<T> {
  const sourceSessionId = request.sourceSessionId!
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS
  // Resolved once per wait — for Codex this is the expensive tree walk that
  // used to run on every tick.
  const transcriptPath = await source.locate(sourceCwd, request.sourceProviderSessionId)
  let lastToken: string | null = null
  let decodePending = true
  let lastDecodeAt = Number.NEGATIVE_INFINITY
  let lastReadError: unknown = null
  while (Date.now() < deadline) {
    if (manager.getSessionKind(sourceSessionId) !== options.expectedKind) {
      throw new Error(options.exitedMessage)
    }
    const token = await transcriptChangeToken(transcriptPath)
    if (token === null || token !== lastToken) decodePending = true
    if (decodePending && Date.now() - lastDecodeAt >= MIN_DECODE_INTERVAL_MS) {
      lastToken = token
      decodePending = false
      lastDecodeAt = Date.now()
      try {
        const outcome = await readSourceAs(
          source,
          sourceCwd,
          request.sourceProviderSessionId,
          probe,
        )
        if (outcome) return outcome.value
        lastReadError = null
      } catch (error) {
        // A failed read says nothing about whether the file settled, so the
        // next cooled tick decodes again even if the token did not move.
        lastReadError = error
        decodePending = true
      }
    }
    await delay(COMPACTION_POLL_MS)
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

function latestSourceLine(conversation: ConversationDocument): number {
  return conversation.entries.reduce(
    (latest, entry) => Math.max(latest, entry.source.line),
    -1,
  )
}
