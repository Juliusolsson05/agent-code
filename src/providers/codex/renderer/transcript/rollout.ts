import type { Entry } from '@shared/types/transcript'
import { codexRolloutIdentity } from '@shared/codex/rolloutIdentity'
import { asRecord } from '@shared/lib/asRecord'

import {
  codexAssistantTextEntry,
  codexImageGenerationEntry,
  codexResultContent,
  codexToolResultEntry,
  codexToolUseEntry,
  codexOutputText,
  isCodexExecWrapperOutput,
  parseCodexJson,
  stripCodexExecWrapper,
} from '@providers/codex/renderer/transcript/entries'
import { recognizeImageNode } from '@providers/shared/renderer/protocols/media/imageAttachment'

/** A mapped Codex message block: text, or the provider-neutral image block that
 *  ImageBlockRow already paints. Named because the filter predicate below needs
 *  to narrow to it and an inline union there reads as noise. */
type CodexMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

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
// `turn_started` and `turn_context`. The feed's committed-text keys
// (renderUnits.ts) use it. Ghost reconciliation does NOT: a ghost is keyed
// by the proxy response id, which is not this turn UUID. Ghosts match on
// the item id instead (`stampCodexItemId`, #1231).

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

function isCodexSubagentNotificationText(text: string): boolean {
  return /^\s*<subagent_notification>\s*[\s\S]*<\/subagent_notification>\s*$/.test(text)
}

function isCodexBootstrapBlockText(text: string): boolean {
  return isCodexEnvironmentContextText(text) || isCodexAgentsMdPreambleText(text)
}

function isCodexSyntheticUserBlockText(text: string): boolean {
  return isCodexBootstrapBlockText(text) || isCodexSubagentNotificationText(text)
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function numberField(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key]
  return typeof value === 'number' ? value : null
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
          const item = asRecord(block)
          if (!item) return null
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
          // Attached images. Before this, `input_image` hit the `return null`
          // below and was filtered out, so a user who attached an image to a
          // Codex prompt saw nothing at all — the vanish failure, distinct from
          // the base64-dump failure but living in the same mapper and found by
          // the same census (row 19). Note the shape here has NO `detail`
          // sibling, which is why the recognizer must not require one.
          const image = recognizeImageNode(item)
          if (image) {
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: image.mimeType,
                data: image.data,
              },
            }
          }
          return null
        })
        .filter((block): block is CodexMessageBlock => block !== null)
    : []

  if (content.length === 0) return null

  // Synthetic user-message filter. Codex persists model-context messages as
  // role=user response items: first-turn bootstrap shims and later
  // <subagent_notification> envelopes emitted when a spawned agent completes.
  // They are crucial for Codex resume semantics, but they are not human
  // prompts. Filtering here keeps every downstream surface honest: the feed,
  // visible-decision extraction, debug replay, and history loader all see the
  // same cleaned conversation instead of each renderer hiding its own copy.
  //
  // The check requires EVERY block to be synthetic-shaped so a real user prompt
  // that quotes either marker still survives. Only messages whose whole content
  // is runtime bookkeeping are dropped.
  // An image block can never be runtime bookkeeping — it is content the user
  // attached or a tool produced. Requiring `type === 'text'` here is load-bearing
  // now that images reach this filter: without it an image-only message would
  // take `undefined` down the synthetic-text predicate and get dropped, which
  // would replace the base64-dump bug with the vanish bug for exactly the users
  // who attach an image and nothing else.
  if (
    role === 'user' &&
    content.every(block => block.type === 'text' && isCodexSyntheticUserBlockText(block.text))
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

// WHY no `compactMetadata` (#1289): the boundary used to carry the whole
// `compacted` payload, including `replacement_history` (the retained developer
// instructions, AGENTS.md, earlier user prompts, and an encrypted summary of
// 13–23 KB). That kept a second copy of that text in memory and in every debug
// bundle, and nothing in the app reads a Codex boundary's metadata; its uuid
// already identifies the rollout line. A varying metadata object also made
// each boundary a different rendering shape.
function codexCompactBoundaryEntry(
  uuid: string,
  timestamp: string | undefined,
): Entry {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    uuid,
    // WHY a timestamp (#1289): rendering/model/order.ts sorts timestamp-less
    // rows to the end of their phase, so without it the boundary painted at
    // the bottom of the feed instead of where the compaction happened.
    timestamp,
  }
}

