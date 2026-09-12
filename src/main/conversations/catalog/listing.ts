import type { Conversation, ConversationListRequest, ConversationListResponse } from '@shared/conversations/types.js'
import { conversationKey } from '@shared/conversations/types.js'
import type { RepositoryFamily } from '../family.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import { normalizeConversation } from './normalize.js'
import { compareByActivity, decodeCursor, encodeCursor } from './order.js'
import { matchConversation } from './search.js'

// The one pure entry point of the catalog. Sources in, ordered explained
// rows out. No I/O here: the service gathers sources and prompts.

export const DEFAULT_PAGE = 50
// WHY 5,000: the picker pages by 60, but the external nativeHistory catalog
// and the tests ask for whole repositories at once, and a repository family
// on the author's machine holds 1,400 rows. Rows are small; the cap exists
// to bound a runaway request, not to force paging on honest callers.
export const MAX_PAGE = 5000
export const HIDDEN_KINDS: ReadonlySet<string> = new Set(['orchestration-child', 'native-subagent', 'exec', 'empty'])

export type BuildListingInput = {
  sources: readonly SourceConversation[]
  ledger: ReadonlyMap<string, LedgerRow>
  family: RepositoryFamily
  request: ConversationListRequest
  promptsFor?: (row: Conversation) => readonly string[]
  startedAt: number
}

export function buildListing(input: BuildListingInput): ConversationListResponse {
  const { request, family } = input
  const providers = request.providers && request.providers.length > 0 ? new Set(request.providers) : null
  const rows: Conversation[] = []
  const seen = new Set<string>()
  for (const source of input.sources) {
    if (providers && !providers.has(source.provider)) continue
    const key = conversationKey(source.provider, source.nativeId)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(normalizeConversation(source, input.ledger.get(key) ?? null, family))
  }
  const total = rows.length
  let visible = request.includeChildren ? rows : rows.filter(r => !HIDDEN_KINDS.has(r.kind))
  const hiddenChildren = total - visible.length
  const queryLower = request.query?.trim().toLowerCase() ?? ''
  if (queryLower) {
    visible = visible.flatMap(row => {
      const match = matchConversation(row, input.promptsFor?.(row) ?? [], queryLower)
      return match ? [{ ...row, match }] : []
    })
  }
  visible.sort(compareByActivity)
  const limit = Math.max(1, Math.min(MAX_PAGE, request.limit ?? DEFAULT_PAGE))
  let start = 0
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor)
    if (cursor) {
      const index = visible.findIndex(r => r.lastUserActivityAt === cursor.at && conversationKey(r.provider, r.nativeId) === cursor.key)
      start = index >= 0 ? index + 1 : visible.findIndex(r => r.lastUserActivityAt < cursor.at)
      if (start < 0) start = visible.length
    }
  }
  const page = visible.slice(start, start + limit)
  const last = page[page.length - 1]
  return {
    rows: page,
    total,
    hiddenChildren,
    nextCursor: start + limit < visible.length && last ? encodeCursor(last) : null,
    family: { repoRoot: family.root, roots: family.roots },
    timing: { ms: Math.max(0, Date.now() - input.startedAt) },
  }
}
