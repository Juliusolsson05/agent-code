import { randomUUID } from 'node:crypto'

import type { AgentProviderKind } from '@shared/types/providerKind.js'

import { stripLastCodexCyberPolicyStep } from '@main/providerSwitch/codexCyberPolicy.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'

export type StripCodexCyberPolicyRequest = {
  provider: AgentProviderKind
  sourceProviderSessionId: string
  cwd: string
}

export type StripCodexCyberPolicyResult = {
  provider: 'codex'
  newProviderSessionId: string
  newFilePath: string
}

export async function stripCodexCyberPolicy(
  request: StripCodexCyberPolicyRequest,
): Promise<StripCodexCyberPolicyResult> {
  // WHY this rejects before getHostTranscriptAdapter: Claude and OpenCode
  // both have adapters, and a silent no-op or a generic projection of their
  // transcripts would look like success while leaving the Codex block intact
  // on a mis-targeted pane. The command is Codex-shaped because the durable
  // signal is Codex's task_complete.codex_error_info.
  if (request.provider !== 'codex') {
    throw new Error('Remove Cybersecurity Block is a Codex operation.')
  }

  const adapter = getHostTranscriptAdapter(request.provider)
  const conversation = await adapter.read(
    request.cwd,
    request.sourceProviderSessionId,
  )
  const stripped = stripLastCodexCyberPolicyStep(conversation)

  const projection = await adapter.projectNativeResume(stripped, {
    cwd: request.cwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
  })
  const newProviderSessionId = adapter.sessionId(projection.values)

  // Same write-last rule as rewind/duplicate: a missing block or a projector
  // rejection must not leave a half-created Codex rollout on disk.
  const newFilePath = await adapter.write(request.cwd, projection.values)
  return {
    provider: 'codex',
    newProviderSessionId,
    newFilePath,
  }
}
