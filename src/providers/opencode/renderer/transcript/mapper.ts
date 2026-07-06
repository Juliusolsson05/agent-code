// OpenCode transcript-entry mapper (#406 step 4). Counterpart of
// @providers/claude/renderer/transcript/mapper.ts and
// @providers/codex/renderer/transcript/mapper.ts — see those headers
// for why the mapper capability exists (it killed the quadruplicated
// per-provider ingest loops).
//
// UNLIKE the Claude and Codex mappers, opencode's is fed whole MESSAGES,
// not per-line rollout events. Each committed `entry` carries one
// opencode message `{ info: { id, role, time }, parts: [...] }` (the
// shape `GET /session/:id/message` returns, republished verbatim by
// OpencodeSession's jsonl-entry translation). One message fans out into
// Claude-shaped feed entries: an assistant/user ConversationEntry whose
// content is the message's text/reasoning/tool_use blocks, plus a
// SEPARATE user tool_result entry per tool part that produced output —
// exactly the assistant(tool_use) → user(tool_result) split Claude uses
// on the wire, so downstream row renderers and the ghost reconciler
// (which thread by tool_use_id) need no opencode-specific branch.
//
// WHY the completed-gate (assistant messages without info.time.completed
// are dropped): the live SSE dispatcher republishes a message to the
// committed channel on EVERY `message.updated` (see EventDispatcher
// handleMessageUpdated) — i.e. repeatedly while an assistant turn is
// still streaming, and those mid-stream payloads often lack parts.
// Committing them to the durable feed would (a) double-render the turn
// the semantic streaming card is already painting live and (b) thrash
// the feed with partial content. The resume replay
// (publishSessionMessages) sends each historical message ONCE, fully
// completed, with parts — that is the path this mapper exists to serve:
// a resumed pane shows its history. User messages are always emitted;
// they are complete the instant they commit.
//
// The mapper is STATELESS (opencode messages self-describe their role
// and id), so getTurnCursor/setTurnCursor are no-ops like Claude's.

import type {
  MappedTranscriptEntry,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'
import type { ContentBlock, Entry } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

export function createOpencodeTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      return mapOpencodeMessageToFeedEntries(raw)
    },
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

/**
 * Map one committed opencode message into Claude-shaped feed entries.
 * Exported for direct unit testing of the fan-out/gating logic.
 */
