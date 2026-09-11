import type { ConversationKind } from '@shared/conversations/types.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import type { UnwrappedUserText } from './unwrap.js'

// docs/decomposition/conversations.md §2.2, one rule per line, in priority
// order. The ledger (a fact Agent Code recorded when it spawned the pane)
// outranks the prompt sniff (a guess from the transcript); provider-native
// subagent and exec flags outrank both because they are the provider's own
// classification of the thread.
export function classifyConversation(
  source: SourceConversation,
  ledger: LedgerRow | null,
  first: UnwrappedUserText | null,
): ConversationKind {
  if (source.isNativeSubagent) return 'native-subagent'
  if (source.isExec) return 'exec'
  if (ledger) {
    if (ledger.orchestration) return 'orchestration-child'
  } else if (first?.wrapper === 'orchestration-handoff') {
    return 'orchestration-child'
  }
  if (first?.wrapper === 'projected-handoff' || source.originator === 'agent-transcript-parser') return 'projected'
  if (!first && !source.aiTitle && !source.customTitle && !ledger?.title) return 'empty'
  return 'user'
}
