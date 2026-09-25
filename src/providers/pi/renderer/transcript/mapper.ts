// Pi transcript-entry mapper: one Pi session row (pi-terminal-headless
// PiSessionRow, the file's own JSON plus its `line`) per jsonl-entry event, or
// the runtime's identity envelope.
//
// One row fans out into Claude-shaped feed entries, the split every provider
// uses so the generic reconcilers need no Pi branch:
//   message/user        -> user entry (text blocks)
//   message/assistant   -> thinking blocks + text blocks + one tool_use per
//                          toolCall, in Pi's own block order
//   message/toolResult  -> a SEPARATE user entry with a tool_result block,
//                          threaded to its call by toolCallId
//   everything else     -> no row (see below), but still a history marker
//
// Deliberately NO row, and why:
//   system            Pi's prompt + tool loadout (persisted before the first
//                     prompt); the feed has no system row.
//   bashExecution     the user's own `!cmd`. It is not a prompt to the model
//                     typed in a composer, and rendering it as a user message
//                     would put it in View Prompts and Dispatch titles. Its
//                     output stays visible in pi's TUI; a dedicated row can
//                     be added once there is a renderer shape for it.
//   custom*, compaction, branch_summary, model/thinking changes, label,
//   session_info, context_edit, usage — metadata or extension state; the
//                     conversation they affect is already the ACTIVE BRANCH
//                     the package emits.
//
// Images in user content are skipped for now (durable image blocks need a
// renderer path proven by a capture; no Pi image capture exists yet).
//
// Aborted / errored replies: the partial content Pi saved is shown as-is;
// the failure itself reaches the pane as the bridge's api_error semantic event,
// so no invented text is written into the assistant message (it would leak
// into Copy Last Response).
//
// Stateless (rows self-describe; entry ids are unique within a file), so the
// turn-cursor methods are no-ops like OpenCode's and Grok's.

import type { MappedTranscriptEntry, TranscriptEntryMapper } from '@shared/types/providerConfig'
import type { ContentBlock, Entry } from '@shared/types/transcript'

/** The runtime's identity-only envelope (piSession.ts start()). */
export const PI_IDENTITY_ENVELOPE_TYPE = 'agent-code-identity'

type PiBlock = { type?: unknown; text?: unknown; thinking?: unknown; redacted?: unknown; id?: unknown; name?: unknown; arguments?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function createPiTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map: raw => mapPiRowToFeedEntries(raw),
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

export function mapPiRowToFeedEntries(raw: Record<string, unknown>): MappedTranscriptEntry {
  if (raw.type === PI_IDENTITY_ENVELOPE_TYPE || typeof raw.id !== 'string') return { entries: [], historyMarker: null }
  const marker = raw.id
  if (raw.type !== 'message' || !isRecord(raw.message)) return { entries: [], historyMarker: marker }
  const message = raw.message
  const uuid = `pi:${raw.id}`
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : undefined
  switch (message.role) {
    case 'user':
      return { entries: userEntry(message, uuid, timestamp), historyMarker: marker }
    case 'assistant':
      return { entries: assistantEntry(message, uuid, timestamp), historyMarker: marker }
    case 'toolResult':
      return { entries: toolResultEntry(message, uuid, timestamp), historyMarker: marker }
    default:
      return { entries: [], historyMarker: marker }
  }
}

function blocks(content: unknown): PiBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isRecord) as PiBlock[] : []
}

function userEntry(message: Record<string, unknown>, uuid: string, timestamp: string | undefined): Entry[] {
  const content: ContentBlock[] = []
  for (const block of blocks(message.content)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) content.push({ type: 'text', text: block.text })
  }
  if (content.length === 0) return []
  return [{ type: 'user', uuid, parentUuid: null, timestamp, message: { role: 'user', content } }]
}

function assistantEntry(message: Record<string, unknown>, uuid: string, timestamp: string | undefined): Entry[] {
  const content: ContentBlock[] = []
  for (const block of blocks(message.content)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0 && block.redacted !== true) {
      content.push({ type: 'thinking', thinking: block.thinking })
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments ?? {} })
    }
  }
  // An errored reply is saved with `content: []` (Stage 0 `error` recording);
  // it produces no bubble rather than an empty one.
  if (content.length === 0) return []
  return [{
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: { role: 'assistant', content, ...(typeof message.model === 'string' ? { model: message.model } : {}) },
  }]
}

function toolResultEntry(message: Record<string, unknown>, uuid: string, timestamp: string | undefined): Entry[] {
  if (typeof message.toolCallId !== 'string') return []
  const parts = blocks(message.content)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => ({ type: 'text', text: block.text as string }))
  return [{
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: parts, is_error: message.isError === true }] },
  }]
}

/**
 * Every Pi user row that survives the mapper is a prompt somebody typed (or
 * that Agent Code delivered through the bridge, which is the same thing to
 * the conversation): Pi has no synthetic user rows — its own insertions are
 * `custom_message` / `system` rows, which map to nothing.
 */
export function isPiTypedUserPrompt(): boolean {
  return true
}

/** Only the runtime's identity envelope names the session: Pi's rows carry no session id. */
export function extractPiProviderSessionId(raw: Record<string, unknown>): string | null {
  if (raw.type !== PI_IDENTITY_ENVELOPE_TYPE) return null
  return typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null
}
