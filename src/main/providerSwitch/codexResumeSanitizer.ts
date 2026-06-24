import type { CodexRolloutLine } from 'agent-transcript-parser'
// WHY the shared helper and not a local one (cross-app audit Finding 10):
// resume sanitization decides whether a rollout has unresolved tool calls by
// probing object fields like `payload.type` / `payload.call_id`. An ARRAY is a
// JS object but never a valid Codex payload record, and the shared helper
// rejects arrays whereas the old local copy accepted them. Using one canonical
// helper keeps this sanitizer's "is this a record" decision identical to ATP's
// rewind path — both prepare resume-safe transcripts and must agree on malformed
// input, or provider-switch and rewind could make different safety calls.
import { asRecord } from '@shared/lib/asRecord.js'

export function sanitizeCodexRolloutForResume(
  lines: readonly CodexRolloutLine[],
): CodexRolloutLine[] {
  const resolvedCallIds = collectResolvedCallIds(lines)
  const out: CodexRolloutLine[] = []
  for (const line of lines) {
    if (line.type !== 'response_item') {
      out.push(line)
      continue
    }
    const payload = asRecord(line.payload)
    if (
      payload &&
      isCodexToolCallPayload(payload) &&
      typeof payload.call_id === 'string' &&
      !resolvedCallIds.has(payload.call_id)
    ) {
      // WHY same-provider Codex duplicates need resume sanitization:
      // Codex can persist a tool call response_item before the matching output
      // is appended. Orchestration clones are often taken exactly in that
      // window because the parent is calling `orchestration_create_agent`.
      // Resuming a rollout with a dangling tool call risks replaying malformed
      // history into the child's first prompt. We drop only unresolved calls;
      // completed call/output pairs are kept verbatim.
      continue
    }
    out.push(line)
  }

  while (out.length > 0) {
    const last = out.at(-1)
    if (!last) break
    if (last.type === 'response_item') {
      const payload = asRecord(last.payload)
      if (payload?.type === 'reasoning') {
        out.pop()
        continue
      }
    }
    break
  }

  return out
}

function collectResolvedCallIds(lines: readonly CodexRolloutLine[]): Set<string> {
  const resolved = new Set<string>()
  for (const line of lines) {
    if (line.type !== 'response_item') continue
    const payload = asRecord(line.payload)
    if (
      payload &&
      (payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'tool_search_output') &&
      typeof payload.call_id === 'string'
    ) {
      resolved.add(payload.call_id)
    }
  }
  return resolved
}

function isCodexToolCallPayload(payload: Record<string, unknown>): boolean {
  return (
    payload.type === 'function_call' ||
    payload.type === 'custom_tool_call' ||
    payload.type === 'local_shell_call' ||
    payload.type === 'tool_search_call'
  )
}
