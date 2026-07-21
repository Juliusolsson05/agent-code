import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'

import type { ConversationDocument } from 'agent-transcript-parser'

import type { SessionManager } from '@main/sessionManager.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import type { SwitchProviderRequest } from '@main/providerSwitch/switchProvider.js'

const COMPACTION_TIMEOUT_MS = 180_000
const COMPACTION_POLL_MS = 250

export async function compactSourceBeforeSwitch(
  manager: SessionManager,
  request: SwitchProviderRequest,
): Promise<void> {
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
  const beforeFingerprint = latestCompactionFingerprint(before)
  const delivery = await manager.deliverPromptToAgent(sourceSessionId, '/compact')
  if (!delivery.ok) {
    throw new Error(`Could not start native ${request.sourceKind} compaction: ${delivery.message}`)
  }

  const deadline = Date.now() + COMPACTION_TIMEOUT_MS
  let lastReadError: unknown = null
  while (Date.now() < deadline) {
    if (manager.getSessionKind(sourceSessionId) !== request.sourceKind) {
      throw new Error('The source agent exited while native compaction was running.')
    }
    try {
      const current = await source.read(sourceCwd, request.sourceProviderSessionId)
      const fingerprint = latestCompactionFingerprint(current)
      if (fingerprint && fingerprint !== beforeFingerprint) return
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
    `Timed out waiting for ${request.sourceKind} to persist a native compaction summary.${detail}`,
  )
}

function latestCompactionFingerprint(conversation: ConversationDocument): string | null {
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    const entry = conversation.entries[index]
    if (entry?.kind === 'compaction' && entry.summary.trim().length > 0) {
      return `${entry.source.line}:${entry.summary}`
    }
  }
  return null
}
