import type { ConversationDocument, ConversationEntry } from 'agent-transcript-parser'

// Codex persists a cybersecurity refusal as a normal turn-complete event, not
// as a dedicated transcript type. Observed on
// rollout-2026-09-09T15-25-21-01a08846-936d-7dd3-a91b-0f933d0d9f29.jsonl:
// the last line is event_msg.task_complete with
// error.codex_error_info === "cyber_policy" and last_agent_message: null.
// The failed sampling request wrote no new response_item. Native resume
// already drops event_msg (opaque) and synthesizes a clean task_complete, so
// Duplicate is not enough — the next API request still resends the last
// successful model step that became the flagged input. The cut below removes
// that last step and nothing earlier in the turn.
//
// See docs/superpowers/plans/2026-09-09-remove-cybersecurity-block.md.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventPayload(entry: ConversationEntry): Record<string, unknown> | null {
  if (entry.kind !== 'opaque') return null
  if (entry.source.raw.type !== 'event_msg') return null
  return isRecord(entry.source.raw.payload) ? entry.source.raw.payload : null
}

function isTaskComplete(entry: ConversationEntry): boolean {
  const payload = eventPayload(entry)
  return payload?.type === 'task_complete' || payload?.type === 'turn_complete'
}

function isCyberPolicyTaskComplete(entry: ConversationEntry): boolean {
  const payload = eventPayload(entry)
  if (!payload || (payload.type !== 'task_complete' && payload.type !== 'turn_complete')) {
    return false
  }
  return isRecord(payload.error) && payload.error.codex_error_info === 'cyber_policy'
}

function lastTaskComplete(entries: readonly ConversationEntry[]): ConversationEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && isTaskComplete(entry)) return entry
  }
  return null
}

export function conversationHasCodexCyberPolicyBlock(
  conversation: ConversationDocument,
): boolean {
  if (conversation.sourceProvider !== 'codex') return false
  const complete = lastTaskComplete(conversation.entries)
  return complete !== null && isCyberPolicyTaskComplete(complete)
}

function isUserLike(entry: ConversationEntry): boolean {
  return entry.kind === 'message' && (entry.role === 'user' || entry.role === 'developer' || entry.role === 'system')
}

function isAssistantLike(entry: ConversationEntry): boolean {
  return entry.kind === 'reasoning' || (entry.kind === 'message' && entry.role === 'assistant')
}

function lastModelStepStart(entries: readonly ConversationEntry[]): number {
  const collectedCallIds = new Set<string>()
  const collectedResultIds = new Set<string>()
  let started = false
  let cutStart = entries.length
  let sawToolResult = false
  let sawToolCall = false
  let sawAssistantOrReasoning = false

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.kind === 'opaque') continue

    if (!started) {
      if (isUserLike(entry) || entry.kind === 'compaction') {
        throw new Error('No model step to remove after the cybersecurity block.')
      }
      started = true
      cutStart = index
      if (entry.kind === 'tool-result') {
        collectedResultIds.add(entry.callId)
        sawToolResult = true
        continue
      }
      if (entry.kind === 'tool-call') {
        collectedCallIds.add(entry.callId)
        sawToolCall = true
        continue
      }
      if (isAssistantLike(entry)) {
        sawAssistantOrReasoning = true
        continue
      }
      throw new Error('No model step to remove after the cybersecurity block.')
    }

    if (entry.kind === 'tool-result') {
      // A previous sequential step's result appears after we have already
      // collected this step's tool-call ids. Parallel results in one step
      // appear before any of their calls in reverse, while collectedCallIds
      // is still empty — those stay in the cut.
      if (sawAssistantOrReasoning && !sawToolCall && !sawToolResult) break
      if (collectedCallIds.size > 0 && !collectedCallIds.has(entry.callId)) break
      collectedResultIds.add(entry.callId)
      sawToolResult = true
      cutStart = index
      continue
    }

    if (entry.kind === 'tool-call') {
      if (
        collectedCallIds.size > 0 &&
        collectedResultIds.size > 0 &&
        !collectedResultIds.has(entry.callId) &&
        !collectedCallIds.has(entry.callId)
      ) {
        break
      }
      collectedCallIds.add(entry.callId)
      sawToolCall = true
      cutStart = index
      continue
    }

    if (isAssistantLike(entry)) {
      sawAssistantOrReasoning = true
      cutStart = index
      continue
    }

    break
  }

  if (!started) {
    throw new Error('No model step to remove after the cybersecurity block.')
  }
  return cutStart
}

export function stripLastCodexCyberPolicyStep(
  conversation: ConversationDocument,
): ConversationDocument {
  if (conversation.sourceProvider !== 'codex') {
    throw new Error('Remove Cybersecurity Block is a Codex operation.')
  }
  if (!conversationHasCodexCyberPolicyBlock(conversation)) {
    throw new Error('No cybersecurity block at the end of this Codex session.')
  }

  const cutStart = lastModelStepStart(conversation.entries)
  const entries = conversation.entries.slice(0, cutStart)
  if (!entries.some(entry => entry.kind !== 'opaque')) {
    throw new Error('Nothing remains after removing the cybersecurity block.')
  }
  return { ...conversation, entries }
}
