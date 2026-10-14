import type { ProviderOperationDecision, ProviderOperationInput } from '@shared/types/providerConfig'

/**
 * Every Hermes tool falls through to the shared generic rows wherever the
 * coding feed renders a Hermes transcript (Reader Mode, the phone). The chat
 * pane draws its own tool chips (features/hermes-chat/ToolChip.tsx). No
 * provider-specific row exists until a recording shows a tool shape worth one.
 */
export function renderHermesOperation(input: ProviderOperationInput): ProviderOperationDecision {
  return {
    toolUse: { action: 'fallback' },
    toolResult: input.result ? { action: 'fallback' } : null,
  }
}
