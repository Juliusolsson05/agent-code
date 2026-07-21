// See docs/design/provider-switching.md for why Claude can transfer its native
// summary directly while Codex needs a second plaintext handoff turn.
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

const COMPACTION_TIMEOUT_MS = 300_000
const COMPACTION_POLL_MS = 250
const PORTABLE_SUMMARY_PROMPT = [
  'Read only. Do not use tools or modify files.',
  'Write a detailed portable handoff summary of the conversation so another coding agent can continue the work.',
  'Include completed work, decisions, files changed, validation, unresolved failures, and exact next steps.',
  'Return only the handoff summary.',
].join(' ')

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
  const before = await source.read(sourceCwd, request.sourceProviderSessionId)
  let compacted = before
  if (plan.kind === 'requires-compaction') {
    const beforeFingerprint = describeLatestCompaction(before)?.fingerprint ?? null
    const delivery = await manager.deliverPromptToAgent(sourceSessionId, '/compact')
    if (!delivery.ok) {
      throw new Error(`Could not start native ${request.sourceKind} compaction: ${delivery.message}`)
    }

    compacted = await waitForNewCompaction(
      manager,
      request,
      source,
      sourceCwd,
      beforeFingerprint,
    )
  }

  if (request.sourceKind === 'claude') {
    return conversationAfterLatestPortableCompaction(compacted)
  }

  // WHY Codex needs a second, ordinary turn after native /compact: modern
  // Codex persists its replacement history as provider-authenticated encrypted
  // content. That record is useful when Codex resumes itself but deliberately
  // cannot be decoded into Claude's plaintext compact-summary carrier. Asking
  // the now-compacted source session for a read-only handoff lets Codex decrypt
  // and summarize its own memory without Agent Code forging ciphertext.
  const summaryBaselineLine = latestSourceLine(compacted)
  onPortableSummary?.()
  const summaryDelivery = await manager.deliverPromptToAgent(
    sourceSessionId,
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

async function waitForNewCompaction(
  manager: SessionManager,
  request: SwitchProviderRequest,
  source: ReturnType<typeof getHostTranscriptAdapter>,
  sourceCwd: string,
  beforeFingerprint: string | null,
): Promise<ConversationDocument> {
  const sourceSessionId = request.sourceSessionId!
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS
  let lastReadError: unknown = null
  while (Date.now() < deadline) {
    if (manager.getSessionKind(sourceSessionId) !== request.sourceKind) {
      throw new Error('The source agent exited while native compaction was running.')
    }
    try {
      const current = await source.read(sourceCwd, request.sourceProviderSessionId)
      const latest = describeLatestCompaction(current)
      if (
        latest &&
        latest.fingerprint !== beforeFingerprint &&
        latest.availability !== 'incomplete'
      ) {
        return current
      }
      lastReadError = null
    } catch (error) {
      // WHY transient read errors are retried here: providers append JSONL while
      // compaction runs, and the stable-reader intentionally rejects a snapshot
      // caught between bytes. The timeout remains the authoritative failure;
      // surfacing the first transient would turn normal append timing into a
      // failed provider switch after `/compact` was already accepted.
      lastReadError = error
    }
    await delay(COMPACTION_POLL_MS)
  }

  const detail = lastReadError instanceof Error ? ` Last read failed: ${lastReadError.message}` : ''
  throw new Error(
    `Timed out waiting for ${request.sourceKind} to persist a native compaction record.${detail}`,
  )
}

async function waitForPortableCodexSummary(
  manager: SessionManager,
  request: SwitchProviderRequest,
  source: ReturnType<typeof getHostTranscriptAdapter>,
  sourceCwd: string,
  baselineLine: number,
): Promise<ConversationDocument> {
  const sourceSessionId = request.sourceSessionId!
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (manager.getSessionKind(sourceSessionId) !== 'codex') {
      throw new Error('The Codex source agent exited while creating its portable handoff.')
    }
    try {
      const current = await source.read(sourceCwd, request.sourceProviderSessionId)
      const handoff = portableCodexHandoffAfterLine(current, baselineLine)
      if (handoff) {
        return {
          ...current,
          entries: [{
            kind: 'compaction',
            summary: handoff.summary,
            summarySource: 'synthetic',
            timestamp: handoff.message.timestamp,
            source: handoff.message.source,
          }],
        }
      }
    } catch {
      // Same append race as native compaction polling; retry to the deadline.
    }
    await delay(COMPACTION_POLL_MS)
  }
  throw new Error('Timed out waiting for compacted Codex to persist a portable handoff summary.')
}

function latestSourceLine(conversation: ConversationDocument): number {
  return conversation.entries.reduce(
    (latest, entry) => Math.max(latest, entry.source.line),
    -1,
  )
}
