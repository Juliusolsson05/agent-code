import type { ConversationLabelSource } from '@shared/conversations/types.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import type { UnwrappedUserText } from './unwrap.js'

// The ladder (docs/decomposition/conversations.md §2.3). One order for every
// provider; `labelSource` is what lets a row mark a stand-in as a stand-in and
// lets a test assert the rung, which a flattened string never could (#701).
//
// WHY 120 characters: long prompts are pasted walls of text often enough that
// an untruncated label blows out every row; the conversation itself is one
// click away in the preview.
const LABEL_MAX_CHARS = 120
const ID_LABEL_CHARS = 8

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= LABEL_MAX_CHARS ? collapsed : collapsed.slice(0, LABEL_MAX_CHARS).trimEnd() + '…'
}

export function resolveLabel(
  source: SourceConversation,
  ledger: LedgerRow | null,
  first: UnwrappedUserText | null,
  cwdBasename: string | null,
): { label: string; labelSource: ConversationLabelSource } {
  const agentCodeTitle = ledger?.title?.trim()
  if (agentCodeTitle) return { label: clip(agentCodeTitle), labelSource: 'agent-code-title' }
  const providerName = source.customTitle?.trim()
  if (providerName) return { label: clip(providerName), labelSource: 'provider-name' }
  const aiTitle = source.aiTitle?.trim()
  if (aiTitle) return { label: clip(aiTitle), labelSource: 'ai-title' }
  if (first?.text) return { label: clip(first.text), labelSource: 'first-prompt' }
  if (cwdBasename) return { label: cwdBasename, labelSource: 'cwd' }
  return { label: source.nativeId.slice(0, ID_LABEL_CHARS), labelSource: 'native-id' }
}
