import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { AgentProviderKind } from '@shared/types/providerKind.js'

import { cloneCodexCyberPolicyRollout } from '@main/providerSwitch/cloneCodexCyberPolicyRollout.js'
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
  if (!adapter.locate) {
    throw new Error('Codex transcript adapter cannot locate the source rollout.')
  }
  const sourcePath = await adapter.locate(request.cwd, request.sourceProviderSessionId)
  const jsonl = await readFile(sourcePath, 'utf8')
  const values = cloneCodexCyberPolicyRollout(jsonl, {
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
  })
  const newProviderSessionId = adapter.sessionId(values)

  // Write last: a missing block or a cut that leaves nothing must not create
  // a half-written Codex rollout. The source file is never touched.
  const newFilePath = await adapter.write(request.cwd, values)
  return {
    provider: 'codex',
    newProviderSessionId,
    newFilePath,
  }
}
