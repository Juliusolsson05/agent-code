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
// HISTORICAL: this file used to export named payload types
// (CodexSessionMeta, CodexResponseItem, CodexEventMsg) and a guard
// (isCodexConversationEntry). They had zero importers in the renderer
// or main — code that touches a rollout line either narrows the
// `payload: unknown` inline at the call site or treats it as
// `Record<string, unknown>` and probes for the fields it needs. The
// named types went stale relative to those call sites, so we deleted
// them rather than keep two parallel shapes that drifted apart. If a
// caller ever needs strongly-typed payloads again, derive them at the
// consumer.
//
// We type the envelope loosely (same philosophy as Claude's
// transcript.ts) because the on-disk format is large and we only
// render a subset. Use the type guards at runtime; don't trust the
// discriminator alone.
//
// Lives under src/core/types/ so main, renderer, and testbench can all
// import. Pure types — no runtime, no Node, no DOM.

/**
 * One line of a codex rollout JSONL file. The envelope carries a
 * timestamp and a discriminated payload.
 */
export type CodexRolloutLine = {
  timestamp: string
  type: string
  payload: unknown
}
