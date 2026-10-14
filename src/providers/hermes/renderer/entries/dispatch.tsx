import type { ProviderDurableEntryDecision, ProviderDurableEntryInput } from '@shared/types/providerConfig'

import { classifyHermesDurableEntry } from '@providers/hermes/renderer/entries/classify'

/** How a Hermes notice reads wherever the coding feed renders a Hermes transcript. */
export function renderHermesDurableEntry(input: ProviderDurableEntryInput): ProviderDurableEntryDecision | undefined {
  if (classifyHermesDurableEntry(input.entry) !== 'provider-notice') return undefined
  const raw = (input.entry as unknown as { text?: unknown }).text
  const text = typeof raw === 'string' ? raw : ''
  return {
    action: 'render',
    node: <pre className="mx-3 my-1 whitespace-pre-wrap break-words font-code text-[11px] text-muted">{text}</pre>,
    receipt: { rendererId: 'hermes.notice' },
  }
}
