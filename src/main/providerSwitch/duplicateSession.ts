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
  // #1038: a duplicate and a rewind are the SAME conversation continuing, so
  // it keeps the model it ran on. Without this the projector stamped the
  // machine's current default on every message, silently moving the copy to
  // whatever model the user last picked somewhere else. A provider SWITCH is
  // different and still takes the destination's default: there is no source
  // model to inherit across providers.
  // Promise.resolve wraps the OPTIONAL call: an adapter without
  // sourceProfile (Claude, Codex) returns undefined, and `.catch` on
  // undefined throws — which would turn a missing capability into a failed
  // duplicate. A failing export is not fatal either; the projector then
  // resolves its own target profile.
  const sourceProfile = await Promise.resolve(adapter.sourceProfile?.(sourceCwd, request.sourceProviderSessionId)).catch(() => null)
  const projection = await adapter.projectNativeResume(conversation, {
    cwd: targetCwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
    ...(sourceProfile ? { targetProfile: sourceProfile } : {}),
  })
  const newProviderSessionId = adapter.sessionId(projection)
  const newFilePath = await adapter.write(targetCwd, projection)
  return { provider: request.provider, newProviderSessionId, newFilePath }
}
