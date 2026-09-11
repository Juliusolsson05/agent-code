import {
  classifyCodexDocument,
  decodeCodexConversation,
  decodeJsonl,
} from 'agent-transcript-parser'

import { stripLastCodexCyberPolicyStep } from '@main/providerSwitch/codexCyberPolicy.js'

export type CloneCodexCyberPolicyOptions = {
  targetSessionId: string
  now: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventPayload(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.type !== 'event_msg' || !isRecord(value.payload)) return null
  return value.payload
}

function isCleanTaskComplete(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false
  const payload = eventPayload(value)
  return payload?.type === 'task_complete' && !isRecord(payload.error)
}

function lastAssistantText(values: readonly Record<string, unknown>[]): string {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (!value || value.type !== 'response_item' || !isRecord(value.payload)) continue
    if (value.payload.type !== 'message' || value.payload.role !== 'assistant') continue
    const content = value.payload.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(isRecord)
      .filter(item => item.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text as string)
      .join('\n\n')
    if (text) return text
  }
  return ''
}

function rewriteSessionMeta(
  values: Record<string, unknown>[],
  options: CloneCodexCyberPolicyOptions,
): void {
  const meta = values.find(value => value.type === 'session_meta' && isRecord(value.payload))
  if (!meta || !isRecord(meta.payload)) {
    throw new Error('Codex rollout has no session_meta to clone.')
  }
  meta.timestamp = options.now
  meta.payload = {
    ...meta.payload,
    id: options.targetSessionId,
    timestamp: options.now,
  }
}

function ensureCleanTaskComplete(
  values: Record<string, unknown>[],
  now: string,
): void {
  if (isCleanTaskComplete(values.at(-1))) return
  // The source turn ended on a cyber_policy complete. After the last-model-step
  // cut the prefix is mid-turn. Codex would otherwise resume by sampling again
  // against the same tail and re-hit the classifier. A clean complete is the
  // one synthetic record this path is allowed to add.
  values.push({
    timestamp: now,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'cyber-policy-cut',
      last_agent_message: lastAssistantText(values),
    },
  })
}

export function cloneCodexCyberPolicyRollout(
  jsonl: string,
  options: CloneCodexCyberPolicyOptions,
): Record<string, unknown>[] {
  // WHY this copies native JSONL instead of projectNativeResume:
  // the live fork of 01a08846 → 7ef23509 went through the Codex native-resume
  // projector. That path drops opaque records, and decode treats
  // response_item.agent_message plus inter_agent_communication_metadata as
  // opaque. The projector also re-encodes custom_tool_call_output.output from
  // Codex's native array into a JSON string. Same-provider recovery only needs
  // a tail cut, so the bytes Codex already accepted are the source of truth.
  const document = decodeJsonl(jsonl)
  const conversation = decodeCodexConversation(classifyCodexDocument(document).records)
  const stripped = stripLastCodexCyberPolicyStep(conversation)
  const firstDropped = conversation.entries[stripped.entries.length]
  if (!firstDropped) {
    throw new Error('Nothing to remove from this Codex session.')
  }
  const cutLine = firstDropped.source.line
  const values: Record<string, unknown>[] = []
  for (const line of document.lines) {
    if (line.index >= cutLine) break
    if (line.kind !== 'record' || !isRecord(line.value)) continue
    values.push(structuredClone(line.value))
  }
  if (values.length === 0) {
    throw new Error('Nothing remains after removing the cybersecurity block.')
  }
  rewriteSessionMeta(values, options)
  ensureCleanTaskComplete(values, options.now)
  return values
}
