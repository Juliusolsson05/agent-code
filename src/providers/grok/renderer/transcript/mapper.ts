// Grok transcript-entry mapper — the counterpart of the OpenCode mapper,
// fed one GrokDurableEntry per jsonl-entry event ({sessionId, item, raw,
// generation, lineStartOffset, inRewriteSnapshot} from grok-code-headless).
//
// One durable row fans out into Claude-shaped feed entries, the same split
// Claude uses on the wire:
//   user(genuine)      -> user ConversationEntry (text blocks)
//   user(synthetic)    -> NO entry (native's own insertions: reminders,
//                         plan-mode instructions, interrupted-turn markers —
//                         the same policy as OpenCode's synthetic text filter;
//                         isSyntheticUserItem is the codec's own classifier)
//   assistant          -> assistant ConversationEntry: text block from its
//                         string content + one tool_use block per tool_call
//                         (arguments JSON parsed; a non-JSON string is passed
//                         through as the input object the renderer shows raw)
//   tool_result        -> a SEPARATE user entry with a tool_result block, so
//                         the generic ghost reconciler threads by tool_use_id
//                         with no grok-specific branch
//   reasoning          -> its own assistant entry with a thinking block
//                         (native stores reasoning as an ordered SIBLING row
//                         preceding its assistant item, never inside it)
//   system,            -> NO v1 feed row: the feed has no system row, and
//   backend_tool_call     backend calls are opaque Responses-API items whose
//                         inner shape varies per tool — add one evidence-backed
//                         representation at a time, not speculatively.
//
// WHY uuids derive from (generation, lineStartOffset): a rewrite re-delivers
// the same rows at the same offsets within a generation, so re-delivery maps to
// the SAME uuids and the ledger's dedup works instead of duplicating rows.
//
// The mapper is STATELESS (rows self-describe), so getTurnCursor/setTurnCursor
// are no-ops like the OpenCode mapper's.

import type {
  MappedTranscriptEntry,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'
import type { ContentBlock, Entry } from '@shared/types/transcript'
import type { GrokAssistantItem, GrokToolCall, GrokToolResultItem, GrokUserItem, GrokReasoningItem } from 'grok-code-headless'

export function createGrokTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      return mapGrokEntryToFeedEntries(raw)
    },
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

/**
 * Map one committed grok durable entry into Claude-shaped feed entries.
 * Exported for direct unit testing of the fan-out/filtering logic.
 */
export function mapGrokEntryToFeedEntries(
  raw: Record<string, unknown>,
): MappedTranscriptEntry {
  const item = raw.item as Record<string, unknown> | undefined
  // The identity-only envelope the runtime emits at start ({sessionID}) maps
  // to no row, exactly like the OpenCode identity envelope.
  // The identity envelope is not a row and carries no paging marker either.
  if (!item || typeof item.type !== 'string') return { entries: [], historyMarker: null }

  const uuid = uuidOf(raw)
  const marker = historyMarkerOf(raw)
  switch (item.type) {
    case 'user':
      return { entries: userEntries(item as unknown as GrokUserItem, uuid), historyMarker: marker }
    case 'assistant':
      return { entries: [assistantEntry(item as unknown as GrokAssistantItem, uuid)], historyMarker: marker }
    case 'tool_result':
      return { entries: [toolResultEntry(item as unknown as GrokToolResultItem, uuid)], historyMarker: marker }
    case 'reasoning':
      return { entries: reasoningEntry(item as unknown as GrokReasoningItem, uuid), historyMarker: marker }
    default:
      // system, backend_tool_call — see the header for why these have no row.
      return { entries: [], historyMarker: marker }
  }
}

function userEntries(item: GrokUserItem, uuid: string): Entry[] {
  // Synthetic rows (reminders, interrupts, plan-mode instructions) are native's
  // own insertions, not words the user typed; dropping them here keeps View
  // Prompts and Dispatch titles honest (the codec's classifier is the owner).
  if (item.synthetic_reason != null) return []
  const content: ContentBlock[] = []
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      content.push({ type: 'text', text: part.text })
    }
    // Images: the feed's durable rows carry text today; the live channel owns
    // attachment presentation. Adding durable image blocks is a deliberate
    // later step once a capture proves the renderer path.
  }
  if (content.length === 0) return []
  return [{
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: undefined,
    message: { role: 'user', content },
  }]
}

function assistantEntry(item: GrokAssistantItem, uuid: string): Entry {
  const content: ContentBlock[] = []
  // An assistant row whose content is only whitespace can still carry tool
  // calls (command-error's first assistant row is its tool call); emit text
  // only when there is text.
  if (item.content.trim().length > 0) content.push({ type: 'text', text: item.content })
  for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call) })
  }
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: undefined,
    message: { role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] },
  }
}

function toolResultEntry(item: GrokToolResultItem, uuid: string): Entry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: undefined,
    // WHY is_error is always false: grok's durable rows carry no error flag —
    // a failed MCP call is visible on the call's status in live events, and
    // the durable result text carries whatever native wrote. Claiming error
    // from heuristics would invent a signal the row does not own.
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.tool_call_id, content: item.content, is_error: false }] },
  }
}

function reasoningEntry(item: GrokReasoningItem, uuid: string): Entry[] {
  const text = (Array.isArray(item.summary) ? item.summary : [])
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
  if (text.length === 0) return []
  return [{
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: undefined,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
  }]
}

/** Grok tool calls carry Responses-API `arguments` as a JSON string. */
function parseArguments(call: GrokToolCall): unknown {
  if (typeof call.arguments !== 'string' || call.arguments.length === 0) return {}
  try {
    return JSON.parse(call.arguments) as unknown
  } catch {
    // A non-JSON arguments string is unusual but not ours to fix; hand the
    // renderer the raw string rather than dropping the call's input.
    return call.arguments
  }
}

/** Stable across rewrite re-delivery: same generation, same byte offsets. */
function uuidOf(raw: Record<string, unknown>): string {
  return `grok:${raw.generation}:${raw.lineStartOffset}`
}

function historyMarkerOf(raw: Record<string, unknown>): string {
  return `${raw.generation}:${raw.lineStartOffset}`
}

/**
 * Is this text-bearing grok user row a prompt the user typed? Always —
 * synthetic rows were already dropped by the mapper, and grok has neither
 * Claude's permissionMode stamp nor Codex's context blocks. Same argument as
 * the OpenCode classifier.
 */
export function isGrokTypedUserPrompt(): boolean {
  return true
}

export function extractGrokProviderSessionId(
  raw: Record<string, unknown>,
): string | null {
  // The identity-only envelope the runtime emits at start carries sessionID;
  // every durable entry carries sessionId.
  const identity = raw.sessionID
  if (typeof identity === 'string' && identity.length > 0) return identity
  const sessionId = raw.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
}
