import type { ProviderOperationDecision, ProviderOperationInput } from '@shared/types/providerConfig'

// Antigravity feed tool rows: fallback-only for now. The generic rows present
// agy's tool calls (name, input) and results honestly; specialized rows (edit
// diffs, shell output) land here one evidence-backed tool at a time, once real
// captures exist in the render-shape catalog (shapes.ts).
export function renderAntigravityOperation(input: ProviderOperationInput): ProviderOperationDecision {
  return {
    toolUse: { action: 'fallback' },
    toolResult: input.result ? { action: 'fallback' } : null,
  }
}
