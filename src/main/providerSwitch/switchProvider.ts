// See docs/design/provider-switching.md for the cross-provider capacity and
// native-compaction invariants coordinated by this transaction.
import { randomUUID } from 'node:crypto'

import type { AgentProviderKind } from '@shared/types/providerKind.js'
import {
  assessConversationContextBudget,
  fitConversationToCharacterBudget,
} from 'agent-transcript-parser'
import type { ConversationDocument } from 'agent-transcript-parser'

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
  sourceSessionId?: string
  overflowPolicy?: 'compact' | 'fail' | 'truncate'
}

export type SwitchProviderResult = {
  targetKind: AgentProviderKind
  targetProviderSessionId: string
  targetFilePath: string
  compactedBeforeSwitch: boolean
  truncatedBeforeSwitch: boolean
}

export type ProviderSwitchProgress = {
  sourceSessionId: string
  phase: 'compacting' | 'summarizing' | 'projecting'
  message: string
}

export interface SwitchProviderRuntime {
  compactSource?: (request: SwitchProviderRequest) => Promise<ConversationDocument | void>
  onProgress?: (progress: ProviderSwitchProgress) => void
}

export async function switchProvider(
  request: SwitchProviderRequest,
  runtime: SwitchProviderRuntime = {},
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
  let conversation = await source.read(
    sourceCwd,
    request.sourceProviderSessionId,
  )
  if (!conversation.entries.some(entry => entry.kind !== 'opaque')) {
    throw new Error(
      `switchProvider: ${request.sourceKind} transcript contained no projectable conversation entries`,
    )
  }

  const targetProfile = await target.targetProfile()
  let assessment = assessConversationContextBudget(
    conversation,
    targetProfile.budgetCharacters,
  )
  let compactedBeforeSwitch = false
  let truncatedBeforeSwitch = false
  const overflowPolicy = request.overflowPolicy ?? 'compact'

  if (assessment.requiresCompaction) {
    if (overflowPolicy === 'truncate') {
      const fitted = fitConversationToCharacterBudget(
        assessment.conversation,
        targetProfile.budgetCharacters,
      )
      conversation = fitted.conversation
      truncatedBeforeSwitch = fitted.truncated
    } else if (overflowPolicy === 'fail') {
      throw contextOverflowError(assessment.estimatedCharacters, targetProfile.budgetCharacters)
    } else {
      if (!request.sourceSessionId || !runtime.compactSource) {
        throw new Error(
          'Provider switch requires native compaction, but no live source session is available.',
        )
      }
      runtime.onProgress?.({
        sourceSessionId: request.sourceSessionId,
        phase: 'compacting',
        message: `Conversation is too large for ${targetKind}. Compacting before switch…`,
      })
      const compactedConversation = await runtime.compactSource(request)
      compactedBeforeSwitch = true
      conversation = compactedConversation ?? await source.read(
        sourceCwd,
        request.sourceProviderSessionId,
      )
      assessment = assessConversationContextBudget(
        conversation,
        targetProfile.budgetCharacters,
      )
      if (assessment.requiresCompaction) {
        throw new Error(
          `Native ${request.sourceKind} compaction completed, but the remaining context still exceeds the ${targetKind} target budget.`,
        )
      }
    }
  }

  if (!truncatedBeforeSwitch) conversation = assessment.conversation
  if (request.sourceSessionId) {
    runtime.onProgress?.({
      sourceSessionId: request.sourceSessionId,
      phase: 'projecting',
      message: `Preparing ${targetKind} resume…`,
    })
  }
  const projection = await target.projectNativeResume(conversation, {
    cwd: targetCwd,
    targetSessionId: randomUUID(),
    now: new Date().toISOString(),
    targetProfile,
  })
  const targetProviderSessionId = target.sessionId(projection.values)
  const targetFilePath = await target.write(targetCwd, projection.values)

  return {
    targetKind,
    targetProviderSessionId,
    targetFilePath,
    compactedBeforeSwitch,
    truncatedBeforeSwitch,
  }
}

function contextOverflowError(estimated: number, budget: number): Error {
  return new Error(
    `Provider switch requires compaction: estimated context ${estimated} characters exceeds target budget ${budget}.`,
  )
}

function inferLegacyTarget(source: AgentProviderKind): AgentProviderKind {
  if (source === 'claude') return 'codex'
  if (source === 'codex') return 'claude'
  throw new Error(
    `switchProvider: targetKind is required when switching from provider "${source}"`,
  )
}
