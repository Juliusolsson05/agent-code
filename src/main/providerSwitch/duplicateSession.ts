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
  if (!conversation.entries.some(entry => entry.kind !== 'opaque')) {
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
