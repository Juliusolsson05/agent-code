import type {
  ContentBlock,
  ConversationEntry,
  Entry,
} from '@shared/types/transcript'

export type ClaudeQueuedCommand = {
  entry: Entry
  uuid: string
  timestamp: string | null
  mode: 'prompt' | 'task-notification'
  prompt: string | ContentBlock[]
  /** Exact text is queue identity evidence only when Claude persisted a scalar
   * prompt. Block-array prompts carry image parts and must not be flattened
   * into a guessed queue key. */
  promptText: string | null
  originKind: string | null
  originPresent: boolean
  isMeta: boolean
  sourceUuid: string | null
}

function isContentBlockArray(value: unknown): value is ContentBlock[] {
  if (!Array.isArray(value)) return false
  for (const block of value) {
    if (
      typeof block !== 'object' ||
      block === null ||
      typeof (block as { type?: unknown }).type !== 'string'
    ) {
      return false
    }
  }
  return true
}

/**
 * Decode the one durable Claude carrier that bridges queue and transcript.
 *
 * WHY this is a provider adapter rather than checks at each consumer: the same
 * raw attachment drives mapper admission, durable classification, paint, and
 * live queue evidence. Four hand-written checks would inevitably disagree on
 * legacy origin, meta provenance, or block-array support and recreate the
 * exact “present in one plane, invisible in another” failure this fixes.
 *
 * The returned object references the original prompt string/blocks. It does
 * not clone prompt content or retain a process-global cache; queued-command
 * sightings are rare and their owning Entry already participates in the
 * count/byte-bounded live window.
 */
export function decodeClaudeQueuedCommand(entry: Entry): ClaudeQueuedCommand | null {
  if (entry.type !== 'attachment') return null
  const raw = entry as Entry & {
    attachment?: unknown
    isMeta?: unknown
    timestamp?: unknown
  }
  if (typeof raw.uuid !== 'string' || raw.uuid.length === 0) return null
  if (typeof raw.attachment !== 'object' || raw.attachment === null) return null

  const attachment = raw.attachment as Record<string, unknown>
  if (attachment.type !== 'queued_command') return null
  const mode = attachment.commandMode
  if (mode !== 'prompt' && mode !== 'task-notification') return null

  const prompt = attachment.prompt
  if (typeof prompt !== 'string' && !isContentBlockArray(prompt)) return null

  const originPresent = Object.prototype.hasOwnProperty.call(attachment, 'origin')
  const origin = attachment.origin
  const originKind =
    typeof origin === 'object' &&
    origin !== null &&
    typeof (origin as { kind?: unknown }).kind === 'string'
      ? (origin as { kind: string }).kind
      : null

  return {
    entry,
    uuid: raw.uuid,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
    mode,
    prompt,
    promptText: typeof prompt === 'string' ? prompt : null,
    originKind,
    originPresent,
    isMeta: attachment.isMeta === true || raw.isMeta === true,
    sourceUuid:
      typeof attachment.source_uuid === 'string'
        ? attachment.source_uuid
        : null,
  }
}

export function decodeClaudeQueuedUserPrompt(
  entry: Entry,
): ClaudeQueuedCommand | null {
  const command = decodeClaudeQueuedCommand(entry)
  if (!command || command.mode !== 'prompt' || command.isMeta) return null
  // Older Claude versions omitted origin entirely for human prompts. A present
  // but malformed/unknown origin is not equivalent to that recorded legacy
  // shape and must decline rather than accidentally painting automation.
  if (
    command.originPresent &&
    command.originKind !== 'human'
  ) {
    return null
  }
  return command
}

/**
 * Presentation-only conversation view over the durable attachment.
 *
 * WHY a view instead of rewriting the stored Entry: the attachment UUID,
 * timestamp, and raw provider provenance must remain the durable source of
 * truth for replay/debug/queue identity. ConversationRow only needs the common
 * message envelope. This wrapper reuses the original prompt reference and is
 * allocated only when the memoized row actually paints.
 */
export function queuedUserPromptConversationEntry(
  command: ClaudeQueuedCommand,
): ConversationEntry {
  const source = command.entry as Entry & {
    parentUuid?: unknown
    sessionId?: unknown
    gitBranch?: unknown
    cwd?: unknown
    isSidechain?: unknown
  }
  return {
    type: 'user',
    uuid: command.uuid,
    parentUuid:
      typeof source.parentUuid === 'string' || source.parentUuid === null
        ? source.parentUuid
        : null,
    ...(command.timestamp ? { timestamp: command.timestamp } : {}),
    ...(typeof source.sessionId === 'string' ? { sessionId: source.sessionId } : {}),
    ...(typeof source.gitBranch === 'string' ? { gitBranch: source.gitBranch } : {}),
    ...(typeof source.cwd === 'string' ? { cwd: source.cwd } : {}),
    ...(typeof source.isSidechain === 'boolean'
      ? { isSidechain: source.isSidechain }
      : {}),
    message: {
      role: 'user',
      content: command.prompt,
    },
  }
}
