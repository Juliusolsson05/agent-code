// Codex rollout turn-id reconstruction helpers.
//
// WHY these exist as named extractors and not as `payload?.turn_id`
// expressions inline at each call site:
//
// Codex's `turn_context` lines are the clean source of truth for
// which turn a rollout entry belongs to, but pagination chunks and
// live IPC bursts can start *after* the `turn_context` that defined
// the active turn. Payload-level `turn_id` markers on individual
// rollout entries are therefore load-bearing fallback evidence — the
// only way to tie an `event_msg` to its parent turn when the
// surrounding `turn_context` is out of frame.
//
// Three different consumers do the same `payload?.turn_id` /
// `payload?.type` extraction: initial history, ipc subscriptions,
// and the history-action reducer. Keeping the extractors shared
// here prevents the three from drifting apart on field naming /
// fallback logic / null-handling, which would silently mis-route
// events into the wrong turn (and the user would see ordering bugs
// in the feed for codex resumes / scrollback loads).

export function codexTurnIdFromEventPayload(
  raw: Record<string, unknown>,
): string | null {
  const payload = raw.payload as Record<string, unknown> | undefined
  return typeof payload?.turn_id === 'string' ? payload.turn_id : null
}

export function codexEventType(
  raw: Record<string, unknown>,
): string | null {
  const payload = raw.payload as Record<string, unknown> | undefined
  return typeof payload?.type === 'string' ? payload.type : null
}
