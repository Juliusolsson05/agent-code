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

  if (request.sourceKind === 'opencode') {
    // OpenCode's supported storage boundary is `opencode export`; it has no
    // stable transcript path for Agent Code to watch and its slash-command
    // parser lives inside the interactive TUI. Asking for one ordinary,
    // read-only handoff turn works for both the terminal and structured
    // runtimes, then the export's completed timestamp proves durability.
    const summaryBaselineLine = await readSourceAs(
      source,
      sourceCwd,
      request.sourceProviderSessionId,
      latestSourceLine,
    )
    onPortableSummary?.()
    const delivery = await manager.deliverPromptToAgent(sourceSessionId, PORTABLE_SUMMARY_PROMPT)
    if (!delivery.ok) {
      throw new Error(`Could not request OpenCode portable handoff: ${delivery.message}`)
    }
    return await waitForPortableOpencodeSummary(
      manager,
      request,
      source,
      sourceCwd,
      summaryBaselineLine,
    )
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

async function waitForPortableOpencodeSummary(
  manager: SessionManager,
  request: SwitchProviderRequest,
  source: SourceAdapter,
  sourceCwd: string,
  baselineLine: number,
): Promise<ConversationDocument> {
  return await pollSourceUntil(manager, request, source, sourceCwd, {
    expectedKind: 'opencode',
    exitedMessage: 'The OpenCode source agent exited while creating its portable handoff.',
    timeoutMessage: () => 'Timed out waiting for OpenCode to persist a portable handoff summary.',
  }, conversation => {
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
  request: SwitchProviderRequest,
  source: SourceAdapter,
  sourceCwd: string,
  options: PollOptions,
  probe: (conversation: ConversationDocument) => { value: T } | null,
): Promise<T> {
  const sourceSessionId = request.sourceSessionId!
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

  const decodeOnce = async (): Promise<{ value: T } | null> => {
    try {
      if (!fileBacked) {
        const outcome = await readSourceAs(
          source,
          sourceCwd,
          request.sourceProviderSessionId,
          probe,
        )
        lastReadError = null
        // A CLI export has no cheap stat token. Keep it pending so the next
        // cooled tick exports again; MIN_DECODE_INTERVAL_MS still prevents a
        // long session from monopolizing the main process.
        decodePending = true
        return outcome
      }
      if (transcriptPath === null) {
        transcriptPath = await source.locate!(sourceCwd, request.sourceProviderSessionId)
      }
      lastToken = await transcriptChangeToken(transcriptPath)
      const outcome = await readSourceAtAs(source, transcriptPath, probe)
      lastReadError = null
      decodePending = false
      return outcome
    } catch (error) {
      // A failed locate/read says nothing about whether the file settled, so
      // the next cooled tick decodes again even if the token did not move.
      lastReadError = error
      decodePending = true
      return null
    } finally {
      lastDecodeEndedAt = Date.now()
    }
  }

  while (Date.now() < deadline) {
    if (manager.getSessionKind(sourceSessionId) !== options.expectedKind) {
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

function latestSourceLine(conversation: ConversationDocument): number {
  return conversation.entries.reduce(
    (latest, entry) => Math.max(latest, entry.source.line),
    -1,
  )
}
