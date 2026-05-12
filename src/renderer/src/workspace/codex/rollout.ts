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

// Codex injects two synthetic user messages on the first turn of
// every conversation, both meant for the model and not the human:
//
//   1. The AGENTS.md preamble — the project's AGENTS.md content
//      wrapped in a header line "# AGENTS.md instructions for <abs path>".
//   2. The <environment_context> shim — cwd / shell / timezone / date
//      metadata for the model.
//
// These ride on the rollout as regular `role: "user"` messages with
// `input_text` content blocks, so the normal mapper would turn them
// into user bubbles in the feed. Drop at the mapper so they never
// enter runtime.entries at all; downstream surfaces (visibleDecisions,
// debug logs, copy-assistant picker) don't have to know about them.
//
// Wire shape today (verified from a recent rollout, 2026-04-29):
// the bootstrap arrives as a SINGLE response_item carrying BOTH
// blocks at once (AGENTS.md preamble first, then environment_context).
// An older Codex version emitted env_context as its own one-block
// message, so we still need to handle the single-block case too.
// The check below ("every block is a bootstrap block") covers both.
//
// Both predicates are permissive prefix matches: leading whitespace
// is tolerated, and we anchor on a marker that's extremely unlikely
// to appear at the very start of a real user prompt. A user prompt
// that quotes either string somewhere in the middle won't match.
function isCodexEnvironmentContextText(text: string): boolean {
  return /^\s*<environment_context\b/.test(text)
}

function isCodexAgentsMdPreambleText(text: string): boolean {
  return /^\s*# AGENTS\.md instructions for /.test(text)
}

function isCodexBootstrapBlockText(text: string): boolean {
  return isCodexEnvironmentContextText(text) || isCodexAgentsMdPreambleText(text)
}

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
  // Extend the block filter so it keeps both `input_text` /
  // `output_text` (which store their payload under `.text`) and
  // `refusal` (which stores it under `.refusal` — see
  // packages/codex-headless/src/transcript/TranscriptTypes.ts:108
  // for the protocol shape). The old filter only accepted `.text`,
  // so committed refusals silently dropped from the feed even
  // though the live semantic renderer painted them.
  const content = Array.isArray(payload.content)
    ? payload.content
        .map(block => {
          const item = block as Record<string, unknown>
          if (item.type === 'input_text' || item.type === 'output_text') {
            const text = typeof item.text === 'string' ? item.text : null
            return text ? { type: 'text' as const, text } : null
          }
          if (item.type === 'refusal') {
            const refusal = typeof item.refusal === 'string' ? item.refusal : null
            return refusal
              ? { type: 'text' as const, text: `(refused) ${refusal}` }
              : null
          }
          return null
        })
        .filter((block): block is { type: 'text'; text: string } => block !== null)
    : []

  if (content.length === 0) return null

  // Bootstrap shim filter. Drops the synthetic first-turn user
  // messages Codex injects (AGENTS.md preamble + <environment_context>;
  // see the predicate comments above). The check requires EVERY block
  // to be bootstrap-shaped so a real user prompt that happens to
  // quote either marker still passes through with the user's content
  // intact — only messages whose entire content is bootstrap noise
  // get dropped.
  if (
    role === 'user' &&
    content.every(block => isCodexBootstrapBlockText(block.text))
  ) {
    return null
  }

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
 * an Agent Code-local extension to the shared `Entry` type via cast —
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

  // Codex response_item kinds that used to fall through to `return []`
  // even though `SemanticLiveBlockRow` has explicit live UI for each.
  // Without committed counterparts these blocks vanish the moment the
  // turn seals (the semantic turn unmounts) and are gone entirely on
  // a session reload. Minimum-viable mapping: synthesize Claude-shaped
  // tool_use / tool_result entries so the existing `CodexToolRow` /
  // `CodexToolResultRow` dispatcher paints a row. The headlines may
  // not match the live BlockRow UI exactly (web_search emoji, image
  // generation chip, shell command prefix) — consider a dedicated
  // `CodexSpecialToolRow` in a follow-up — but the block no longer
  // disappears on commit, and the data still round-trips through disk
  // so a reload sees the same row.

  if (payload.type === 'web_search_call') {
    const callId =
      typeof payload.id === 'string' ? payload.id : `web_search:${uuid}`
    const action = asRecord(payload.action)
    const query =
      typeof action?.query === 'string' ? action.query as string : null
    const url =
      typeof action?.url === 'string' ? action.url as string : null
    const kind =
      typeof action?.type === 'string' ? action.type as string : 'search'
    // `description` is the field headlineForTool falls back to when
    // the tool has no `command` / `path` / `arguments`. Pack a
    // human-readable label so CodexToolRow shows something useful.
    const description =
      kind === 'search' && query
        ? `Search: ${query}`
        : kind === 'open_page' && url
          ? `Open: ${url}`
          : kind === 'find_in_page' && url
            ? `Find in: ${url}`
            : 'Web search'
    return [
      codexToolUseEntry(uuid, timestamp, callId, 'web_search', {
        description,
        query,
        url,
        kind,
        status: typeof payload.status === 'string' ? payload.status : null,
      }),
    ]
  }

  if (payload.type === 'image_generation_call') {
    const callId =
      typeof payload.id === 'string' ? payload.id : `image_gen:${uuid}`
    const revisedPrompt =
      typeof payload.revised_prompt === 'string'
        ? payload.revised_prompt as string
        : null
    const status =
      typeof payload.status === 'string' ? payload.status as string : 'unknown'
    return [
      codexToolUseEntry(uuid, timestamp, callId, 'image_generation', {
        description: revisedPrompt
          ? `Image: ${revisedPrompt}`
          : `Image generation (${status})`,
        status,
        revisedPrompt,
      }),
    ]
  }

  if (payload.type === 'local_shell_call' && typeof payload.call_id === 'string') {
    // Local shell items have their argv under `action.command` in the
    // OpenAI protocol. Flatten to a single command string so
    // headlineForTool's `command` branch catches it.
    const action = asRecord(payload.action)
    const cmdArr = Array.isArray(action?.command) ? action!.command : []
    const command = cmdArr
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
    const workdir =
      typeof action?.working_directory === 'string'
        ? action!.working_directory as string
        : null
    const status =
      typeof payload.status === 'string' ? payload.status as string : 'unknown'
    return [
      codexToolUseEntry(uuid, timestamp, payload.call_id, 'local_shell', {
        command: command || '(no command)',
        cwd: workdir,
        status,
      }),
    ]
  }

  if (payload.type === 'tool_search_call') {
    const callId =
      typeof payload.id === 'string' ? payload.id : `tool_search:${uuid}`
    const status =
      typeof payload.status === 'string' ? payload.status as string : 'unknown'
    return [
      codexToolUseEntry(uuid, timestamp, callId, 'tool_search', {
        description: `Tool search (${status})`,
        status,
      }),
    ]
  }

  if (payload.type === 'tool_search_output' && typeof payload.call_id === 'string') {
    const output = codexOutputText(payload.output)
    if (!output.trim()) return []
    return [
      codexToolResultEntry(
        uuid,
        timestamp,
        payload.call_id,
        output,
        false,
        { kind: 'tool_search_output' },
      ),
    ]
  }

  return []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Build the history marker for a Codex rollout entry. The format is
 *  `<timestamp>:<payload.id|call_id|type|entry.type>` — mirrors the
 *  uuid used by mapCodexRolloutToFeedEntries so the older-history
 *  loader and the dedup path see the same identity. */
export function codexHistoryMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}
