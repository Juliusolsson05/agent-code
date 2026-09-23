import type { ProviderOperationDecision, ProviderOperationInput } from '@shared/types/providerConfig'

// Pi feed tool rows: fallback-only, by evidence. The Stage 0 corpus records
// Pi's built-in tool call shapes (read {path,offset?,limit?}, bash
// {command,timeout?}, edit {path, edits[]}, write {path,content}) but no
// renderer capture of them, and a Pi pane shows pi's own TUI anyway; the
// generic rows present the plain payloads honestly in Reader Mode.
// Specialized rows land here one evidence-backed tool at a time.
export function renderPiOperation(input: ProviderOperationInput): ProviderOperationDecision {
  return {
    toolUse: { action: 'fallback' },
    toolResult: input.result ? { action: 'fallback' } : null,
  }
}
