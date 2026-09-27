// Codex transcript-entry mapper (#394 phase 2b). Counterpart of
// @providers/claude/renderer/transcript/mapper.ts — see that file's
// header for why the mapper capability exists.
//
// The Codex mapper is STATEFUL: rollout lines don't carry their turn
// id individually, so a rolling cursor (updated by turn_context lines
// and event payloads, cleared by terminal events) stamps each mapped
// entry. The exact sequence below is byte-for-byte the logic that was
// previously triplicated in useIpcSubscriptions (live), initialHistory
// (bootstrap) and history (older pagination):
//   1. turn_context rollout id updates the cursor
//   2. event payload turn id updates the cursor
//   3. map + stamp with the CURRENT cursor
//   4. terminal events (task_complete/turn_complete/turn_aborted)
//      clear the cursor AFTER the line itself was stamped
// Order matters: a task_complete event must itself be attributed to
// the turn it completes, and the NEXT line starts unattributed.

import type {
  MappedTranscriptEntry,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'
import {
  codexHistoryMarker,
  codexTurnIdFromRollout,
  mapCodexRetainedUserHistory,
  mapCodexRolloutToFeedEntries,
  stampCodexTurnId,
} from './rollout'
import { codexEventType, codexTurnIdFromEventPayload } from './eventCursor'

// How many exec terminal results a mapper remembers for de-duplication. A
// duplicate carrier sits next to its twin (same turn), so a small window is
// enough, and it keeps a live session's mapper from growing without bound.
const EXEC_TERMINAL_MEMORY = 512

export function createCodexTranscriptEntryMapper(
  initialTurnCursor: string | null = null,
): TranscriptEntryMapper {
  let turnCursor = initialTurnCursor
  // WHY the mapper tracks the file head (#1393): a resumed rollout can START
  // with a `compacted` line whose retained user prompts are the only copy of
  // the earlier conversation in the file (82 local files, 58 sessions with no
  // other rollout). Those prompts must be shown there, and only there:
  // elsewhere they repeat prompts already in the feed (33,443 of 37,724
  // retained user items have an earlier exact match). "At the head" is
  // proved by a `session_meta` line with no conversation record
  // (`response_item`/`event_msg`) since it. `session_meta` is only ever at a
  // file's head (0 of 2,579 local rollouts have one after a conversation
  // record), so a history page that starts mid-file, or a live burst, can
  // never enter this state, whatever its first line is. Pages and previews
  // that DO start at the file head get the prompts, with no loader change.
  let atFileHead = false

  // WHY (#1395 reviews a and b): one exec_command can have TWO terminal
  // carriers. The wrapped function_call_output is always durable. The
  // exec_command_end event is transient in current Codex, but the
  // extended-history policy persisted it through rust-v0.136.0 (0.137.0 is
  // transient again). Both carry the same call_id and both map to an
  // `exec_command_end` result.
  //
  // The WRAPPER wins, because it is the fuller one: the persisted event's
  // aggregated_output is sanitized to 10,000 bytes (rollout policy.rs), while
  // the wrapper keeps the whole model-visible output. The feed's result index
  // is later-wins (buildToolResultIndex), and Codex emits the end event BEFORE
  // the function result (core tools/events.rs ToolEventEmitter::finish), so:
  //  - event first, wrapper later: both are kept, and the wrapper wins the
  //    index (the command card owns and absorbs both result rows);
  //  - wrapper first, event later: the event is dropped here, so a late,
  //    truncated event cannot replace the wrapper.
  // A first version kept whichever came FIRST, which kept the truncated event
  // (review b). The memory is per mapper, and history pages, previews and
  // live bursts each build their own; across such a boundary both results
  // are kept and later-wins decides, which again favours the wrapper in
  // Codex's own emit order. No local rollout (0 of 2,555) has both carriers.
  const wrapperResolvedCalls = new Set<string>()
  const keepExecTerminal = (raw: Record<string, unknown>) => (entry: ReturnType<typeof mapCodexRolloutToFeedEntries>[number]): boolean => {
    const callId = execTerminalCallId(entry)
    if (callId === null) return true
    if (raw.type === 'response_item') {
      wrapperResolvedCalls.add(callId)
      if (wrapperResolvedCalls.size > EXEC_TERMINAL_MEMORY) {
        wrapperResolvedCalls.delete(wrapperResolvedCalls.values().next().value as string)
      }
      return true
    }
    return !wrapperResolvedCalls.has(callId)
  }
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      const turnContextId = codexTurnIdFromRollout(raw)
      if (turnContextId !== null) turnCursor = turnContextId
      const payloadTurnId = codexTurnIdFromEventPayload(raw)
      if (payloadTurnId !== null) turnCursor = payloadTurnId

      if (raw.type === 'session_meta') atFileHead = true
      else if (raw.type === 'response_item' || raw.type === 'event_msg') atFileHead = false
      const retained = atFileHead ? mapCodexRetainedUserHistory(raw) : []

      // Retained prompts are user messages, never exec terminal carriers, so
      // only the record's own entries go through the exec de-duplication.
      const entries = [...retained, ...mapCodexRolloutToFeedEntries(raw).filter(keepExecTerminal(raw))].map(entry =>
        stampCodexTurnId(entry, turnCursor),
      )
      const marker = codexHistoryMarker(raw)

      const eventType = codexEventType(raw)
      if (
        eventType === 'task_complete' ||
        eventType === 'turn_complete' ||
        eventType === 'turn_aborted'
      ) {
        turnCursor = null
      }

      return { entries, historyMarker: marker }
    },
    // The live-ingest site persists the cursor across bursts (it used
    // to live in a module-level Map keyed by sessionId); history /
    // preview sites start each chunk with a null cursor, matching the
    // old local-variable behavior.
    getTurnCursor: () => turnCursor,
    setTurnCursor: (id: string | null) => {
      turnCursor = id
    },
  }
}

/**
 * Pass-A identity capture: Codex's durable session id arrives on the
 * session_meta line's payload.id. Re-exported through the mapper module
 * so the registry capability table imports one file per provider.
 */
export { extractCodexProviderSessionId } from './entries'

/**
 * Is this text-bearing, non-meta Codex user row a prompt the user typed?
 *
 * Codex has no `permissionMode` stamp, but it records its injected context
 * (`<environment_context>`, `<user_instructions>`) as ordinary user
 * messages, and every one of those is a `<`-prefixed block. The entry itself
 * carries nothing else that separates them, hence the unused parameter.
 */
export function isCodexTypedUserPrompt(_entry: unknown, text: string): boolean {
  return !text.startsWith('<')
}

/** The call id of an exec terminal result (either carrier), or null. */
function execTerminalCallId(entry: ReturnType<typeof mapCodexRolloutToFeedEntries>[number]): string | null {
  const content = (entry as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0] as { type?: unknown; tool_use_id?: unknown; codex?: { kind?: unknown } }
  if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return null
  return block.codex?.kind === 'exec_command_end' ? block.tool_use_id : null
}
