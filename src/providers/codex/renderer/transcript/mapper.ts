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
  // WHY (#1395 review a, P2): one exec_command can have TWO terminal carriers.
  // The wrapped function_call_output is always durable. The exec_command_end
  // event is transient in current Codex, but rust-v0.107.0 through v0.131.0
  // persisted it in extended-history mode (app-server
  // `persist_extended_history`). Both carry the same call_id, and both map to
  // an `exec_command_end` result, so the feed would get two result rows for
  // one card, and the card would take whichever came last. The first carrier
  // wins; the other is dropped. Scoped to this mapper's stream: a history
  // page starts a new mapper, so a pair split across a page boundary is not
  // caught (none in the local corpus, which has no persisted event at all).
  const execTerminalCalls = new Set<string>()
  const keepFirstExecTerminal = (entry: ReturnType<typeof mapCodexRolloutToFeedEntries>[number]): boolean => {
    const callId = execTerminalCallId(entry)
    if (callId === null) return true
    if (execTerminalCalls.has(callId)) return false
    execTerminalCalls.add(callId)
    if (execTerminalCalls.size > EXEC_TERMINAL_MEMORY) {
      execTerminalCalls.delete(execTerminalCalls.values().next().value as string)
    }
    return true
  }
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      const turnContextId = codexTurnIdFromRollout(raw)
      if (turnContextId !== null) turnCursor = turnContextId
      const payloadTurnId = codexTurnIdFromEventPayload(raw)
      if (payloadTurnId !== null) turnCursor = payloadTurnId

      const entries = mapCodexRolloutToFeedEntries(raw)
        .filter(keepFirstExecTerminal)
        .map(entry => stampCodexTurnId(entry, turnCursor))
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