// A committed Codex compaction: a timestamped boundary, then the summary when
// the CLI wrote a readable one (#1289).
//
// WHY `replacement_history` is not mapped here: in the common case it is not
// new conversation. It is the context Codex keeps across the compaction
// (developer instructions, the AGENTS.md block, earlier user prompts, and from
// 0.155 an encrypted `compaction` summary item). Mapped, it repainted prompts
// already in the feed: 17,326 of 20,343 sampled replacement messages
// duplicated an earlier user message.
//
// KNOWN GAP (review a of #1386, follow-up #1393): it is NOT
// always a duplicate. 82 local rollouts (68 sessions) are resumed files that
// START with a `compacted` line, so its retained user prompts are the only
// copy of that earlier conversation in the file. This line-at-a-time mapper
// cannot tell that case apart (a paged older-history load can also start a
// page with a `compacted` line that has predecessors in the previous page),
// so the fix belongs where the loader knows it is mapping from file offset 0.
// Before #1386 no `compacted` line rendered at all, so this is not a
// regression. WHY the summary is conditional: `message` is empty in every
// 0.15x rollout, where the summary is encrypted; only 56 of about 1,500 local
// compactions (older CLIs) carry readable text.
function mapCodexCompacted(
  uuid: string,
  timestamp: string | undefined,
  payload: Record<string, unknown>,
): Entry[] {
  const out: Entry[] = [codexCompactBoundaryEntry(`${uuid}:compact-boundary`, timestamp)]
  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  if (message) out.push(codexCompactSummaryEntry(`${uuid}:compact-summary`, timestamp, message))
  return out
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
 * Extract the Codex rollout's per-turn id (a UUID, NOT the proxy response
 * id) from a `turn_context` side-channel entry. Returns null for any other
 * entry type. Call sites that iterate a rollout stream use this to
 * keep a rolling "current turn id" that subsequent `response_item`
 * entries get stamped with via `stampCodexTurnId`.
 *
 * WHY: Codex rollout doesn't put `turn_id` on per-item entries —
 * only on `task_started`/`turn_started` and `turn_context`. The feed's
 * committed-text keys use it. It is NOT the id a Codex ghost is keyed by
 * (that is the proxy response id), so `reconcileUpstream` matches ghosts
 * by item id instead (#1231).
 */
export function codexTurnIdFromRollout(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'turn_context') return null
  return stringField(asRecord(entry.payload), 'turn_id')
}

/**
 * Stamp a mapped Codex feed entry with the rollout turn id. Its consumer is
 * the feed's committed-text ownership keys (features/feed/ui/semantic/
 * renderUnits.ts). The ghost reconciler does NOT use it: a ghost is keyed by
 * the proxy response id, never this turn UUID, so ghosts match on
 * `codexItemId` instead (`stampCodexItemId`, #1231). The field is an Agent
 * Code-local extension to the shared `Entry` type via cast; consumers that
 * don't care about it ignore it.
 */
export function stampCodexTurnId(entry: Entry, turnId: string | null): Entry {
  if (turnId === null) return entry
  return { ...entry, codexTurnId: turnId } as Entry
}

/**
 * Stamp mapped Codex feed entries with the provider ITEM id (`msg_…`, `rs_…`,
 * `fc_…`, `ctc_…`) of the rollout `response_item` they came from.
 *
 * WHY (#1231): this is the one id the live stream and the rollout share. A
 * Codex ghost is keyed by the proxy response id (`resp_…`), while the rollout
 * knows each item's id and its turn UUID, never the response id. So no
 * committed entry could supersede a Codex text ghost, and every one orphaned.
 * The proxy adapter already carries the same item id on the live block
 * (`SemanticLiveBlock.itemId`); `reconcileUpstream` matches on it. It was
 * verified on six real 0.157.1 sessions: every `msg_…` id on the proxy stream
 * appears verbatim in the rollout. An Agent Code-local field like
 * `codexTurnId`; consumers that don't care ignore it.
 */
export function stampCodexItemId(entry: Entry, itemId: string | null): Entry {
  if (itemId === null) return entry
  return { ...entry, codexItemId: itemId } as Entry
}

export function mapCodexRolloutToFeedEntries(entry: Record<string, unknown>): Entry[] {
  const mapped = mapCodexRolloutToFeedEntriesUnstamped(entry)
  if (entry.type !== 'response_item' || mapped.length === 0) return mapped
  const itemId = stringField(asRecord(entry.payload), 'id')
  return itemId === null ? mapped : mapped.map(mappedEntry => stampCodexItemId(mappedEntry, itemId))
}

