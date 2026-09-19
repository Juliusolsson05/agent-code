import type {
  ProviderOperationDecision,
  ProviderOperationInput,
} from '@shared/types/providerConfig'

// Grok feed tool rows.
//
// DELIBERATELY FALLBACK-ONLY at Stage 4, and that is evidence, not omission:
// no grok tool-row capture exists yet (the corpus pins protocol shapes, not
// renderer wire shapes), and the plan forbids inventing specialized rows from
// an unobserved tool list. The generic ToolUseRow/ToolResultRow already
// present grok's plain command/path payloads honestly. Specialized rows (git
// operations, todo checklists, read slabs) land here one evidence-backed tool
// at a time, exactly as the OpenCode dispatch grew its adapters.
export function renderGrokOperation(
  _input: ProviderOperationInput,
): ProviderOperationDecision {
  return {
    toolUse: { action: 'fallback' },
    toolResult: _input.result ? { action: 'fallback' } : null,
  }
}
