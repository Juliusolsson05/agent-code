import type { SessionRuntime } from '@renderer/workspace/workspaceState'

// The prompt_suggestion semantic event is deliberately kept OUT of
// foldSemanticEvent (it is not a turn and must never enter history — that
// is the #174 leak we are fixing). This pure helper owns the only state it
// touches: a single ephemeral field on the per-session runtime. Splitting
// it out keeps useIpcSubscriptions thin and makes the behaviour unit-
// testable without booting the IPC layer.
//
// Returns the SAME runtime reference when there is nothing to store (empty/
// whitespace text) so the caller's no-op short-circuit can skip a re-render.
export function applyPromptSuggestionToRuntime(
  runtime: SessionRuntime,
  ev: { text?: unknown; ts?: unknown },
): SessionRuntime {
  const text = typeof ev.text === 'string' ? ev.text.trim() : ''
  if (!text) return runtime
  const receivedAt = typeof ev.ts === 'number' ? ev.ts : 0
  return { ...runtime, promptSuggestion: { text, receivedAt } }
}