function mapCodexRolloutToFeedEntriesUnstamped(entry: Record<string, unknown>): Entry[] {
  const payload = asRecord(entry.payload)
  // Shared with the marker below and main's history loader (#1288): the old
  // `ts:id|call_id|type` rule collided for a call and its output, and for
  // id-less items, and admission silently dropped the second.
  const uuid = codexRolloutIdentity(entry)
  const timestamp =
    typeof entry.timestamp === 'string' ? entry.timestamp : undefined

  // WHY before the payload.type guard (#1289): a `compacted` line's payload
  // has no `type` (every one of about 1,500 local lines), so that guard
  // returned [] for all of them and Codex compaction never rendered.
  if (entry.type === 'compacted' && payload) return mapCodexCompacted(uuid, timestamp, payload)

  if (!payload || typeof payload.type !== 'string') return []

  if (entry.type === 'event_msg') {
    const atp = asRecord(entry._atp)
    const atpSource = asRecord(atp?.source)
    if (
      payload.type === 'user_message' &&
      atp?.origin === 'claude' &&
      atpSource?.isCompactSummary === true
    ) {
      const sourceMessage = asRecord(atpSource.message)
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
      // WHY an empty successful result must survive normalization: stdout is
      // not the lifecycle signal. Commands such as `true`, `mkdir`, and
      // `touch` legitimately finish without printing anything, while the
      // correlated `exec_command_end` is the only durable proof that lets a
      // replay distinguish that success from an invocation interrupted before
      // its result was persisted. The provider renderer absorbs this empty
      // result after it has updated the command card, so retaining terminal
      // evidence does not reintroduce a blank standalone row.
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
            changes: asRecord(payload.changes) ?? {},
          },
        ),
      ]
    }

    return []
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
    // Same treatment as custom_tool_call_output: images short-circuit to
    // structured content. `view_image` lands here (census rows 4/8 also occur on
    // this payload type), and the wrapper-stripping below is a text operation
    // that would have nothing to strip from a block array anyway.
    const structured = codexResultContent(payload.output)
    if (typeof structured !== 'string') {
      return [codexToolResultEntry(uuid, timestamp, payload.call_id, structured)]
    }
    const output = stripCodexExecWrapper(structured)
    if (!output.trim() || isCodexExecWrapperOutput(structured)) {
      return []
    }
    return [codexToolResultEntry(uuid, timestamp, payload.call_id, output)]
  }

  if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
    // THE reported bug's path. Codex's `exec` tool returns its result here, and
    // when the script emitted images the output array is
    // text(header), text(path), image, text(path), image — interleaved, with the
    // text parts labelling the images. Structured content is built FIRST so the
    // payload never becomes a string; the JSON-envelope unwrapping below only
    // applies to the plain-text form, which is the only form that can carry one.
    const structured = codexResultContent(payload.output)
    if (typeof structured !== 'string') {
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          structured,
          false,
          { kind: 'custom_tool_call_output' },
        ),
      ]
    }

    const parsed = parseCodexJson(structured)
    const normalized =
      typeof parsed?.output === 'string' ? parsed.output : structured
    const metadata = parsed?.metadata
    const exitCode = numberField(asRecord(metadata), 'exit_code') ?? 0
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
    // WHY semantic and committed web rows intentionally remain independently
    // visible: live Codex identifiers (`ws_*`) and our synthesized fallback id
    // do not form a proven join key. Visual convergence is safe; absorption is
    // not, because a guessed match could hide a distinct search. TODO(web-identity):
    // fold the pair only when the provider emits one durable identity across
    // both planes or ATP records an explicit provenance edge.
    const callId =
      typeof payload.id === 'string' ? payload.id : `web_search:${uuid}`
    const action = asRecord(payload.action)
    const query =
      stringField(action, 'query')
    const url =
      stringField(action, 'url')
    const pattern =
      stringField(action, 'pattern')
    const kind =
      stringField(action, 'type') ?? 'search'
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
        pattern,
        kind,
        status: typeof payload.status === 'string' ? payload.status : null,
      }),
    ]
  }

  if (payload.type === 'image_generation_call') {
    const callId =
      typeof payload.id === 'string' ? payload.id : `image_gen:${uuid}`
    const revisedPrompt =
      stringField(payload, 'revised_prompt')
    const status =
      stringField(payload, 'status') ?? 'unknown'
    const result = stringField(payload, 'result')
    return [
      codexImageGenerationEntry(uuid, timestamp, callId, {
        description: revisedPrompt
          ? `Image: ${revisedPrompt}`
          : `Image generation (${status})`,
        status,
        revisedPrompt,
      }, result),
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
      stringField(action, 'working_directory')
    const status =
      stringField(payload, 'status') ?? 'unknown'
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
      stringField(payload, 'status') ?? 'unknown'
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

/** The history marker for a Codex rollout entry: the same identity as the
 *  entry uuid, from the one shared rule (see codexRolloutIdentity), so the
 *  older-history loader and the dedupe path cannot disagree. */
export function codexHistoryMarker(entry: Record<string, unknown>): string {
  return codexRolloutIdentity(entry)
}
