import type { Entry } from '@shared/types/transcript'

import {
  codexAssistantTextEntry,
  codexToolResultEntry,
  codexToolUseEntry,
  codexOutputText,
  isCodexExecWrapperOutput,
  parseCodexJson,
  stripCodexExecWrapper,
} from '@renderer/workspace/codex/entries'

// Codex rollout → feed entry mapping.
//
// The Codex headless emits rollout entries (session_meta /
// response_item / event_msg / turn_context / compacted) that don't
// look anything like Claude transcript entries. This module
// translates them into Claude-shaped `Entry` objects so the rest of
// the app (Feed, Reader, ghost reconciler, history loader) can
// stay provider-agnostic at the Entry layer.
//
// Design rules:
//   1. Never throw. A malformed payload turns into `return []` —
//      the feed degrades gracefully rather than tearing down.
//   2. Uuids are synthesized from `timestamp + stable-id-field` so
//      the same rollout entry always maps to the same uuid. The
//      dedupe in the bulk ingest path uses that identity to avoid
//      re-inserting entries on chunk overlap.
//   3. Codex-specific metadata rides on the `codex` extension of
//      tool_result blocks — the row renderers read `.codex` to
//      light up richer UI, but the generic Claude path ignores it.
//
// Ordering with `stampCodexTurnId`: Codex rollout doesn't put
// `turn_id` on per-item entries — only on `task_started` /
// `turn_started` and `turn_context`. Without tracking it here the
// ghost reconciler has nothing to match Codex assistant-text ghosts
// against (they don't carry `message.id`, don't carry `tool_use_id`).

function codexConversationEntryFromMessageItem(
  uuid: string,
  timestamp: string | undefined,
  payload: Record<string, unknown>,
): Entry | null {
  if (
    payload.type !== 'message' ||
    (payload.role !== 'user' && payload.role !== 'assistant')
  ) {
    return null
  }

  const role = payload.role
  const content = Array.isArray(payload.content)
    ? payload.content
        .map(block => {
          const item = block as Record<string, unknown>
          const text = typeof item.text === 'string' ? item.text : null
          if (!text) return null
          if (item.type === 'input_text' || item.type === 'output_text') {
            return { type: 'text' as const, text }
          }
          return null
        })
        .filter((block): block is { type: 'text'; text: string } => block !== null)
    : []

  if (content.length === 0) return null
  return {
    type: role,
    uuid,
    parentUuid: null,
    timestamp,
    message: { role, content },
  }
}

function codexCompactBoundaryEntry(
  uuid: string,
  payload: Record<string, unknown>,
): Entry {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    uuid,
    compactMetadata: payload,
  }
}

function codexCompactSummaryEntry(
  uuid: string,
  timestamp: string | undefined,
  text: string,
): Entry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  }
}

/**
 * Extract the Codex rollout's per-turn response id from a
 * `turn_context` side-channel entry. Returns null for any other
 * entry type. Call sites that iterate a rollout stream use this to
 * keep a rolling "current turn id" that subsequent `response_item`
 * entries get stamped with via `stampCodexTurnId`.
 *
 * WHY: Codex rollout doesn't put `turn_id` on per-item entries —
 * only on `task_started`/`turn_started` and `turn_context`. Without
 * tracking it here the ghost reconciler in `reconcileUpstream` has
 * nothing to match Codex assistant-text ghosts against (they don't
 * carry `message.id`, don't carry `tool_use_id`).
 */
export function codexTurnIdFromRollout(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'turn_context') return null
  const payload = entry.payload as Record<string, unknown> | undefined
  return typeof payload?.turn_id === 'string' ? (payload.turn_id as string) : null
}

/**
 * Stamp a mapped Codex feed entry with the rollout turn id so the
 * ghost reconciler can supersede by turn id. The field is added as
 * a cc-shell-local extension to the shared `Entry` type via cast —
 * consumers that don't care about it ignore it, and
 * `reconcileUpstream` reads it defensively.
 */
export function stampCodexTurnId(entry: Entry, turnId: string | null): Entry {
  if (turnId === null) return entry
  return { ...entry, codexTurnId: turnId } as Entry
}

