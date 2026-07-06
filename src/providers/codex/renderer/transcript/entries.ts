import type { Entry } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

// Codex rollout primitives + conversion helpers.
//
// The bulk jsonl-entries ingest path needs to tell Codex rollout
// entries apart from Claude transcript entries (routed differently
// into the Feed), extract the providerSessionId when one lands, and
// synthesize Entry objects from rollout payloads that Claude-shaped
// consumers downstream can process uniformly. The factories here
// produce Claude-shaped Entry objects whose content blocks carry
// a `codex` extension object with the rollout-specific metadata —
// the renderer's row components know when to read `.codex` and fall
// back gracefully when absent.

/** A rollout-style entry (vs a Claude transcript entry). Used at the
 *  start of every ingest loop to dispatch between the two shapes. */
export function isCodexRolloutEntry(entry: Record<string, unknown>): boolean {
  const type = entry.type
  return (
    type === 'session_meta' ||
    type === 'response_item' ||
    type === 'event_msg' ||
    type === 'turn_context' ||
    type === 'compacted'
  )
}

/** `session_meta` carries the rollout's Codex providerSessionId in
 *  `payload.id`. Used by the workspace-state capture pass so the
 *  session's providerSessionId can be persisted and used to resume
 *  on next launch. Other entry types don't carry this. */
export function extractCodexProviderSessionId(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'session_meta') return null
  const payload = entry.payload as Record<string, unknown> | undefined
  return typeof payload?.id === 'string' ? payload.id : null
}

/** Tag optimistic user entries we added client-side so the rollout
 *  reconciler can drop them when the real rollout user message lands.
 *  The prefix lives inside the uuid so even a hot-swap to a different
 *  entries array doesn't confuse the check. */
export function isOptimisticCodexUserEntry(entry: Entry | undefined): boolean {
  if (!entry || entry.type !== 'user') return false
  return typeof entry.uuid === 'string' && entry.uuid.startsWith('optimistic-codex-user:')
}

/** Parse a Codex-emitted JSON payload safely. Returns null on any
 *  failure — callers treat null as "couldn't parse, fall back to raw
 *  text" rather than throwing. */
export function parseCodexJson(input: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(input))
  } catch {
    return null
  }
}

/** Flatten Codex's `output` payload into a single string. Handles
 *  strings, arrays of strings, and arrays of typed blocks (the
 *  latter is what `custom_tool_call_output` tends to produce). */
export function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map(item => {
        if (typeof item === 'string') return item
        const rec = item as Record<string, unknown>
        return typeof rec.text === 'string' ? rec.text : JSON.stringify(item, null, 2)
      })
      .join('\n')
  }
  return JSON.stringify(output ?? '', null, 2)
}

/** Codex's `exec_command_end` wraps its output in a "Chunk ID: …\nOutput:\n<real output>"
 *  envelope. The user never wants to see that wrapper — strip it. */
export function stripCodexExecWrapper(output: string): string {
  const marker = '\nOutput:\n'
  const idx = output.indexOf(marker)
  if (!output.startsWith('Chunk ID:') || idx === -1) return output
  return output.slice(idx + marker.length)
}

/** True when the output is ONLY the exec wrapper with a trailing
 *  "Process exited with code …" line and nothing else — i.e. no
 *  stdout/stderr worth surfacing. Callers filter these out so the
 *  feed doesn't get cluttered with empty tool-result rows. */
export function isCodexExecWrapperOutput(output: string): boolean {
  return output.startsWith('Chunk ID:') && output.includes('\nProcess exited with code ')
}

/** Build a Claude-shaped assistant Entry containing a single
 *  tool_use block. The `id` / `name` / `input` match Claude's
 *  tool-use contract so downstream row renderers don't need a
 *  Codex-specific branch. */
export function codexToolUseEntry(
  uuid: string,
  timestamp: string | undefined,
  id: string,
  name: string,
  input: unknown,
): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name,
          input,
        },
      ],
    },
  }
}

/** Synthesize a Claude-shaped assistant Entry from a single text
 *  string. Used for rollout events that surface advisory text with
 *  no tool context (exec_approval_request narrative, etc.). */
export function codexAssistantTextEntry(
  uuid: string,
  timestamp: string | undefined,
  text: string,
): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

/** Build a Claude-shaped tool_result Entry. The `codex` extension
 *  on the tool_result block carries rollout-specific metadata
 *  (exec exit code, patch success, parsed command) so the Codex
 *  custom row renderers can light up richer UI than Claude's
 *  generic tool-result card. */
export function codexToolResultEntry(
  uuid: string,
  timestamp: string | undefined,
  toolUseId: string,
  content: string,
  isError = false,
  codex?: Record<string, unknown>,
): Entry {
  const resultBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    codex,
  }

  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'user',
      content: [resultBlock],
    },
  }
}
