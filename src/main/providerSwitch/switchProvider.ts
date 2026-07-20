import { randomUUID } from 'node:crypto'

import type { AgentProviderKind } from '@shared/types/providerKind.js'

import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'

export type SwitchProviderRequest = {
  sourceKind: AgentProviderKind
  /**
   * The target is explicit because provider switching is not a binary toggle.
   * The optional fallback exists for one compatibility window with older
   * renderer callers and can only infer the historical Claude/Codex pair.
   */
  targetKind?: AgentProviderKind
  sourceProviderSessionId: string
  cwd: string
  sourceCwd?: string
  targetCwd?: string
}

export type SwitchProviderResult = {
  targetKind: AgentProviderKind
  targetProviderSessionId: string
  targetFilePath: string
}

export async function switchProvider(
  request: SwitchProviderRequest,
): Promise<SwitchProviderResult> {
  const targetKind = request.targetKind ?? inferLegacyTarget(request.sourceKind)
  if (targetKind === request.sourceKind) {
    throw new Error(
      `switchProvider: target kind ${targetKind} equals source kind — nothing to switch`,
    )
  }

  const source = getHostTranscriptAdapter(request.sourceKind)
  const target = getHostTranscriptAdapter(targetKind)
  const sourceCwd = request.sourceCwd ?? request.cwd
  const targetCwd = request.targetCwd ?? request.cwd

  // WHY every switch passes through ConversationDocument: pairwise dispatch
  // made each new provider require translators to every existing provider.
  // Source and target adapters now know only their own formats. All decoding
  // and projection completes before write(), so an unsupported record or
  // failed profile cannot leave a partial target transcript on disk.
  const conversation = await source.read(
    sourceCwd,
    request.sourceProviderSessionId,
  )
  if (!conversation.entries.some(entry => entry.kind !== 'opaque')) {
    throw new Error(
      `switchProvider: ${request.sourceKind} transcript contained no projectable conversation entries`,
    )
  }

  const projection = await target.projectNativeResume(conversation, {
    cwd: targetCwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
  })
  const targetProviderSessionId = target.sessionId(projection.values)
  const targetFilePath = await target.write(targetCwd, projection.values)

  return { targetKind, targetProviderSessionId, targetFilePath }
}

function inferLegacyTarget(source: AgentProviderKind): AgentProviderKind {
  if (source === 'claude') return 'codex'
  if (source === 'codex') return 'claude'
  throw new Error(
    `switchProvider: targetKind is required when switching from provider "${source}"`,
  )
}