export function mapCodexRolloutToFeedEntries(entry: Record<string, unknown>): Entry[] {
  const uuid =
    `${String(entry.timestamp ?? Date.now())}:${String((entry.payload as Record<string, unknown> | undefined)?.id ?? (entry.payload as Record<string, unknown> | undefined)?.call_id ?? (entry.payload as Record<string, unknown> | undefined)?.type ?? entry.type)}`
  const timestamp =
    typeof entry.timestamp === 'string' ? entry.timestamp : undefined

  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.type !== 'string') return []

  if (entry.type === 'event_msg') {
    const atp = entry._atp as { origin?: string; source?: Record<string, unknown> } | undefined
    if (
      payload.type === 'user_message' &&
      atp?.origin === 'claude' &&
      atp.source?.isCompactSummary === true
    ) {
      const sourceMessage = atp.source.message as { content?: unknown } | undefined
      const sourceText =
        typeof sourceMessage?.content === 'string'
          ? sourceMessage.content
          : typeof payload.message === 'string'
            ? payload.message
            : ''
      return sourceText
        ? [codexCompactSummaryEntry(`${uuid}:compact-summary`, timestamp, sourceText)]
        : []
    }

    if (payload.type === 'exec_approval_request') {
      const command = Array.isArray(payload.command)
        ? payload.command.filter((part): part is string => typeof part === 'string')
        : []
      const workdir = typeof payload.workdir === 'string' ? payload.workdir : null
      const summary = [
        'Permission required before Codex can run a command.',
        command.length > 0 ? `Command: ${command.join(' ')}` : null,
        workdir ? `Directory: ${workdir}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
      return summary ? [codexAssistantTextEntry(uuid, timestamp, summary)] : []
    }

    if (
      payload.type === 'exec_command_end' &&
      typeof payload.call_id === 'string'
    ) {
      const output = String(
        payload.aggregated_output ??
        payload.formatted_output ??
        payload.stdout ??
        payload.stderr ??
        '',
      )
      const exitCode =
        typeof payload.exit_code === 'number' ? payload.exit_code : 0
      if (!output.trim() && exitCode === 0) return []
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          output,
          exitCode !== 0 || payload.status === 'failed',
          {
            kind: 'exec_command_end',
            parsedCmd: Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [],
            command: Array.isArray(payload.command) ? payload.command : [],
            cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
            exitCode,
          },
        ),
      ]
    }

    if (
      payload.type === 'patch_apply_end' &&
      typeof payload.call_id === 'string'
    ) {
      const stdout = typeof payload.stdout === 'string' ? payload.stdout : ''
      const stderr = typeof payload.stderr === 'string' ? payload.stderr : ''
      const content = stdout || stderr
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          content,
          payload.success !== true,
          {
            kind: 'patch_apply_end',
            success: payload.success === true,
            changes: payload.changes && typeof payload.changes === 'object'
              ? payload.changes as Record<string, unknown>
              : {},
          },
        ),
      ]
    }

    return []
  }

  if (entry.type === 'compacted') {
    const out: Entry[] = [
      codexCompactBoundaryEntry(`${uuid}:compact-boundary`, payload),
    ]

    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (message) {
      out.push(codexCompactSummaryEntry(`${uuid}:compact-summary`, timestamp, message))
    }

    const replacementHistory = Array.isArray(payload.replacement_history)
      ? payload.replacement_history
      : []
    for (let i = 0; i < replacementHistory.length; i += 1) {
      const item = replacementHistory[i] as Record<string, unknown>
      const mapped = codexConversationEntryFromMessageItem(
        `${uuid}:replacement:${i}`,
        timestamp,
        item,
      )
      if (mapped) out.push(mapped)
    }

    return out
  }

  if (entry.type !== 'response_item') return []

  const conversationEntry = codexConversationEntryFromMessageItem(uuid, timestamp, payload)
  if (conversationEntry) return [conversationEntry]

  if (
    payload.type === 'custom_tool_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    const input =
      typeof payload.input === 'string'
        ? parseCodexJson(payload.input) ?? { raw: payload.input }
        : { raw: '' }
    return [codexToolUseEntry(uuid, timestamp, payload.call_id, payload.name, input)]
  }

  if (
    payload.type === 'function_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    const input =
      typeof payload.arguments === 'string'
        ? parseCodexJson(payload.arguments) ?? { arguments: payload.arguments }
        : { arguments: payload.arguments }
    return [codexToolUseEntry(uuid, timestamp, payload.call_id, payload.name, input)]
  }

  if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
    const output = stripCodexExecWrapper(codexOutputText(payload.output))
    if (!output.trim() || isCodexExecWrapperOutput(codexOutputText(payload.output))) {
      return []
    }
    return [codexToolResultEntry(uuid, timestamp, payload.call_id, output)]
  }

  if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
    const output = codexOutputText(payload.output)
    const parsed = parseCodexJson(output)
    const normalized =
      typeof parsed?.output === 'string' ? parsed.output : output
    const metadata = parsed?.metadata
    const exitCode =
      metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>).exit_code === 'number'
        ? (metadata as Record<string, unknown>).exit_code as number
        : 0
    if (
      typeof normalized === 'string' &&
      normalized.startsWith('Success. Updated the following files:')
    ) {
      return []
    }
    return [
      codexToolResultEntry(
        uuid,
        timestamp,
        payload.call_id,
        normalized,
        exitCode !== 0,
        { kind: 'custom_tool_call_output' },
      ),
    ]
  }

  return []
}

/** Build the history marker for a Codex rollout entry. The format is
 *  `<timestamp>:<payload.id|call_id|type|entry.type>` — mirrors the
 *  uuid used by mapCodexRolloutToFeedEntries so the older-history
 *  loader and the dedup path see the same identity. */
export function codexHistoryMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}
