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

/**
 * A conversation whose transcript or store EXISTS but cannot be read (#1306).
 * Sources used to answer `[]` for it, so View Prompts said "no prompts" for a
 * damaged file. The rule every source follows:
 *   - no file (yet): `[]`. A freshly started session has no transcript, and
 *     View Prompts then shows the live feed's prompts; that is not a failure;
 *   - a file or store that is there but unreadable: throw this.
 * Search catches it per conversation (label-only search for that row); View
 * Prompts surfaces it. The cause stays on the error for the main-side log; the
 * message is fixed, because it crosses IPC to the UI (q22).
 */
export class ConversationPromptsUnreadable extends Error {
  constructor(readonly provider: string, readonly cause: unknown) {
    super('The conversation file could not be read')
    this.name = 'ConversationPromptsUnreadable'
  }
}

/** True for the "no such file" family: a missing transcript is not a failure. */
export function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export interface ConversationSource {
  readonly provider: AgentProviderKind
  discover(scope: SourceScope): Promise<SourceConversation[]>
  /** Every user prompt of one conversation, newest first. */
  prompts(nativeId: string, cwd: string, options?: PromptReadOptions): Promise<ConversationPrompt[]>
}
