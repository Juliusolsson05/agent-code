import type { ConversationPrompt, ConversationScope } from '@shared/conversations/types.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { RepositoryFamily } from '@main/conversations/family.js'

// Raw, provider-shaped ingredients. No label, no kind, no order: the catalog
// decides those (docs/decomposition/conversations.md §4). An adapter reports
// what its store holds and where it got it from.

export type SourceConversation = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string | null
  gitBranch: string | null
  /** A title the USER chose (Claude customTitle, Codex name that is not a
   *  prefix of the title). */
  customTitle: string | null
  /** A title the PROVIDER generated (Claude aiTitle, OpenCode title). */
  aiTitle: string | null
  /** The first few user texts in document order, raw, wrappers included. */
  userTexts: string[]
  /** The adapter stopped reading the head at its byte bound before any user
   *  text; the conversation is not empty, only unlabelled by prompt. */
  headTruncated?: boolean
  createdAt: number | null
  lastUserActivityAt: number | null
  activitySource: 'history' | 'index' | 'tail' | null
  mtime: number
  promptCount: number | null
  parentNativeId: string | null
  isNativeSubagent: boolean
  isExec: boolean
  originator: string | null
  origin: 'index' | 'scan'
  available: boolean
  file: string | null
}

export type SourceScope = {
  scope: ConversationScope
  family: RepositoryFamily
}

/** How much of a transcript a prompt read may cost. Search asks for a bounded
 *  tail (the newest `need` prompts within `maxBytes`); View Prompts asks for
 *  everything. Sources that read an index ignore both. */
export type PromptReadOptions = {
  need?: number | 'all'
  maxBytes?: number
}

export interface ConversationSource {
  readonly provider: AgentProviderKind
  discover(scope: SourceScope): Promise<SourceConversation[]>
  /** Every user prompt of one conversation, newest first. */
  prompts(nativeId: string, cwd: string, options?: PromptReadOptions): Promise<ConversationPrompt[]>
}
