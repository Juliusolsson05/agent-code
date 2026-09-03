import { randomUUID } from 'node:crypto'

import type { AgentProviderKind } from '@shared/types/providerKind.js'

import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'

export type DuplicateSessionRequest = {
  provider: AgentProviderKind
  sourceProviderSessionId: string
  cwd: string
  sourceCwd?: string
  targetCwd?: string
}

export type DuplicateSessionResult = {
  provider: AgentProviderKind
  newProviderSessionId: string
  newFilePath: string
}

export async function duplicateSession(
  request: DuplicateSessionRequest,
): Promise<DuplicateSessionResult> {
  const adapter = getHostTranscriptAdapter(request.provider)
  const sourceCwd = request.sourceCwd ?? request.cwd
  const targetCwd = request.targetCwd ?? request.cwd
  const conversation = await adapter.read(sourceCwd, request.sourceProviderSessionId)
  const hasProjectableEntries = conversation.entries.some(entry => entry.kind !== 'opaque')
  if (!hasProjectableEntries && request.provider !== 'opencode') {
    // WHY OpenCode is the one exception: its supported export/import envelope
    // represents a real blank session, and OpenCode Terminal deliberately
    // pre-creates that durable identity before the first prompt. Consequently
    // Duplicate is legitimately visible on a fresh terminal pane. Claude and
    // Codex only acquire portable native history after a semantic record is
    // written; treating an empty JSONL prefix as a resumable clone would invent
    // a provider file shape neither CLI promises to accept.
    throw new Error(
      `duplicateSession: ${request.provider} transcript contained no projectable conversation entries`,
    )
  }

  // A clone is the complete neutral conversation projected under a fresh
  // target identity. The same adapter supplies source and target behavior, but
  // this orchestration does not need to branch on its provider. Any future
  // provider that registers one adapter receives duplication automatically.
  const projection = await adapter.projectNativeResume(conversation, {
    cwd: targetCwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
  })
  const newProviderSessionId = adapter.sessionId(projection.values)
  const newFilePath = await adapter.write(targetCwd, projection.values)
  return { provider: request.provider, newProviderSessionId, newFilePath }
}