export function mapOpencodeMessageToFeedEntries(
  raw: Record<string, unknown>,
): MappedTranscriptEntry {
  // The message may be `{info, parts}` (resume replay / message.updated)
  // — fall back to the envelope itself for role/id so a flattened shape
  // still resolves.
  const info = asRecord(raw.info) ?? raw
  const role = str(info.role) ?? str(raw.role)
  if (role !== 'user' && role !== 'assistant') {
    return { entries: [], historyMarker: null }
  }

  const messageId = str(info.id) ?? str(raw.id) ?? str(raw.messageID)
  const time = asRecord(info.time)
  const created = num(time?.created)
  // ConversationEntry.timestamp is an ISO string; opencode stores epoch
  // millis. new Date(number) is deterministic (unlike argless new Date()).
  const timestamp = created != null ? new Date(created).toISOString() : undefined

  // v1 completed-gate — see the file header. `completed` is an epoch-ms
  // stamp opencode sets when the turn finishes; absent means "still
  // streaming", which the semantic card owns.
  const completed = num(time?.completed)
  if (role === 'assistant' && completed == null) {
    // Still emit the id as a pagination marker so history paging can
    // advance past a not-yet-complete turn without stalling.
    return { entries: [], historyMarker: messageId ?? null }
  }

  const parts = Array.isArray(raw.parts)
    ? raw.parts
    : Array.isArray(info.parts)
      ? (info.parts as unknown[])
      : []

  const messageContent: ContentBlock[] = []
  const toolResultEntries: Entry[] = []

  for (const rawPart of parts) {
    const part = asRecord(rawPart)
    if (!part) continue
    const kind = normalizeOpencodePartKind(str(part.type) ?? str(part.kind))

    if (kind === 'text') {
      const text = str(part.text) ?? str(part.content)
      if (text) messageContent.push({ type: 'text', text })
      continue
    }

    if (kind === 'reasoning') {
      const text = str(part.text) ?? str(part.content)
      if (text) messageContent.push({ type: 'thinking', thinking: text })
      continue
    }

    if (kind === 'tool') {
      const state = asRecord(part.state)
      // Prefer callID: opencode's live tool blocks key on it (see
      // EventDispatcher blockId = getString(part, ['callID'])), so
      // matching it keeps the resume entry's tool_use_id aligned with
      // whatever the live semantic path already emitted.
      const callId = str(part.callID) ?? str(part.id) ?? str(part.partID)
      if (!callId) continue
      const toolName = str(part.tool) ?? str(part.name) ?? str(part.toolName) ?? 'tool'
      const input = part.input ?? part.args ?? state?.input

      messageContent.push({ type: 'tool_use', id: callId, name: toolName, input })

      const status = str(part.status) ?? str(state?.status)
      const output = toText(part.output ?? part.result ?? state?.output)
      if (output || status === 'error') {
        toolResultEntries.push(
          opencodeToolResultEntry(
            // Stable, unique per (message, tool call) so resume produces
            // the same uuid every time and never collides with the
            // assistant entry's uuid (= messageId).
            `${messageId ?? 'opencode'}:result:${callId}`,
            timestamp,
            callId,
            output ?? '',
            status === 'error',
          ),
        )
      }
      continue
    }
    // Unhandled part kinds (file, step-start, step-finish, snapshot, …)
    // have no v1 feed representation — the semantic/screen channels
    // surface the live ones. Dropping them here keeps the durable feed
    // to conversation + tool activity, matching Codex's filter policy.
  }

  const entries: Entry[] = []
  if (messageContent.length > 0) {
    entries.push({
      type: role,
      // A message with no id would break resume dedup; fall back to a
      // content-derived key so at least in-chunk uniqueness holds.
      uuid: messageId ?? `opencode:${role}:${created ?? ''}`,
      parentUuid: null,
      timestamp,
      message: { role, content: messageContent },
    })
  }
  entries.push(...toolResultEntries)

  return { entries, historyMarker: messageId ?? null }
}

/** Build a Claude-shaped tool_result Entry (a user-role message with a
 *  single tool_result block), mirroring codexToolResultEntry so the
 *  generic and provider row renderers treat all three providers'
 *  results uniformly. */
function opencodeToolResultEntry(
  uuid: string,
  timestamp: string | undefined,
  toolUseId: string,
  content: string,
  isError: boolean,
): Entry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  }
}

/** Collapse opencode's part-type spellings onto the four block kinds
 *  the feed understands. Mirrors the headless dispatcher's
 *  normalizePartKind so the durable (this) and live (semantic) paths
 *  agree on what counts as text/reasoning/tool. */
function normalizeOpencodePartKind(
  kind: string | undefined,
): 'text' | 'reasoning' | 'tool' | 'unknown' {
  if (kind === 'text' || kind === 'assistant_text') return 'text'
  if (kind === 'reasoning' || kind === 'thinking') return 'reasoning'
  if (kind === 'tool' || kind === 'tool-call' || kind === 'tool_use' || kind === 'tool-invocation') {
    return 'tool'
  }
  return 'unknown'
}

/** Coerce a tool output (string or structured) into display text. Tool
 *  results arrive as either a plain string or an object under
 *  `state.output`; the feed's tool_result block content is `string`. */
function toText(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function extractOpencodeProviderSessionId(
  raw: Record<string, unknown>,
): string | null {
  const info = raw.info
  if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
    const sessionID = (info as Record<string, unknown>).sessionID
    if (typeof sessionID === 'string' && sessionID.length > 0) return sessionID
  }
  // Envelope form: the runtime may attach sessionID at the top level
  // of the committed-entry payload.
  const sessionID = raw.sessionID
  return typeof sessionID === 'string' && sessionID.length > 0 ? sessionID : null
}
