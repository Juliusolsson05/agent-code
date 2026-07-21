// See docs/design/provider-switching.md for the cross-provider capacity and
// native-compaction invariants coordinated by this transaction.
import { randomUUID } from 'node:crypto'

import type { AgentProviderKind } from '@shared/types/providerKind.js'
import {
  fitConversationToCharacterBudget,
  planConversationContext,
} from 'agent-transcript-parser'
import type {
  ConversationContextPlan,
  ConversationDocument,
} from 'agent-transcript-parser'

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
  compactSource?: (
    request: SwitchProviderRequest,
    plan: Extract<ConversationContextPlan, {
      kind: 'requires-compaction' | 'requires-portable-handoff'
    }>,
  ) => Promise<ConversationDocument | void>
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
  let plan = planConversationContext(
    conversation,
    targetKind,
    targetProfile.budgetCharacters,
  )
  let compactedBeforeSwitch = false
  let truncatedBeforeSwitch = false
  const overflowPolicy = request.overflowPolicy ?? 'compact'

  if (plan.kind === 'requires-compaction' || plan.kind === 'requires-portable-handoff') {
    if (overflowPolicy === 'truncate') {
      if (plan.kind === 'requires-portable-handoff') {
        throw new Error(
          'Provider switch cannot truncate around encrypted Codex compaction; a plaintext handoff is required.',
        )
      }
      const fitted = fitConversationToCharacterBudget(
        plan.conversation,
        targetProfile.budgetCharacters,
      )
      if (fitted.stillExceedsBudget) {
        throw contextOverflowError(
          fitted.estimatedCharactersAfter,
          targetProfile.budgetCharacters,
        )
      }
      conversation = fitted.conversation
      truncatedBeforeSwitch = fitted.truncated
    } else if (overflowPolicy === 'fail') {
      throw contextOverflowError(plan.estimatedCharacters, targetProfile.budgetCharacters)
    } else {
      if (!request.sourceSessionId || !runtime.compactSource) {
        throw new Error(
          'Provider switch requires native compaction, but no live source session is available.',
        )
      }
      const requiresNativeCompaction = plan.kind === 'requires-compaction'
      runtime.onProgress?.(requiresNativeCompaction
        ? {
            sourceSessionId: request.sourceSessionId,
            phase: 'compacting',
            message: `Conversation is too large for ${targetKind}. Compacting before switch…`,
          }
        : {
            sourceSessionId: request.sourceSessionId,
            phase: 'summarizing',
            message: `Creating a portable handoff for ${targetKind}…`,
          })
      const compactedConversation = await runtime.compactSource(request, plan)
      compactedBeforeSwitch = requiresNativeCompaction
      conversation = compactedConversation ?? await source.read(
        sourceCwd,
        request.sourceProviderSessionId,
      )
      plan = planConversationContext(
        conversation,
        targetKind,
        targetProfile.budgetCharacters,
      )
      if (plan.kind === 'requires-compaction' || plan.kind === 'requires-portable-handoff') {
        throw new Error(
          `${request.sourceKind} context preparation completed, but the conversation is still not portable within the ${targetKind} target budget.`,
        )
      }
    }
  }

  if (!truncatedBeforeSwitch) conversation = plan.conversation
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
