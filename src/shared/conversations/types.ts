import type { AgentProviderKind } from '@shared/types/providerKind.js'

// One past conversation as every picker must display it. Derived once in main
// by src/main/conversations/catalog; the renderer only consumes it. See
// docs/decomposition/conversations.md §2 for why each field exists.

export type ConversationKind =
  | 'user'
  | 'orchestration-child'
  | 'native-subagent'
  | 'exec'
  | 'projected'
  | 'empty'

/** Which rung of the label ladder produced `label`, best → worst. The two
 *  last rungs are stand-ins and a row must mark them visually (#701). */
export type ConversationLabelSource =
  | 'agent-code-title'
  | 'provider-name'
  | 'ai-title'
  | 'first-prompt'
  | 'cwd'
  | 'native-id'

export type ConversationScope = 'cwd' | 'repository' | 'everywhere'

/** Where `lastUserActivityAt` came from. `mtime` is the last resort and a
 *  test can assert it was never the primary key for an indexed provider. */
export type ConversationActivitySource = 'history' | 'index' | 'tail' | 'mtime'

export type ConversationMatch = {
  field: 'label' | 'name' | 'prompt'
  text: string
  start: number
  end: number
}

export type Conversation = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string
  repoRoot: string | null
  /** Basename of the worktree directory when `cwd` is not the repo root. */
  worktree: string | null
  gitBranch: string | null
  kind: ConversationKind
  parentNativeId: string | null
  label: string
  labelSource: ConversationLabelSource
  firstPrompt: string | null
  /** Spoken Agent Code name, only for conversations that ran here (ledger). */
  agentName: string | null
  agentCodeTitle: string | null
  createdAt: number | null
  lastUserActivityAt: number
  activitySource: ConversationActivitySource
  promptCount: number | null
  /** False when the index knows the conversation but its file is gone. */
  available: boolean
  origin: 'index' | 'scan'
  match: ConversationMatch | null
}

export type ConversationListRequest = {
  cwd: string
  scope: ConversationScope
  providers?: AgentProviderKind[]
  includeChildren?: boolean
  query?: string
  cursor?: string | null
  limit?: number
}

export type ConversationListResponse = {
  rows: Conversation[]
  /** Rows in scope after the provider filter, before the children filter and paging. */
  total: number
  hiddenChildren: number
  nextCursor: string | null
  family: { repoRoot: string | null; roots: string[] }
  timing: { ms: number }
}

export type ConversationPromptsRequest = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string
}

export type ConversationPrompt = {
  text: string
  timestamp: number | null
}

export type ConversationChildrenRequest = {
  provider: AgentProviderKind
  nativeId: string
  cwd: string
}

export function conversationKey(provider: AgentProviderKind, nativeId: string): string {
  return `${provider}:${nativeId}`
}
