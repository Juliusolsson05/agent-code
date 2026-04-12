// Codex JSONL "rollout" entry types.
//
// Each line in a codex rollout file is:
//   { "timestamp": "<ISO 8601>", "type": "<discriminator>", "payload": {...} }
//
// The `type` field discriminates the payload shape via the RolloutItem
// enum in codex-rs/protocol/src/protocol.rs:2746-2753:
//
//   session_meta   — first line of every rollout; carries id, cwd, model
//   response_item  — an OpenAI ResponseItem (user msg, assistant msg,
//                    function_call, function_call_output, etc.)
//   compacted      — a context-compaction summary replacing earlier turns
//   turn_context   — per-turn metadata (token counts, timing)
//   event_msg      — UI/lifecycle events (user_message, etc.)
//
// We type these loosely (same philosophy as Claude's transcript.ts)
// because the on-disk format is large and we only render a subset.
// Use the type guards at runtime; don't trust the discriminator alone.
//
// Lives under src/core/types/ so main, renderer, and testbench can all
// import. Pure types + guards — no runtime, no Node, no DOM.

/**
 * One line of a codex rollout JSONL file. The envelope carries a
 * timestamp and a discriminated payload.
 */
export type CodexRolloutLine = {
  timestamp: string
  type: string
  payload: unknown
}

/**
 * The session_meta payload — first line of every rollout. Carries
 * the session UUID, originating cwd, model provider, git info, etc.
 */
export type CodexSessionMeta = {
  id: string           // UUID (ThreadId in Rust)
  timestamp: string
  cwd: string
  originator: string   // "codex"
  cli_version: string
  source: string       // "cli" | "app_server" | etc.
  model_provider?: string
  agent_path?: string
  agent_nickname?: string
  agent_role?: string
  base_instructions?: string
  forked_from_id?: string
  memory_mode?: string
}

/**
 * A response_item payload — an OpenAI ResponseItem carrying a message,
 * function call, or function call output. The `type` field inside the
 * payload (distinct from the envelope's type) discriminates further.
 *
 * Key shapes we render:
 *   { type: "message", role: "user",      content: [{ type: "input_text", text: "..." }] }
 *   { type: "message", role: "assistant", content: [{ type: "output_text", text: "..." }] }
 *   { type: "function_call",              name: "...", arguments: "...", call_id: "..." }
 *   { type: "function_call_output",       call_id: "...", output: "..." }
 */
export type CodexResponseItem = {
  type: string
  id?: string
  role?: string        // "user" | "assistant" | "system"
  name?: string        // function name for function_call
  call_id?: string     // links function_call ↔ function_call_output
  arguments?: string   // JSON string for function_call
  output?: string      // result for function_call_output
  content?: Array<{
    type: string       // "input_text" | "output_text" | "refusal" | etc.
    text?: string
    annotations?: unknown[]
  }>
  status?: string      // "completed" | "in_progress" | "incomplete" | etc.
}

/**
 * An event_msg payload — UI/lifecycle events emitted by codex's
 * event system. The `type` inside payload discriminates:
 *   user_message, agent_message, tool_call, tool_output, error, etc.
 */
export type CodexEventMsg = {
  type: string         // "user_message" | "agent_message" | etc.
  message?: string
  kind?: string        // "plain" | etc.
  text_elements?: unknown[]
  local_images?: unknown[]
}

/**
 * Type guard: is this rollout line a conversation entry we should
 * render in the feed? Returns true for response_item and event_msg
 * which carry the actual conversation content; false for session_meta,
 * compacted, and turn_context which are metadata.
 */
export function isCodexConversationEntry(line: CodexRolloutLine): boolean {
  return line.type === 'response_item' || line.type === 'event_msg'
}
